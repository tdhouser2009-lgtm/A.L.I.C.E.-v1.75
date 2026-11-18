/**
 * Contracts shared by the assistant API, the model worker, and the web console.
 * Every request body the API accepts is validated with one of these schemas.
 */
import { z } from "zod";

// ───── Errors ─────

export const ErrorCode = {
  VALIDATION_ERROR: "VALIDATION_ERROR",
  BAD_REQUEST: "BAD_REQUEST",
  NOT_FOUND: "NOT_FOUND",
  CONFLICT: "CONFLICT",
  UNAUTHORIZED: "UNAUTHORIZED",
  FORBIDDEN: "FORBIDDEN",
  INTERNAL_ERROR: "INTERNAL_ERROR",
  SERVICE_UNAVAILABLE: "SERVICE_UNAVAILABLE",
  CAPABILITY_UNAVAILABLE: "CAPABILITY_UNAVAILABLE",
} as const;
export type ErrorCode = (typeof ErrorCode)[keyof typeof ErrorCode];

export interface ErrorResponse {
  error: { code: ErrorCode; message: string; details: Record<string, unknown> | null };
}

// ───── Identifiers ─────

const uuid = z.string().uuid();
/** Identifiers for approved corpora, checkpoints, and enrolled systems (safe as file names). */
export const SafeIdSchema = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,119}$/, "Use letters, digits, '.', '_' or '-' (max 120).");
/** Home Assistant entity id, e.g. `light.kitchen`. */
export const EntityIdSchema = z.string().regex(/^[a-z_][a-z0-9_]*\.[a-z0-9_]+$/, "Expected an entity id like light.kitchen.");
export const ServiceNameSchema = z.string().regex(/^[a-z_][a-z0-9_]{0,63}$/, "Expected a Home Assistant service name like turn_on.");

// ───── Auth ─────

export interface UserSummary {
  id: string;
  email: string;
  displayName: string;
}

export const RegisterRequestSchema = z.object({
  email: z.string().trim().email().max(254),
  password: z.string().min(12, "Use at least 12 characters.").max(256),
  displayName: z.string().trim().min(1).max(80),
});
export const LoginRequestSchema = z.object({
  email: z.string().trim().email().max(254),
  password: z.string().min(1).max(256),
});
export const LogoutRequestSchema = z.object({});

// ───── Route parameters ─────

export const ConversationIdParamsSchema = z.object({ conversation_id: uuid });
export const SystemIdParamsSchema = z.object({ system_id: SafeIdSchema });
export const DiagnosticIdSchema = z.enum(["disk-service-health", "dependency-health", "storage-availability"]);
export const DiagnosticParamsSchema = z.object({ system_id: SafeIdSchema, diagnostic_id: DiagnosticIdSchema });
export const DiagnosticRequestSchema = z.object({});
export const ProposalIdParamsSchema = z.object({ proposal_id: uuid });
export const ProposalDecisionRequestSchema = z.object({
  decision: z.enum(["approve", "reject"]),
  note: z.string().trim().max(500).default(""),
});
export const CheckpointIdParamsSchema = z.object({ checkpoint_id: SafeIdSchema });
export const EntityIdParamsSchema = z.object({ entity_id: EntityIdSchema });

// ───── Chat ─────

/**
 * `local` is A.L.I.C.E.'s own from-scratch model (the default and the point of the project).
 * `ollama` is an optional developer fallback that is off unless OLLAMA_ENABLED=true.
 */
export const ChatBackendSchema = z.enum(["local", "ollama"]);
export type ChatBackend = z.infer<typeof ChatBackendSchema>;

export const ChatMessageSchema = z.object({
  role: z.enum(["system", "user", "assistant"]),
  content: z.string().max(12_000),
});
export type ChatMessage = z.infer<typeof ChatMessageSchema>;

// ───── Model Lab ─────

