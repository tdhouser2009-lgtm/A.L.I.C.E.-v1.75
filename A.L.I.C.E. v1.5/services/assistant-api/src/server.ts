import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { randomUUID } from "node:crypto";
import {
  ApiSchemas, ConversationIdParamsSchema, DiagnosticParamsSchema, DiagnosticRequestSchema,
  ErrorCode, LogoutRequestSchema, ProposalDecisionRequestSchema, ProposalIdParamsSchema,
  SystemIdParamsSchema,
} from "@assistant/shared";

type DiagnosticOption = { id: string; description: string; timeoutSeconds: number };
import { z, ZodError } from "zod";
import { AuthService } from "./auth-service.js";
import { loadConfig } from "./config.js";
import { Database } from "./database.js";
import { AppError, errorResponse } from "./errors.js";
import { openApi } from "./openapi.js";
import { createProviders } from "./providers.js";
import { authenticate, clearedSessionCookie, sessionCookie } from "./security.js";
import { WorkerClient } from "./worker-client.js";

const config = loadConfig();
const db = new Database(config.DATABASE_URL);
const providers = createProviders(config);
const auth = new AuthService(db, config.jwtSecret);
const worker = new WorkerClient(config.MODEL_WORKER_BASE_URL);
const secureCookie = !config.development;
const diagnosticOptions: DiagnosticOption[] = [
  { id: "disk-service-health", description: "Read the latest recorded service health for an enrolled system.", timeoutSeconds: 5 },
  { id: "dependency-health", description: "Check the API's database dependency with a read-only query.", timeoutSeconds: 5 },
  { id: "storage-availability", description: "Check configured blob storage availability.", timeoutSeconds: 5 },
];
const proposalTemplates = {
  "checkpoint-retention": {
    impact: "Changes a proposed retention setting; no data is changed by approval.",
    summary: (p: Record<string, unknown>) => `Set checkpoint retention to ${p.days} days`,
    validate: (p: Record<string, unknown>) => Object.keys(p).length === 1 && Number.isInteger(p.days) && Number(p.days) >= 1 && Number(p.days) <= 365,
  },
  "cpu-evaluation-batch": {
    impact: "Requests a bounded evaluation batch; approval alone does not start it.",
    summary: (p: Record<string, unknown>) => `Schedule ${p.promptCount} CPU evaluation prompts`,
    validate: (p: Record<string, unknown>) => Object.keys(p).length === 1 && Number.isInteger(p.promptCount) && Number(p.promptCount) >= 1 && Number(p.promptCount) <= 500,
  },
  "desktop-sync-interval": {
    impact: "Proposes a sync interval change; approval alone does not apply it.",
    summary: (p: Record<string, unknown>) => `Set desktop sync interval to ${p.minutes} minutes`,
    validate: (p: Record<string, unknown>) => Object.keys(p).length === 1 && Number.isInteger(p.minutes) && Number(p.minutes) >= 1 && Number(p.minutes) <= 1440,
  },
} as const;
const isApprovedFileId = (id: string) => /^[A-Za-z0-9][A-Za-z0-9._-]{0,119}$/.test(id);

function normalizeHealth(value: string): "healthy" | "degraded" | "unhealthy" | "unknown" {
  return ["healthy", "degraded", "unhealthy"].includes(value) ? value as "healthy" | "degraded" | "unhealthy" : "unknown";
}

function normalizeConnectorStatus(value: string, observedAt: string): "connected" | "stale" | "disconnected" {
  if (!["connected", "stale", "disconnected"].includes(value)) return "disconnected";
  if (value === "connected" && Date.now() - new Date(observedAt).getTime() > 5 * 60_000) return "stale";
  return value as "connected" | "stale" | "disconnected";
}

function send(res: ServerResponse, status: number, value?: unknown, headers: Record<string, string> = {}) {
  res.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", ...headers });
  if (status === 204) res.end();
  else res.end(JSON.stringify(value ?? {}));
}

async function readBody(req: IncomingMessage): Promise<unknown> {
  let raw = "";
  for await (const chunk of req) {
    raw += chunk.toString();
    if (raw.length > 64 * 1024) throw new AppError(ErrorCode.BAD_REQUEST, "Request body is too large.", 400);
  }
  try {
    return JSON.parse(raw || "{}") as unknown;
  } catch (error) {
    throw new AppError(ErrorCode.BAD_REQUEST, "Request body must be valid JSON.", 400);
  }
}

function parse<T>(schema: { parse: (data: unknown) => T }, input: unknown): T {
  const strictSchema = schema instanceof z.ZodObject ? schema.strict() : schema;
  return strictSchema.parse(input) as T;
}

function userId(req: IncomingMessage): string {
  return authenticate(req.headers, config.jwtSecret);
}

