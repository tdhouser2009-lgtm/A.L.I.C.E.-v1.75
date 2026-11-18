import { randomUUID } from "node:crypto";
import {
  ErrorCode, LoginRequestSchema, RegisterRequestSchema,
  type UserSummary,
} from "@assistant/shared";
import { Database } from "./database.js";
import { AppError } from "./errors.js";
import { hashPassword, issueToken, verifyPassword } from "./security.js";

type Account = { id: string; email: string; display_name: string; password_hash: string };
const DUMMY_PASSWORD_HASH = `scrypt$${Buffer.alloc(16).toString("base64url")}$${Buffer.alloc(64).toString("base64url")}`;

export class AuthService {
  constructor(private readonly db: Database, private readonly jwtSecret: string) {}

  private publicUser(account: Pick<Account, "id" | "email" | "display_name">): UserSummary {
    return { id: account.id, email: account.email, displayName: account.display_name };
  }

  async register(raw: unknown): Promise<{ user: UserSummary; token: string }> {
    const input = RegisterRequestSchema.parse(raw);
    const email = input.email.trim().toLowerCase();
    const hash = await hashPassword(input.password);
    const id = randomUUID();
    try {
      await this.db.transaction(async (client) => {
        await client.query(
          "INSERT INTO users (id, email, display_name, password_hash, created_at) VALUES ($1, $2, $3, $4, now())",
          [id, email, input.displayName, hash],
        );
        await client.query(
          "INSERT INTO audit_records (id, actor_user_id, action, entity_type, entity_id, metadata, created_at) VALUES ($1, $2, 'auth.register', 'user', $3, $4, now())",
          [randomUUID(), id, id, JSON.stringify({})],
        );
      });
    } catch (error) {
      if ((error as { code?: string }).code === "23505") throw new AppError(ErrorCode.CONFLICT, "An account with that email already exists.", 409);
      throw error;
    }
    return { user: { id, email, displayName: input.displayName }, token: issueToken(id, this.jwtSecret) };
  }

  async login(raw: unknown): Promise<{ user: UserSummary; token: string }> {
    const input = LoginRequestSchema.parse(raw);
    const result = await this.db.query<Account>(
      "SELECT id, email, display_name, password_hash FROM users WHERE email = $1",
      [input.email.trim().toLowerCase()],
    );
    const account = result.rows[0];
    const valid = await verifyPassword(input.password, account?.password_hash ?? DUMMY_PASSWORD_HASH);
    if (!valid || !account) throw new AppError(ErrorCode.UNAUTHORIZED, "Email or password is incorrect.", 401);
    await this.db.transaction(async (client) => {
      await client.query("UPDATE users SET last_login_at = now() WHERE id = $1", [account.id]);
      await client.query(
        "INSERT INTO audit_records (id, actor_user_id, action, entity_type, entity_id, metadata, created_at) VALUES ($1, $2, 'auth.login', 'user', $3, $4, now())",
        [randomUUID(), account.id, account.id, JSON.stringify({})],
      );
    });
    return { user: this.publicUser(account), token: issueToken(account.id, this.jwtSecret) };
  }

  async current(userId: string): Promise<UserSummary> {
    const result = await this.db.query<Pick<Account, "id" | "email" | "display_name">>(
      "SELECT id, email, display_name FROM users WHERE id = $1",
      [userId],
    );
    if (!result.rows[0]) throw new AppError(ErrorCode.UNAUTHORIZED, "Session is no longer valid.", 401);
    return this.publicUser(result.rows[0]);
  }

  async logout(userId: string): Promise<void> {
    await this.db.query(
      "INSERT INTO audit_records (id, actor_user_id, action, entity_type, entity_id, metadata, created_at) VALUES ($1, $2, 'auth.logout', 'user', $3, $4, now())",
      [randomUUID(), userId, userId, JSON.stringify({})],
    );
  }
}
