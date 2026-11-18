import path from "node:path";
import { z } from "zod";

const truthy = z
  .string()
  .optional()
  .transform((value) => ["1", "true", "yes", "on"].includes((value ?? "").trim().toLowerCase()));

const EnvironmentSchema = z.object({
  PORT: z.coerce.number().int().min(1).max(65535).default(8081),
  HOST: z.string().default("0.0.0.0"),
  CHECKPOINT_ROOT: z.string().default("./.worker-data/checkpoints"),
  CORPUS_ROOT: z.string().default("./.worker-data/corpora"),
  DATASET_ROOT: z.string().default("./.worker-data/datasets"),
  WORKER_STATE_FILE: z.string().default("./.worker-data/job-state.json"),
  /** Folder that contains model_bridge.py and the alice/ package (the project root). */
  MODEL_CORE_DIR: z.string().optional(),
  PYTHONPATH: z.string().optional(),
  PYTHON: z.string().optional(),
  OLLAMA_ENABLED: truthy,
  OLLAMA_BASE_URL: z.string().url().default("http://127.0.0.1:11434"),
  OLLAMA_MODEL: z.string().default("qwen2.5:3b"),
  AZURITE_CONNECTION_STRING: z.string().optional(),
  MAX_QUEUED_JOBS: z.coerce.number().int().min(1).max(100).default(10),
});

export interface WorkerConfig {
  port: number;
  host: string;
  checkpointRoot: string;
  corpusRoot: string;
  datasetRoot: string;
  stateFile: string;
  modelCoreDir: string;
  python: string;
  ollama: { enabled: boolean; baseUrl: string; model: string };
  azuriteConnectionString: string | null;
  maxQueuedJobs: number;
}

export function loadWorkerConfig(env: NodeJS.ProcessEnv = process.env): WorkerConfig {
  const parsed = EnvironmentSchema.safeParse(env);
  if (!parsed.success) throw new Error(`Invalid worker configuration: ${parsed.error.message}`);
  const value = parsed.data;
  const modelCoreDir = path.resolve(value.MODEL_CORE_DIR ?? value.PYTHONPATH?.split(path.delimiter)[0] ?? "../..");
  return {
    port: value.PORT,
    host: value.HOST,
    checkpointRoot: path.resolve(value.CHECKPOINT_ROOT),
    corpusRoot: path.resolve(value.CORPUS_ROOT),
    datasetRoot: path.resolve(value.DATASET_ROOT),
    stateFile: path.resolve(value.WORKER_STATE_FILE),
    modelCoreDir,
    python: value.PYTHON ?? "python3",
    ollama: { enabled: value.OLLAMA_ENABLED, baseUrl: value.OLLAMA_BASE_URL.replace(/\/$/, ""), model: value.OLLAMA_MODEL },
    azuriteConnectionString: value.AZURITE_CONNECTION_STRING ?? null,
    maxQueuedJobs: value.MAX_QUEUED_JOBS,
  };
}