function date(value: unknown): string {
  return new Date(value as string | number | Date).toISOString();
}

async function enrolledSystem(ownerId: string, systemId: string) {
  const result = await db.query<{ id: string; name: string; type: string; health: string; observed_at: string; connector_status: string; connector_secret_name: string | null }>(
    "SELECT id, name, type, health, observed_at, connector_status, connector_secret_name FROM enrolled_systems WHERE owner_id = $1 AND id = $2 AND is_enrolled = true",
    [ownerId, systemId],
  );
  if (!result.rows[0]) throw new AppError(ErrorCode.NOT_FOUND, "Enrolled system not found.", 404);
  return result.rows[0];
}

async function diagnostic(ownerId: string, systemId: string, diagnosticId: string) {
  const startedAt = new Date();
  let status: "completed" | "failed" | "timed_out" = "completed";
  let redactedOutput = "";
  try {
    const operation = async () => {
      if (diagnosticId === "disk-service-health") {
        const item = await enrolledSystem(ownerId, systemId);
        let credentialState = "";
        if (item.connector_secret_name) {
          if (!/^[A-Za-z0-9-]{1,127}$/.test(item.connector_secret_name)) throw new Error("Invalid enrolled connector secret reference.");
          const secret = await providers.connectorSecrets.get(item.connector_secret_name);
          credentialState = secret ? "; enrolled connector credential is available." : "; enrolled connector credential is unavailable.";
        }
        return `Recorded system health: ${normalizeHealth(item.health)}; connector: ${normalizeConnectorStatus(item.connector_status, item.observed_at)}${credentialState}`;
      }
      if (diagnosticId === "dependency-health") {
        await db.query("SELECT 1");
        return "Database dependency responded to a read-only health query.";
      }
      await providers.blob.health();
      return "Blob storage dependency responded to a read-only health check.";
    };
    redactedOutput = await Promise.race([
      operation(),
      new Promise<string>((_, reject) => setTimeout(() => reject(new Error("DIAGNOSTIC_TIMEOUT")), 5_000)),
    ]);
  } catch (error) {
    status = error instanceof Error && error.message === "DIAGNOSTIC_TIMEOUT" ? "timed_out" : "failed";
    redactedOutput = status === "timed_out" ? "Diagnostic exceeded its fixed time limit." : "Diagnostic dependency check failed.";
  }
  const completedAt = new Date();
  const id = randomUUID();
  await db.transaction(async (client) => {
    await client.query(
      "INSERT INTO diagnostic_activity (id, owner_id, system_id, diagnostic_id, status, redacted_output, started_at, completed_at, created_at) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, now())",
      [id, ownerId, systemId, diagnosticId, status, redactedOutput, startedAt, completedAt],
    );
    await client.query(
      "INSERT INTO audit_records (id, actor_user_id, action, entity_type, entity_id, metadata, created_at) VALUES ($1, $2, 'system.diagnostic', 'diagnostic', $3, $4, now())",
      [randomUUID(), ownerId, id, JSON.stringify({ systemId, diagnosticId, status })],
    );
  });
  return { id, status, redactedOutput, startedAt: startedAt.toISOString(), completedAt: completedAt.toISOString() };
}

async function refreshTrainingState(ownerId: string) {
  const result = await db.query<{ id: string; status: string }>(
    "SELECT id, status FROM training_runs WHERE owner_id = $1 AND status IN ('queued', 'running')",
    [ownerId],
  );
  for (const row of result.rows) {
    try {
      const state = await worker.training(row.id);
      await db.transaction(async (client) => {
        await client.query(
          "UPDATE training_runs SET status = $3, step = $4, checkpoint_id = $5, updated_at = now() WHERE owner_id = $1 AND id = $2",
          [ownerId, row.id, state.status, state.step, state.checkpointId],
        );
        if (state.status === "completed" && state.checkpointId) {
          await client.query(
            "INSERT INTO model_checkpoints (id, owner_id, training_run_id, config, evaluation_status, created_at) VALUES ($1, $2, $3, $4, 'not_run', now()) ON CONFLICT (id) DO NOTHING",
            [state.checkpointId, ownerId, row.id, JSON.stringify({ blockSize: 128, layers: 2, heads: 4, embeddingSize: 64 })],
          );
        }
      });
    } catch (error) {
      if (error instanceof AppError && error.status === 404) {
        await db.query(
          "UPDATE training_runs SET status = 'failed', updated_at = now() WHERE owner_id = $1 AND id = $2 AND status IN ('queued', 'running')",
          [ownerId, row.id],
        );
      }
    }
  }
}

