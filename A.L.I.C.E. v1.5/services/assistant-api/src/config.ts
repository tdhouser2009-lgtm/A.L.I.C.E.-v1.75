import { randomBytes } from "node:crypto";
import { z } from "zod";

const truthy = z
  .string()
  .optional()
  .transform((value) => ["1", "true", "yes", "on"].includes((value ?? "").trim().toLowerCase()));

const EnvironmentSchema = z.object({
  NODE_ENV: z.string().optional(),
  PORT: z.coerce.number().int().min(1).max(65535).default(3000),
  DATABASE_URL: z.string().min(1),
  JWT_SECRET: z.string().min(32).optional(),
  WEB_ORIGIN: z.string().url().optional(),
  MODEL_WORKER_BASE_URL: z.string().url().default("http://model-worker:8081"),
  AZURITE_CONNECTION_STRING: z.string().min(1).optional(),
  AZURE_STORAGE_BLOB_ENDPOINT: z.string().url().optional(),
  KEY_VAULT_URI: z.string().url().optional(),
  // Chat and learning
  CHAT_BACKEND: z.enum(["local", "ollama"]).default("local"),
  OLLAMA_ENABLED: truthy,
  CHAT_HISTORY_TURNS: z.coerce.number().int().min(0).max(50).default(8),
  LEARNING_CHECK_SECONDS: z.coerce.number().int().min(5).max(86_400).default(60),
  // Home Assistant (optional)
  HA_URL: z.string().url().optional(),
  HA_TOKEN: z.string().min(1).optional(),
  HA_AUTO_APPROVE_DOMAINS: z.string().default(""),
  // Sync hub (optional, off by default)
  SYNC_ENABLED: truthy,
  SYNC_TOKEN: z.string().optional(),
  SYNC_OWNER_EMAIL: z.string().email().optional(),
});

type Environment = z.infer<typeof EnvironmentSchema>;

export type AppConfig = Omit<Environment, "WEB_ORIGIN" | "HA_AUTO_APPROVE_DOMAINS"> & {
  WEB_ORIGIN: string;
  jwtSecret: string;
  development: boolean;
  homeAssistant: { url: string; token: string; autoApproveDomains: string[] } | null;
  sync: { token: string; ownerEmail: string } | null;
};

/** `Development`, `development`, `dev`, and `test` all count as local development. */
export function isDevelopment(nodeEnv: string | undefined): boolean {
  return ["development", "dev", "test"].includes((nodeEnv ?? "").trim().toLowerCase());
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env, warn: (message: string) => void = console.warn): AppConfig {
  const parsed = EnvironmentSchema.safeParse(env);
  if (!parsed.success) throw new Error(`Invalid application configuration: ${parsed.error.message}`);
  const data = parsed.data;
  const local = isDevelopment(data.NODE_ENV);
  if (local && !data.AZURITE_CONNECTION_STRING) throw new Error("AZURITE_CONNECTION_STRING is required in development.");
  if (!local && !data.JWT_SECRET) throw new Error("JWT_SECRET is required outside development.");
  if (!local && !data.WEB_ORIGIN) throw new Error("WEB_ORIGIN is required outside development.");
  if (!local && (!data.WEB_ORIGIN?.startsWith("https://") ||
      !data.AZURE_STORAGE_BLOB_ENDPOINT?.startsWith("https://") ||
      !data.KEY_VAULT_URI?.startsWith("https://"))) {
    throw new Error("Production web and Azure service endpoints must use HTTPS.");
  }
  const webOrigin = data.WEB_ORIGIN ?? "http://localhost:5173";
  const parsedOrigin = new URL(webOrigin);
  if (parsedOrigin.pathname !== "/" || parsedOrigin.search || parsedOrigin.hash || parsedOrigin.username || parsedOrigin.password) {
    throw new Error("WEB_ORIGIN must be an origin without a path, query, or credentials.");
  }
  for (const name of ["MODEL_WORKER_BASE_URL", "AZURE_STORAGE_BLOB_ENDPOINT", "KEY_VAULT_URI", "HA_URL"] as const) {
    const value = data[name];
    if (!value) continue;
    const endpoint = new URL(value);
    if (endpoint.username || endpoint.password || endpoint.search || endpoint.hash) {
      throw new Error(`${name} must not contain credentials, a query, or a fragment.`);
    }
  }
  if (data.CHAT_BACKEND === "ollama" && !data.OLLAMA_ENABLED) {
    throw new Error("CHAT_BACKEND=ollama requires OLLAMA_ENABLED=true (the Ollama fallback is off by default).");
  }
  if (Boolean(data.HA_URL) !== Boolean(data.HA_TOKEN)) {
    throw new Error("Set both HA_URL and HA_TOKEN to connect Home Assistant, or neither.");
  }
  if (data.SYNC_ENABLED && (!data.SYNC_TOKEN || data.SYNC_TOKEN.length < 24 || !data.SYNC_OWNER_EMAIL)) {
    throw new Error("SYNC_ENABLED=true requires SYNC_TOKEN (24+ characters) and SYNC_OWNER_EMAIL.");
  }
  let jwtSecret = data.JWT_SECRET;
  if (!jwtSecret) {
    // Never fall back to a hard-coded key: a random per-process key means sessions simply end on restart.
    jwtSecret = randomBytes(48).toString("base64url");
    warn("JWT_SECRET is not set; using a random signing key for this process. Sessions end when the API restarts.");
  }
  const { WEB_ORIGIN: _origin, HA_AUTO_APPROVE_DOMAINS: autoApprove, ...rest } = data;
  return {
    ...rest,
    WEB_ORIGIN: parsedOrigin.origin,
    jwtSecret,
    development: local,
    homeAssistant: data.HA_URL && data.HA_TOKEN
      ? {
          url: data.HA_URL.replace(/\/$/, ""),
          token: data.HA_TOKEN,
          autoApproveDomains: autoApprove.split(",").map((value) => value.trim().toLowerCase()).filter(Boolean),
        }
      : null,
    sync: data.SYNC_ENABLED ? { token: data.SYNC_TOKEN!, ownerEmail: data.SYNC_OWNER_EMAIL!.toLowerCase() } : null,
  };
}
