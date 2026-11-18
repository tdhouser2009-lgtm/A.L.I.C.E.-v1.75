import { createHmac, randomBytes, scrypt as scryptCallback, timingSafeEqual } from "node:crypto";
import { promisify } from "node:util";
import { ErrorCode } from "@assistant/shared";
import { AppError } from "./errors.js";

const scrypt = promisify(scryptCallback) as (password: string, salt: Buffer, keylen: number) => Promise<Buffer>;
const TOKEN_TTL_SECONDS = 15 * 60;
const SESSION_COOKIE = "assistant_session";

export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16);
  const key = await scrypt(password, salt, 64);
  return `scrypt$${salt.toString("base64url")}$${key.toString("base64url")}`;
}

export async function verifyPassword(password: string, encoded: string): Promise<boolean> {
  const [algorithm, saltText, keyText] = encoded.split("$");
  if (algorithm !== "scrypt" || !saltText || !keyText) return false;
  const salt = Buffer.from(saltText, "base64url");
  const expected = Buffer.from(keyText, "base64url");
  if (salt.length !== 16 || expected.length !== 64) return false;
  const actual = await scrypt(password, salt, expected.length);
  return timingSafeEqual(actual, expected);
}

function sign(payload: Record<string, unknown>, secret: string): string {
  const header = Buffer.from(JSON.stringify({ alg: "HS256", typ: "JWT" })).toString("base64url");
  const body = Buffer.from(JSON.stringify(payload)).toString("base64url");
  const data = `${header}.${body}`;
  const signature = createHmac("sha256", secret).update(data).digest("base64url");
  return `${data}.${signature}`;
}

function verify(token: string, secret: string): { sub: string } | null {
  const parts = token.split(".");
  if (parts.length !== 3) return null;
  const [headerPart, bodyPart, signature] = parts;
  const expected = createHmac("sha256", secret).update(`${headerPart}.${bodyPart}`).digest();
  try {
    const received = Buffer.from(signature, "base64url");
    const header = JSON.parse(Buffer.from(headerPart, "base64url").toString("utf8")) as { alg?: string };
    const payload = JSON.parse(Buffer.from(bodyPart, "base64url").toString("utf8")) as { sub?: unknown; exp?: number };
    if (header.alg !== "HS256" || typeof payload.sub !== "string" || !payload.exp || payload.exp <= Date.now() / 1000) return null;
    if (received.length !== expected.length || !timingSafeEqual(received, expected)) return null;
    return { sub: payload.sub };
  } catch {
    return null;
  }
}

export function issueToken(userId: string, secret: string): string {
  const now = Math.floor(Date.now() / 1000);
  return sign({ sub: userId, iat: now, exp: now + TOKEN_TTL_SECONDS }, secret);
}

export function sessionCookie(token: string, secure: boolean): string {
  return `${SESSION_COOKIE}=${token}; Path=/; HttpOnly; SameSite=${secure ? "None" : "Strict"}; Max-Age=${TOKEN_TTL_SECONDS}${secure ? "; Secure" : ""}`;
}

export function clearedSessionCookie(secure: boolean): string {
  return `${SESSION_COOKIE}=; Path=/; HttpOnly; SameSite=${secure ? "None" : "Strict"}; Max-Age=0${secure ? "; Secure" : ""}`;
}

export function authenticate(headers: Record<string, string | string[] | undefined>, secret: string): string {
  const authorization = headers.authorization;
  const bearer = typeof authorization === "string" && authorization.startsWith("Bearer ") ? authorization.slice(7) : undefined;
  const cookie = typeof headers.cookie === "string"
    ? headers.cookie.split(";").map((part) => part.trim()).find((part) => part.startsWith(`${SESSION_COOKIE}=`))?.slice(SESSION_COOKIE.length + 1)
    : undefined;
  const claims = bearer || cookie ? verify((bearer ?? cookie)!, secret) : null;
  if (!claims) throw new AppError(ErrorCode.UNAUTHORIZED, "Authentication is required.", 401);
  return claims.sub;
}

/** Constant-time comparison for shared secrets such as the sync token. */
export function safeEqual(a: string, b: string): boolean {
  const left = createHmac("sha256", "compare").update(a).digest();
  const right = createHmac("sha256", "compare").update(b).digest();
  return timingSafeEqual(left, right) && a.length === b.length;
}