async function refreshEvaluationState(ownerId: string) {
  const pending = await db.query<{ id: string; checkpoint_id: string }>(
    "SELECT id, checkpoint_id FROM model_evaluations WHERE owner_id = $1 AND status IN ('queued', 'running') ORDER BY created_at",
    [ownerId],
  );
  for (const row of pending.rows) {
    try {
      const state = await worker.evaluation(row.id);
      await db.transaction(async (client) => {
        await client.query(
          "UPDATE model_evaluations SET status = $3, result = $4, error = $5, updated_at = now() WHERE id = $1 AND owner_id = $2",
          [row.id, ownerId, state.status, state.result, state.error],
        );
        if (state.status === "completed" || state.status === "failed") {
          await client.query(
            "UPDATE model_checkpoints SET evaluation_status = $3 WHERE owner_id = $1 AND id = $2",
            [ownerId, row.checkpoint_id, state.status === "completed" ? "complete" : "failed"],
          );
        }
      });
    } catch (error) {
      if (error instanceof AppError && error.status === 404) {
        await db.transaction(async (client) => {
          await client.query(
            "UPDATE model_evaluations SET status = 'failed', error = 'Worker evaluation state expired.', updated_at = now() WHERE owner_id = $1 AND id = $2",
            [ownerId, row.id],
          );
          await client.query(
            "UPDATE model_checkpoints SET evaluation_status = 'failed' WHERE owner_id = $1 AND id = $2",
            [ownerId, row.checkpoint_id],
          );
        });
      }
    }
  }
}

let stateSyncing = false;
async function syncPendingWorkerState() {
  if (stateSyncing) return;
  stateSyncing = true;
  try {
    const owners = await db.query<{ owner_id: string }>(
      "SELECT owner_id FROM training_runs WHERE status IN ('queued', 'running') UNION SELECT owner_id FROM model_evaluations WHERE status IN ('queued', 'running') LIMIT 100",
    );
    for (const row of owners.rows) {
      await refreshTrainingState(row.owner_id);
      await refreshEvaluationState(row.owner_id);
    }
  } catch {
    // The database may not have been migrated yet; request handlers remain available for health checks.
  } finally {
    stateSyncing = false;
  }
}