export const ModelArchitectureSchema = z
  .object({
    blockSize: z.number().int().min(16).max(512).optional(),
    layers: z.number().int().min(1).max(8).optional(),
    heads: z.number().int().min(1).max(16).optional(),
    embeddingSize: z.number().int().min(16).max(512).optional(),
    batchSize: z.number().int().min(1).max(128).optional(),
  })
  .strict()
  .refine(
    (config) => config.embeddingSize === undefined || config.heads === undefined || config.embeddingSize % config.heads === 0,
    { message: "embeddingSize must be divisible by heads." },
  );
export type ModelArchitecture = z.infer<typeof ModelArchitectureSchema>;

/** The configuration actually stored in a checkpoint, as reported by the model core. */
export interface CheckpointConfig {
  blockSize: number;
  layers: number;
  heads: number;
  embeddingSize: number;
}

export const CorpusPurposeSchema = z.enum(["training", "evaluation", "both"]);

// ───── Public API request bodies ─────

export const ProposalOperationIdSchema = z.enum([
  "checkpoint-retention",
  "cpu-evaluation-batch",
  "desktop-sync-interval",
]);

export const ApiSchemas = {
  createConversation: z.object({ title: z.string().trim().min(1).max(120) }),
  createMessage: z.object({
    content: z.string().trim().min(1).max(12_000),
    backend: ChatBackendSchema.optional(),
  }),
  createProposal: z.object({
    operationId: ProposalOperationIdSchema,
    parameters: z.record(z.unknown()),
    rationale: z.string().trim().min(1).max(500),
  }),
  createCorpus: z.object({
    id: SafeIdSchema,
    purpose: CorpusPurposeSchema,
    content: z.string().min(129, "Corpora must contain more than 128 characters.").max(5_000_000),
  }),
  createTrainingRun: z.object({
    corpusId: SafeIdSchema,
    maxSteps: z.number().int().min(1).max(5_000).default(200),
    config: ModelArchitectureSchema.default({}),
  }),
  createEvaluation: z.object({ checkpointId: SafeIdSchema, datasetId: SafeIdSchema }),
  importConversations: z.object({
    turns: z.array(z.object({
      user: z.string().min(1).max(12_000),
      assistant: z.string().min(1).max(12_000),
      rating: z.enum(["up", "down"]).nullable().optional(),
      correction: z.string().max(12_000).nullable().optional(),
    })).min(1).max(5_000),
  }),
  createFeedback: z.object({
    conversationId: uuid,
    messageId: uuid,
    rating: z.enum(["up", "down"]),
    correction: z.string().trim().max(12_000).optional(),
    useForTraining: z.boolean().default(false),
  }),
  createLearningRun: z.object({
    datasetIds: z.array(SafeIdSchema).max(20).default([]),
    feedbackIds: z.array(uuid).max(1_000).optional(),
    maxSteps: z.number().int().min(1).max(5_000).default(200),
  }),
  warmStart: z.object({ maxSteps: z.number().int().min(1).max(5_000).default(400) }),
  promoteCheckpoint: z.object({
    decision: z.enum(["promote", "reject"]),
    evaluationId: uuid.optional(),
  }),
  rollbackCheckpoint: z.object({ reason: z.string().trim().min(1).max(500) }),
  updateModelSettings: z.object({
    chatBackend: ChatBackendSchema.optional(),
    learningEnabled: z.boolean().optional(),
    autoPromote: z.boolean().optional(),
    learnEveryTurns: z.number().int().min(1).max(1_000).optional(),
    learningSteps: z.number().int().min(1).max(5_000).optional(),
    syncShareEnabled: z.boolean().optional(),
  }),
  syncContribution: z.object({
    installId: z.string().min(8).max(100),
    turns: z.array(z.object({ user: z.string().min(1).max(12_000), assistant: z.string().min(1).max(12_000) })).min(1).max(500),
  }),
  homeEntityAction: z.object({
    action: ServiceNameSchema,
    parameters: z.record(z.unknown()).default({}),
    preview: z.boolean().default(false),
    rationale: z.string().trim().max(500).optional(),
  }),
  homeSceneActivate: z.object({ preview: z.boolean().default(false), rationale: z.string().trim().max(500).optional() }),
  homeAutomationAction: z.object({
    action: z.enum(["turn_on", "turn_off", "trigger"]),
    preview: z.boolean().default(false),
    rationale: z.string().trim().max(500).optional(),
  }),
  homeScriptRun: z.object({
    parameters: z.record(z.unknown()).default({}),
    preview: z.boolean().default(false),
    rationale: z.string().trim().max(500).optional(),
  }),
} as const;

// ───── Private worker contract ─────

export const InferenceRequestSchema = z.object({
  requestId: z.string().min(1).max(100),
  messages: z.array(ChatMessageSchema).min(1).max(200),
  backend: ChatBackendSchema.default("local"),
  checkpointId: SafeIdSchema.nullable().default(null),
  model: z.string().max(200).optional(),
  maxNewTokens: z.number().int().min(1).max(4_096).optional(),
});
export type InferenceRequest = z.infer<typeof InferenceRequestSchema>;

export interface InferenceResponse {
  requestId: string;
  generatedText: string;
  backend: ChatBackend;
  model: string;
}

export const WorkerCorpusRequestSchema = z.object({
  corpusId: SafeIdSchema,
  purpose: CorpusPurposeSchema,
  content: z.string().min(1).max(5_000_000),
});

export const WorkerTrainingRequestSchema = z.object({
  runId: z.string().uuid(),
  corpusId: SafeIdSchema,
  maxSteps: z.number().int().min(1).max(5_000),
  config: ModelArchitectureSchema.default({}),
  baseCheckpointId: SafeIdSchema.nullable().optional(),
  /** Additional approved corpora appended to the main corpus (e.g. user datasets in a learning run). */
  extraCorpusIds: z.array(SafeIdSchema).max(20).optional(),
  /** New checkpoint id to write; the worker never overwrites an existing checkpoint. */
  checkpointId: SafeIdSchema.optional(),
});
export type WorkerTrainingRequest = z.infer<typeof WorkerTrainingRequestSchema>;

export type JobStatus = "queued" | "running" | "completed" | "failed" | "cancelled";

export interface WorkerJobAccepted {
  runId: string;
  status: JobStatus;
}

export interface WorkerJobStatus {
  runId: string;
  baseCheckpointId: string | null;
  status: JobStatus;
  step: number;
  maxSteps: number;
  loss: number | null;
  checkpointId: string | null;
  config: CheckpointConfig | null;
  error: string | null;
}

export const WorkerEvaluationRequestSchema = z.object({
  evaluationId: z.string().uuid(),
  checkpointId: SafeIdSchema,
  datasetId: SafeIdSchema,
  /** Also evaluate this checkpoint on the same data so the two can be compared fairly. */
  baselineCheckpointId: SafeIdSchema.nullable().optional(),
});

export interface WorkerEvaluationAccepted {
  evaluationId: string;
  status: JobStatus;
}

export interface EvaluationMetrics {
  loss: number;
  perplexity: number;
  bytesEvaluated: number;
}

export interface EvaluationResult extends EvaluationMetrics {
  baseline?: (EvaluationMetrics & { checkpointId: string }) | null;
}

export interface WorkerEvaluationStatus {
  evaluationId: string;
  status: JobStatus;
  result: EvaluationResult | null;
  error: string | null;
}

export const WorkerInitRequestSchema = z.object({
  checkpointId: SafeIdSchema,
  config: ModelArchitectureSchema.default({}),
});

export interface WorkerCheckpointInfo {
  checkpointId: string;
  config: CheckpointConfig;
  parameters: number;
  totalSteps?: number;
}

export interface BackendStatus {
  ollama: { available: boolean; baseUrl: string; defaultModel: string; models: string[] };
  local: { available: boolean; reason: string | null };
  defaultBackend: ChatBackend;
}

// ───── Home Assistant ─────

/** Domains whose actions are considered high impact; the console always routes them through approval. */
export const HIGH_IMPACT_DOMAINS = [
  "lock", "alarm_control_panel", "cover", "climate", "water_heater", "valve", "siren", "camera",
  "script", "automation", "update", "button",
] as const;