async function handle(req: IncomingMessage, res: ServerResponse) {
  const requestId = randomUUID();
  const started = Date.now();
  const pathname = (() => { try { return new URL(req.url ?? "/", "http://api").pathname; } catch { return "/invalid"; } })();
  let logged = false;
  const logRequest = () => {
    if (logged) return;
    logged = true;
    console.log(JSON.stringify({ level: "info", event: "http.request", requestId, method: req.method, path: pathname, status: res.statusCode, durationMs: Date.now() - started }));
  };
  res.on("finish", logRequest);
  res.on("close", logRequest);
  try {
    const url = new URL(req.url ?? "/", "http://api");
    if (url.search) throw new AppError(ErrorCode.BAD_REQUEST, "Query parameters are not accepted by this endpoint.", 400);
    const method = req.method ?? "GET";
    const path = url.pathname;
    const origin = req.headers.origin;
    if (origin && origin !== config.WEB_ORIGIN) throw new AppError(ErrorCode.FORBIDDEN, "Request origin is not allowed.", 403);
    if (origin === config.WEB_ORIGIN) {
      res.setHeader("access-control-allow-origin", config.WEB_ORIGIN);
      res.setHeader("access-control-allow-credentials", "true");
      res.setHeader("vary", "Origin");
    }
    if (method === "OPTIONS") {
      if (origin !== config.WEB_ORIGIN) throw new AppError(ErrorCode.FORBIDDEN, "Request origin is not allowed.", 403);
      const requestedMethod = req.headers["access-control-request-method"];
      const requestedHeaders = (req.headers["access-control-request-headers"] ?? "")
        .split(",").map((header) => header.trim().toLowerCase()).filter(Boolean);
      if (!["GET", "POST"].includes(requestedMethod ?? "") ||
          requestedHeaders.some((header) => !["authorization", "content-type"].includes(header))) {
        throw new AppError(ErrorCode.BAD_REQUEST, "CORS preflight request is invalid.", 400);
      }
      res.writeHead(204, {
        "access-control-allow-origin": config.WEB_ORIGIN,
        "access-control-allow-credentials": "true",
        "access-control-allow-methods": "GET, POST, OPTIONS",
        "access-control-allow-headers": "Authorization, Content-Type",
        "access-control-max-age": "600",
        vary: "Origin",
      });
      return res.end();
    }
    const hasCookie = typeof req.headers.cookie === "string" && req.headers.cookie.includes("assistant_session=");
    if (method === "POST" && hasCookie && origin !== config.WEB_ORIGIN) {
      throw new AppError(ErrorCode.FORBIDDEN, "Cookie-authenticated requests require the configured web origin.", 403);
    }
    if (method === "GET" && ((Number(req.headers["content-length"] ?? 0) > 0) || req.headers["transfer-encoding"])) {
      throw new AppError(ErrorCode.BAD_REQUEST, "GET requests must not include a body.", 400);
    }

      if (method === "GET" && path === "/api/health") {
      const [database, dependencies] = await Promise.allSettled([db.query("SELECT 1"), providers.health()]);
      let workerStatus: "healthy" | "unavailable" = "unavailable";
      try {
        const response = await fetch(new URL("/health", config.MODEL_WORKER_BASE_URL), { signal: AbortSignal.timeout(2_000) });
        workerStatus = response.ok ? "healthy" : "unavailable";
      } catch {}
      const services = {
        database: database.status === "fulfilled" ? "healthy" : "unavailable",
        ...(dependencies.status === "fulfilled" ? dependencies.value : { blob: "unavailable", keyVault: "unavailable" }),
        modelWorker: workerStatus,
      };
      const healthy = Object.values(services).every((value) => value === "healthy");
      return healthy
        ? send(res, 200, { status: "healthy", services })
        : send(res, 503, { error: { code: ErrorCode.INTERNAL_ERROR, message: "One or more essential services are unavailable.", details: services } });
    }

    if (method === "POST" && path === "/api/auth/register") {
      const result = await auth.register(await readBody(req));
      return send(res, 201, { user: result.user }, { "set-cookie": sessionCookie(result.token, secureCookie) });
    }
    if (method === "POST" && path === "/api/auth/login") {
      const result = await auth.login(await readBody(req));
      return send(res, 200, { user: result.user }, { "set-cookie": sessionCookie(result.token, secureCookie) });
    }
    if (method === "GET" && path === "/api/auth/me") {
      return send(res, 200, { user: await auth.current(userId(req)) });
    }
    if (method === "POST" && path === "/api/auth/logout") {
      parse(LogoutRequestSchema, await readBody(req));
      try {
        await auth.logout(userId(req));
      } catch (error) {
        if (!(error instanceof AppError && error.status === 401)) throw error;
      }
      return send(res, 204, undefined, { "set-cookie": clearedSessionCookie(secureCookie) });
    }

    if (method === "GET" && path === "/openapi.json") {
      userId(req);
      return send(res, 200, openApi);
    }
    if (!path.startsWith("/api/")) throw new AppError(ErrorCode.NOT_FOUND, "Route not found.", 404);
    const ownerId = userId(req);

    if (method === "GET" && path === "/api/conversations") {
      const result = await db.query<{ id: string; title: string; updated_at: string }>(
        "SELECT id, title, updated_at FROM conversations WHERE owner_id = $1 ORDER BY updated_at DESC",
        [ownerId],
      );
      return send(res, 200, { items: result.rows.map((row) => ({ id: row.id, title: row.title, updatedAt: date(row.updated_at) })) });
    }
    if (method === "POST" && path === "/api/conversations") {
      const input = parse(ApiSchemas.createConversation, await readBody(req));
      const id = randomUUID();
      const createdAt = new Date().toISOString();
      await db.transaction(async (client) => {
        await client.query("INSERT INTO conversations (id, owner_id, title, created_at, updated_at) VALUES ($1, $2, $3, $4, $4)", [id, ownerId, input.title, createdAt]);
        await client.query(
          "INSERT INTO audit_records (id, actor_user_id, action, entity_type, entity_id, metadata, created_at) VALUES ($1, $2, 'conversation.create', 'conversation', $3, $4, now())",
          [randomUUID(), ownerId, id, JSON.stringify({})],
        );
      });
      return send(res, 201, { id, title: input.title, createdAt });
    }

    const messagesMatch = path.match(/^\/api\/conversations\/([^/]+)\/messages$/);
    if (messagesMatch && (method === "GET" || method === "POST")) {
      const { conversation_id: conversationId } = parse(ConversationIdParamsSchema, { conversation_id: decodeURIComponent(messagesMatch[1]) });
      const conversation = await db.query("SELECT id FROM conversations WHERE id = $1 AND owner_id = $2", [conversationId, ownerId]);
      if (!conversation.rowCount) throw new AppError(ErrorCode.NOT_FOUND, "Conversation not found.", 404);
      if (method === "GET") {
        const result = await db.query<{ id: string; role: "user" | "assistant"; content: string; created_at: string }>(
          "SELECT id, role, content, created_at FROM conversation_messages WHERE conversation_id = $1 AND owner_id = $2 ORDER BY created_at",
          [conversationId, ownerId],
        );
        return send(res, 200, { items: result.rows.map((row) => ({ id: row.id, role: row.role, content: row.content, createdAt: date(row.created_at) })) });
      }
      const input = parse(ApiSchemas.createMessage, await readBody(req));
      const requestId = randomUUID();
      const prior = await db.query<{ role: "user" | "assistant"; content: string }>(
        "SELECT role, content FROM conversation_messages WHERE conversation_id = $1 AND owner_id = $2 ORDER BY created_at DESC LIMIT 11",
        [conversationId, ownerId],
      );
      let remainingContextCharacters = Math.max(0, 8_000 - input.content.length);
      const context: Array<{ role: "user" | "assistant"; content: string }> = [];
      for (const message of prior.rows) {
        if (remainingContextCharacters <= 0) break;
        const content = message.content.slice(-Math.min(1_500, remainingContextCharacters));
        if (content) {
          context.unshift({ role: message.role, content });
          remainingContextCharacters -= content.length;
        }
      }
      const messages = [...context, { role: "user" as const, content: input.content }];
      let checkpointId: string | null = null;
      if (process.env.MODEL_INFERENCE_BACKEND === "scratch") {
        const checkpoint = await db.query<{ id: string }>(
          "SELECT id FROM model_checkpoints WHERE owner_id = $1 ORDER BY created_at DESC LIMIT 1",
          [ownerId],
        );
        checkpointId = checkpoint.rows[0]?.id ?? null;
      }
      const response = await worker.inference({ requestId, messages, checkpointId });
      const userMessage = { id: randomUUID(), role: "user", content: input.content, createdAt: new Date().toISOString() };
      const assistantDraft = { id: randomUUID(), role: "assistant", content: response.generatedText, createdAt: new Date().toISOString(), reviewRequired: true };
      await db.transaction(async (client) => {
        await client.query(
          "INSERT INTO conversation_messages (id, owner_id, conversation_id, role, content, created_at) VALUES ($1, $2, $3, 'user', $4, $5), ($6, $2, $3, 'assistant', $7, $8)",
          [userMessage.id, ownerId, conversationId, userMessage.content, userMessage.createdAt, assistantDraft.id, assistantDraft.content, assistantDraft.createdAt],
        );
        await client.query("UPDATE conversations SET updated_at = now() WHERE id = $1 AND owner_id = $2", [conversationId, ownerId]);
        await client.query(
          "INSERT INTO audit_records (id, actor_user_id, action, entity_type, entity_id, metadata, created_at) VALUES ($1, $2, 'conversation.message', 'conversation', $3, $4, now())",
          [randomUUID(), ownerId, conversationId, JSON.stringify({ reviewRequired: true })],
        );
      });
      return send(res, 201, { userMessage, assistantDraft, reviewRequired: true });
    }

    if (method === "GET" && path === "/api/systems") {
      const result = await db.query<{ id: string; name: string; type: string; health: string; observed_at: string; connector_status: string }>(
        "SELECT id, name, type, health, observed_at, connector_status FROM enrolled_systems WHERE owner_id = $1 AND is_enrolled = true ORDER BY name",
        [ownerId],
      );
      return send(res, 200, { items: result.rows.map((row) => ({
        id: row.id, name: row.name, type: row.type, health: normalizeHealth(row.health),
        observedAt: date(row.observed_at), connectorStatus: normalizeConnectorStatus(row.connector_status, row.observed_at),
      })) });
    }
    if (method === "GET" && path === "/api/systems/events") {
      res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache, no-transform", connection: "keep-alive" });
      const emit = async () => {
        try {
          const result = await db.query<{ id: string; name: string; type: string; health: string; observed_at: string; connector_status: string }>(
            "SELECT id, name, type, health, observed_at, connector_status FROM enrolled_systems WHERE owner_id = $1 AND is_enrolled = true ORDER BY name",
            [ownerId],
          );
          const items = result.rows.map((row) => ({
            id: row.id, name: row.name, type: row.type, health: normalizeHealth(row.health),
            observedAt: date(row.observed_at), connectorStatus: normalizeConnectorStatus(row.connector_status, row.observed_at),
          }));
          res.write(`event: systems\ndata: ${JSON.stringify(items)}\n\n`);
        } catch {
          res.write(`event: error\ndata: ${JSON.stringify({ error: { code: ErrorCode.INTERNAL_ERROR, message: "Inventory unavailable.", details: null } })}\n\n`);
        }
      };
      void emit();
      const timer = setInterval(() => { void emit(); }, 15_000);
      res.on("close", () => clearInterval(timer));
      return;
    }
    const diagnosticListMatch = path.match(/^\/api\/systems\/([^/]+)\/diagnostics$/);
    if (method === "GET" && diagnosticListMatch) {
      const { system_id: systemId } = parse(SystemIdParamsSchema, { system_id: decodeURIComponent(diagnosticListMatch[1]) });
      await enrolledSystem(ownerId, systemId);
      return send(res, 200, { items: diagnosticOptions });
    }
    const diagnosticMatch = path.match(/^\/api\/systems\/([^/]+)\/diagnostics\/([^/]+)$/);
    if (method === "POST" && diagnosticMatch) {
      const { system_id: systemId, diagnostic_id: diagnosticId } = parse(DiagnosticParamsSchema, {
        system_id: decodeURIComponent(diagnosticMatch[1]), diagnostic_id: decodeURIComponent(diagnosticMatch[2]),
      });
      parse(DiagnosticRequestSchema, await readBody(req));
      await enrolledSystem(ownerId, systemId);
      return send(res, 200, await diagnostic(ownerId, systemId, diagnosticId));
    }
    if (method === "GET" && path === "/api/terminal/activity") {
      const result = await db.query<{ id: string; system_id: string; diagnostic_id: string; status: string; created_at: string }>(
        "SELECT id, system_id, diagnostic_id, status, created_at FROM diagnostic_activity WHERE owner_id = $1 ORDER BY created_at DESC LIMIT 100",
        [ownerId],
      );
      return send(res, 200, { items: result.rows.map((row) => ({ id: row.id, systemId: row.system_id, diagnosticId: row.diagnostic_id, status: row.status, createdAt: date(row.created_at) })) });
    }

    if (method === "GET" && path === "/api/operations/proposals") {
      const result = await db.query<{ id: string; summary: string; rationale: string; status: string; submitted_at: string; decision_at: string | null }>(
        "SELECT id, summary, rationale, CASE WHEN status = 'pending' AND expires_at <= now() THEN 'expired' ELSE status END AS status, submitted_at, decision_at FROM operation_proposals WHERE owner_id = $1 ORDER BY submitted_at DESC",
        [ownerId],
      );
      return send(res, 200, { items: result.rows.map((row) => ({
        id: row.id, summary: row.summary, rationale: row.rationale, status: row.status,
        submittedAt: date(row.submitted_at), decisionAt: row.decision_at ? date(row.decision_at) : null,
      })) });
    }
    if (method === "POST" && path === "/api/operations/proposals") {
      const input = parse(ApiSchemas.createProposal, await readBody(req));
      const template = proposalTemplates[input.operationId];
      if (!template.validate(input.parameters)) throw new AppError(ErrorCode.VALIDATION_ERROR, "Proposal parameters do not match the allowlisted template.", 422);
      const id = randomUUID();
      const now = new Date();
      const expiresAt = new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000);
      const summary = template.summary(input.parameters);
      await db.transaction(async (client) => {
        await client.query(
          "INSERT INTO operation_proposals (id, owner_id, operation_id, summary, status, parameters, rationale, submitted_at, expires_at) VALUES ($1, $2, $3, $4, 'pending', $5, $6, $7, $8)",
          [id, ownerId, input.operationId, summary, JSON.stringify(input.parameters), input.rationale, now, expiresAt],
        );
        await client.query(
          "INSERT INTO audit_records (id, actor_user_id, action, entity_type, entity_id, metadata, created_at) VALUES ($1, $2, 'proposal.create', 'proposal', $3, $4, now())",
          [randomUUID(), ownerId, id, JSON.stringify({ operationId: input.operationId })],
        );
      });
      return send(res, 201, {
        id, summary, rationale: input.rationale, status: "pending", impact: template.impact,
        submittedAt: now.toISOString(), expiresAt: expiresAt.toISOString(),
      });
    }
    const decisionMatch = path.match(/^\/api\/operations\/proposals\/([^/]+)\/decision$/);
    if (method === "POST" && decisionMatch) {
      const { proposal_id: proposalId } = parse(ProposalIdParamsSchema, { proposal_id: decodeURIComponent(decisionMatch[1]) });
      const input = parse(ProposalDecisionRequestSchema, await readBody(req));
      const decisionAt = new Date();
      const auditRecordId = randomUUID();
      const proposal = await db.transaction(async (client) => {
        const update = await client.query<{ id: string; summary: string; rationale: string; submitted_at: string }>(
          "UPDATE operation_proposals SET status = $3, decision_at = $4, decision_note = $5 WHERE id = $1 AND owner_id = $2 AND status = 'pending' AND expires_at > now() RETURNING id, summary, rationale, submitted_at",
          [proposalId, ownerId, input.decision === "approve" ? "approved" : "rejected", decisionAt, input.note],
        );
        if (!update.rowCount) {
          const exists = await client.query("SELECT status FROM operation_proposals WHERE id = $1 AND owner_id = $2", [proposalId, ownerId]);
          if (!exists.rowCount) throw new AppError(ErrorCode.NOT_FOUND, "Proposal not found.", 404);
          throw new AppError(ErrorCode.CONFLICT, "Proposal is no longer pending or has expired.", 409);
        }
        await client.query(
          "INSERT INTO audit_records (id, actor_user_id, action, entity_type, entity_id, metadata, created_at) VALUES ($1, $2, 'proposal.decision', 'proposal', $3, $4, now())",
          [auditRecordId, ownerId, proposalId, JSON.stringify({ decision: input.decision, note: input.note })],
        );
        return update.rows[0];
      });
      return send(res, 200, {
        id: proposal.id, summary: proposal.summary, rationale: proposal.rationale,
        status: input.decision === "approve" ? "approved" : "rejected",
        decisionAt: decisionAt.toISOString(), auditRecordId, submittedAt: date(proposal.submitted_at),
      });
    }

    if (method === "GET" && path === "/api/models/training-runs") {
      await refreshTrainingState(ownerId);
      const result = await db.query<{ id: string; status: string; step: number; checkpoint_id: string | null; created_at: string }>(
        "SELECT id, status, step, checkpoint_id, created_at FROM training_runs WHERE owner_id = $1 ORDER BY created_at DESC",
        [ownerId],
      );
      return send(res, 200, { items: result.rows.map((row) => ({
        id: row.id, status: row.status, step: row.step, checkpointId: row.checkpoint_id,
        createdAt: date(row.created_at),
      })) });
    }
    if (method === "POST" && path === "/api/models/training-runs") {
      const raw = await readBody(req);
      if (typeof raw === "object" && raw !== null && "config" in raw) {
        const rawConfig = (raw as Record<string, unknown>).config;
        if (typeof rawConfig === "object" && rawConfig !== null && !Array.isArray(rawConfig) &&
            Object.keys(rawConfig).some((key) => !["blockSize", "layers", "heads", "embeddingSize", "batchSize"].includes(key))) {
          throw new AppError(ErrorCode.VALIDATION_ERROR, "Unexpected training configuration field.", 422);
        }
      }
      const input = parse(ApiSchemas.createTrainingRun, raw);
      if (!isApprovedFileId(input.corpusId)) throw new AppError(ErrorCode.VALIDATION_ERROR, "Invalid approved corpus identifier.", 422);
      const corpus = await db.query("SELECT id FROM approved_corpora WHERE owner_id = $1 AND id = $2 AND status = 'approved'", [ownerId, input.corpusId]);
      if (!corpus.rowCount) throw new AppError(ErrorCode.NOT_FOUND, "Approved training corpus not found.", 404);
      if ((input.config.blockSize !== undefined && input.config.blockSize !== 128) ||
          (input.config.layers !== undefined && input.config.layers !== 2) ||
          (input.config.heads !== undefined && input.config.heads !== 4) ||
          (input.config.embeddingSize !== undefined && input.config.embeddingSize !== 64)) {
        throw new AppError(ErrorCode.VALIDATION_ERROR, "The existing local model currently supports its fixed 128-byte, 2-layer, 4-head, 64-dimension architecture only.", 422);
      }
      const id = randomUUID();
      const createdAt = new Date();
      await db.transaction(async (client) => {
        await client.query(
          "INSERT INTO training_runs (id, owner_id, corpus_id, status, step, config, created_at, updated_at) VALUES ($1, $2, $3, 'queued', 0, $4, $5, $5)",
          [id, ownerId, input.corpusId, JSON.stringify(input.config), createdAt],
        );
        await client.query(
          "INSERT INTO audit_records (id, actor_user_id, action, entity_type, entity_id, metadata, created_at) VALUES ($1, $2, 'model.training.create', 'training_run', $3, $4, now())",
          [randomUUID(), ownerId, id, JSON.stringify({ maxSteps: input.maxSteps })],
        );
      });
      try {
        await worker.createTraining({ runId: id, corpusId: input.corpusId, maxSteps: input.maxSteps, config: input.config });
      } catch (error) {
        await db.query("UPDATE training_runs SET status = 'failed', updated_at = now() WHERE id = $1 AND owner_id = $2", [id, ownerId]);
        throw error;
      }
      return send(res, 202, { id, status: "queued", createdAt: createdAt.toISOString() });
    }
    if (method === "GET" && path === "/api/models/checkpoints") {
      await refreshEvaluationState(ownerId);
      const result = await db.query<{ id: string; created_at: string; config: Record<string, number>; evaluation_status: string }>(
        "SELECT id, created_at, config, evaluation_status FROM model_checkpoints WHERE owner_id = $1 ORDER BY created_at DESC",
        [ownerId],
      );
      return send(res, 200, { items: result.rows.map((row) => ({ id: row.id, createdAt: date(row.created_at), config: row.config, evaluationStatus: row.evaluation_status })) });
    }
    if (method === "GET" && path === "/api/models/evaluations") {
      await refreshEvaluationState(ownerId);
      const result = await db.query<{
        id: string; checkpoint_id: string; status: string; result: Record<string, number> | null;
        error: string | null; created_at: string;
      }>(
        "SELECT id, checkpoint_id, status, result, error, created_at FROM model_evaluations WHERE owner_id = $1 ORDER BY created_at DESC",
        [ownerId],
      );
      return send(res, 200, { items: result.rows.map((row) => ({
        id: row.id, checkpointId: row.checkpoint_id, status: row.status,
        result: row.result, error: row.error, createdAt: date(row.created_at),
      })) });
    }
    if (method === "POST" && path === "/api/models/evaluations") {
      const input = parse(ApiSchemas.createEvaluation, await readBody(req));
      if (!isApprovedFileId(input.datasetId)) throw new AppError(ErrorCode.VALIDATION_ERROR, "Invalid evaluation dataset identifier.", 422);
      const checkpoint = await db.query("SELECT id FROM model_checkpoints WHERE owner_id = $1 AND id = $2", [ownerId, input.checkpointId]);
      if (!checkpoint.rowCount) throw new AppError(ErrorCode.NOT_FOUND, "Checkpoint not found.", 404);
      const dataset = await db.query("SELECT id FROM approved_corpora WHERE owner_id = $1 AND id = $2 AND status = 'approved' AND purpose = 'evaluation'", [ownerId, input.datasetId]);
      if (!dataset.rowCount) throw new AppError(ErrorCode.NOT_FOUND, "Approved evaluation dataset not found.", 404);
      const id = randomUUID();
      const createdAt = new Date();
      await db.transaction(async (client) => {
        await client.query(
          "INSERT INTO model_evaluations (id, owner_id, checkpoint_id, dataset_id, status, created_at, updated_at) VALUES ($1, $2, $3, $4, 'queued', $5, $5)",
          [id, ownerId, input.checkpointId, input.datasetId, createdAt],
        );
        await client.query(
          "INSERT INTO audit_records (id, actor_user_id, action, entity_type, entity_id, metadata, created_at) VALUES ($1, $2, 'model.evaluation.create', 'evaluation', $3, $4, now())",
          [randomUUID(), ownerId, id, JSON.stringify({ checkpointId: input.checkpointId })],
        );
        await client.query(
          "UPDATE model_checkpoints SET evaluation_status = 'pending' WHERE id = $1 AND owner_id = $2",
          [input.checkpointId, ownerId],
        );
      });
      try {
        await worker.createEvaluation({ evaluationId: id, checkpointId: input.checkpointId, datasetId: input.datasetId });
      } catch (error) {
        await db.query("UPDATE model_evaluations SET status = 'failed', updated_at = now() WHERE id = $1 AND owner_id = $2", [id, ownerId]);
        throw error;
      }
      return send(res, 202, { id, status: "queued", createdAt: createdAt.toISOString() });
    }

    throw new AppError(ErrorCode.NOT_FOUND, "Route not found.", 404);
  } catch (error) {
    let normalized: unknown = error;
    if (error instanceof ZodError) {
      normalized = new AppError(ErrorCode.VALIDATION_ERROR, "Request validation failed.", 422, {
        issues: error.issues.map((issue) => ({ path: issue.path.join("."), code: issue.code, message: issue.message })),
      });
    } else if (error instanceof URIError || error instanceof TypeError) {
      normalized = new AppError(ErrorCode.BAD_REQUEST, "Invalid request.", 400);
    }
    const result = errorResponse(normalized);
    send(res, result.status, result.body);
  }
}

const server = createServer((req, res) => { void handle(req, res); });
server.requestTimeout = 35_000;
server.headersTimeout = 10_000;
async function start() {
  await db.query("SELECT 1");
  const health = await providers.health();
  if (Object.values(health).some((value) => value !== "healthy")) throw new Error("Essential Azure provider initialization failed.");
  server.listen(config.PORT, "0.0.0.0", () => {
    console.log(JSON.stringify({ level: "info", event: "api.started", port: config.PORT, environment: config.NODE_ENV ?? (config.development ? "development" : "unspecified") }));
    const syncTimer = setInterval(() => { void syncPendingWorkerState(); }, 15_000);
    syncTimer.unref();
    for (const signal of ["SIGINT", "SIGTERM"] as const) {
      process.once(signal, () => {
        clearInterval(syncTimer);
        server.close(() => { void db.close().finally(() => process.exit(0)); });
      });
    }
  });
}
void start().catch(async (error: unknown) => {
  console.error(JSON.stringify({ level: "error", event: "api.startup_failed", message: error instanceof Error ? error.message : "Startup failed" }));
  await db.close();
  process.exitCode = 1;
});
