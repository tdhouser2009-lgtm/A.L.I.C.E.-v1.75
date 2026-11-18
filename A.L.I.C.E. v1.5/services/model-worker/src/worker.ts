/**
 * Private model worker: A.L.I.C.E.'s own model for chat, training, evaluation, and checkpoints.
 * It listens only on the private Docker network (no host-published port) and never executes
 * Home Assistant actions or generated code.
 */
import { createReadStream, existsSync, mkdirSync, statSync } from "node:fs";
import { copyFile, readFile, rename, rm, writeFile } from "node:fs/promises";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import path from "node:path";
import { pathToFileURL } from "node:url";
import {
  InferenceRequestSchema, SafeIdSchema, WorkerCorpusRequestSchema, WorkerEvaluationRequestSchema,
  WorkerInitRequestSchema, WorkerTrainingRequestSchema,
  type BackendStatus, type InferenceResponse, type WorkerJobStatus,
} from "@assistant/shared";
import { z, ZodError, type ZodTypeAny } from "zod";
import { BlobMirror } from "./blob-mirror.js";
import { loadWorkerConfig, type WorkerConfig } from "./config.js";
import { JobQueue, JobStore } from "./jobs.js";
import { PythonModelCore, type ModelCore } from "./model-core.js";
import { OllamaClient } from "./ollama.js";

const OLLAMA_SYSTEM_PROMPT =
  "You are A.L.I.C.E., a private local assistant. Answer directly and helpfully. You cannot run code or take actions; " +
  "never claim that you did.";
const MAX_JSON_BYTES = 6 * 1024 * 1024;
const MAX_CHECKPOINT_BYTES = 512 * 1024 * 1024;

class HttpError extends Error {
  constructor(readonly status: number, message: string) { super(message); }
}

export interface WorkerDependencies {
  core?: ModelCore;
  ollama?: OllamaClient;
  blob?: BlobMirror | null;
  log?: (entry: Record<string, unknown>) => void;
}

export interface WorkerHandle {
  server: Server;
  queue: JobQueue;
  close(): Promise<void>;
}

function send(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
  res.end(JSON.stringify(body));
}

async function readRaw(req: IncomingMessage, limit: number): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > limit) throw new HttpError(413, "Request body is too large.");
    chunks.push(chunk as Buffer);
  }
  return Buffer.concat(chunks);
}

async function readJson<T extends ZodTypeAny>(req: IncomingMessage, schema: T): Promise<z.infer<T>> {
  const raw = (await readRaw(req, MAX_JSON_BYTES)).toString("utf8");
  let value: unknown;
  try { value = JSON.parse(raw || "{}"); } catch { throw new HttpError(400, "Request body must be valid JSON."); }
  return schema.parse(value);
}

export function createWorker(config: WorkerConfig, deps: WorkerDependencies = {}): WorkerHandle {
  for (const dir of [config.checkpointRoot, config.corpusRoot, config.datasetRoot, path.dirname(config.stateFile)]) mkdirSync(dir, { recursive: true });
  const core = deps.core ?? new PythonModelCore(config.python, config.modelCoreDir);
  const ollama = deps.ollama ?? new OllamaClient(config.ollama.baseUrl, config.ollama.model);
  const blob = deps.blob === undefined ? (config.azuriteConnectionString ? new BlobMirror(config.azuriteConnectionString) : null) : deps.blob;
  const log = deps.log ?? ((entry) => console.log(JSON.stringify(entry)));
  const jobs = new JobStore(config.stateFile);
  const queue = new JobQueue(config.maxQueuedJobs);
  const checkpointFile = (id: string) => path.join(config.checkpointRoot, `${SafeIdSchema.parse(id)}.pt`);
  const corpusFile = (id: string) => path.join(config.corpusRoot, `${SafeIdSchema.parse(id)}.txt`);
  const datasetFile = (id: string) => path.join(config.datasetRoot, `${SafeIdSchema.parse(id)}.txt`);
  const requireCheckpoint = (id: string) => {
    const file = checkpointFile(id);
    if (!existsSync(file)) throw new HttpError(404, "Checkpoint not found.");
    return file;
  };
  const mirror = (id: string) => {
    if (!blob) return;
    blob.upload(id, checkpointFile(id)).catch((error: Error) => log({ level: "warn", event: "blob.mirror_failed", checkpointId: id, message: error.message }));
  };

  async function inference(req: IncomingMessage): Promise<InferenceResponse> {
    const input = await readJson(req, InferenceRequestSchema);
    if (input.messages[input.messages.length - 1]?.role !== "user") throw new HttpError(422, "The last message must come from the user.");
    if (input.backend === "ollama") {
      if (!config.ollama.enabled) throw new HttpError(422, "The Ollama fallback is disabled (set OLLAMA_ENABLED=true to use it).");
      const model = input.model ?? config.ollama.model;
      const text = await ollama.chat([{ role: "system", content: OLLAMA_SYSTEM_PROMPT }, ...input.messages.filter((m) => m.role !== "system")], model)
        .catch((error: Error) => { throw new HttpError(503, `Ollama is unavailable: ${error.message}`); });
      return { requestId: input.requestId, generatedText: text, backend: "ollama", model };
    }
    if (!input.checkpointId) throw new HttpError(422, "A checkpoint is required for A.L.I.C.E.'s own model.");
    const file = requireCheckpoint(input.checkpointId);
    const text = await core.generate({ checkpoint: file, messages: input.messages, maxNewTokens: input.maxNewTokens });
    return { requestId: input.requestId, generatedText: text, backend: "local", model: input.checkpointId };
  }

  async function backends(): Promise<BackendStatus> {
    let models: string[] = [];
    let available = false;
    if (config.ollama.enabled) {
      try { models = await ollama.models(); available = true; } catch { available = false; }
    }
    const coreAvailable = existsSync(path.join(config.modelCoreDir, "model_bridge.py"));
    return {
      ollama: { available, baseUrl: config.ollama.enabled ? config.ollama.baseUrl : "", defaultModel: config.ollama.model, models },
      local: { available: coreAvailable, reason: coreAvailable ? null : `model_bridge.py not found in ${config.modelCoreDir}` },
      defaultBackend: "local",
    };
  }

  function startTraining(input: z.infer<typeof WorkerTrainingRequestSchema>): WorkerJobStatus {
    const existing = jobs.training(input.runId);
    if (existing) return existing;
    const corpora = [input.corpusId, ...(input.extraCorpusIds ?? [])].map(corpusFile);
    for (const file of corpora) if (!existsSync(file)) throw new HttpError(404, "Approved corpus not found on the worker.");
    let corpus = corpora[0];
    const base = input.baseCheckpointId ? requireCheckpoint(input.baseCheckpointId) : null;
    const checkpointId = input.checkpointId ?? `ckpt-${input.runId}`;
    const out = checkpointFile(checkpointId);
    if (existsSync(out)) throw new HttpError(409, "That checkpoint already exists.");
    const job: WorkerJobStatus = {
      runId: input.runId, baseCheckpointId: input.baseCheckpointId ?? null, status: "queued", step: 0, maxSteps: input.maxSteps,
      loss: null, checkpointId: null, config: null, error: null,
    };
    const accepted = queue.add(async () => {
      jobs.updateTraining(input.runId, { status: "running" });
      let lastSave = 0;
      try {
        if (corpora.length > 1) {
          corpus = path.join(config.corpusRoot, `.combined-${input.runId}.txt`);
          await writeFile(corpus, Buffer.concat(await Promise.all(corpora.map((file) => readFile(file)))));
        }
        const result = await core.train(
          { out, corpus, steps: input.maxSteps, base, config: base ? undefined : input.config, batchSize: input.config.batchSize },
          (step, loss) => {
            const now = Date.now();
            jobs.updateTraining(input.runId, { step, loss }, now - lastSave > 1_000);
            if (now - lastSave > 1_000) lastSave = now;
          },
        );
        jobs.updateTraining(input.runId, { status: "completed", step: input.maxSteps, loss: result.loss, checkpointId, config: result.config });
        mirror(checkpointId);
      } catch (error) {
        await rm(out, { force: true });
        jobs.updateTraining(input.runId, { status: "failed", error: (error as Error).message });
      } finally {
        if (corpus !== corpora[0]) await rm(corpus, { force: true });
      }
    });
    if (!accepted) throw new HttpError(409, "The model worker queue is full; try again later.");
    jobs.putTraining(job);
    return job;
  }

  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? "/", "http://worker");
    const method = req.method ?? "GET";
    const p = url.pathname;
    if (method === "GET" && p === "/health") return send(res, 200, { status: "healthy", queue: queue.size });
    if (method === "GET" && p === "/internal/v1/backends") return send(res, 200, await backends());
    if (method === "POST" && p === "/internal/v1/inference") return send(res, 200, await inference(req));
    if (method === "POST" && p === "/internal/v1/corpora") {
      const input = await readJson(req, WorkerCorpusRequestSchema);
      const targets = [
        ...(input.purpose !== "evaluation" ? [corpusFile(input.corpusId)] : []),
        ...(input.purpose !== "training" ? [datasetFile(input.corpusId)] : []),
      ];
      for (const target of targets) {
        const temporary = `${target}.tmp`;
        await writeFile(temporary, input.content, "utf8");
        await rename(temporary, target);
      }
      return send(res, 201, { corpusId: input.corpusId, purpose: input.purpose, bytes: Buffer.byteLength(input.content) });
    }
    if (method === "POST" && p === "/internal/v1/corpora/warm-start") {
      // The optional starter lessons that ship with the model core (alice/data/warm_start.txt).
      const { corpusId } = await readJson(req, z.object({ corpusId: SafeIdSchema }));
      const source = path.join(config.modelCoreDir, "alice", "data", "warm_start.txt");
      if (!existsSync(source)) throw new HttpError(404, "The warm-start lessons are not installed on the worker.");
      await copyFile(source, corpusFile(corpusId));
      await copyFile(source, datasetFile(corpusId));
      return send(res, 201, { corpusId, purpose: "both", bytes: statSync(source).size });
    }
    if (method === "POST" && p === "/internal/v1/checkpoints") {
      const input = await readJson(req, WorkerInitRequestSchema);
      const out = checkpointFile(input.checkpointId);
      if (existsSync(out)) throw new HttpError(409, "That checkpoint already exists.");
      const details = await core.init(out, input.config);
      mirror(input.checkpointId);
      return send(res, 201, { checkpointId: input.checkpointId, ...details });
    }
    const checkpointMatch = p.match(/^\/internal\/v1\/checkpoints\/([^/]+)(\/file)?$/);
    if (checkpointMatch) {
      const id = SafeIdSchema.parse(decodeURIComponent(checkpointMatch[1]));
      if (method === "GET" && !checkpointMatch[2]) return send(res, 200, { checkpointId: id, ...(await core.info(requireCheckpoint(id))) });
      if (method === "GET" && checkpointMatch[2]) {
        const file = requireCheckpoint(id);
        res.writeHead(200, { "content-type": "application/octet-stream", "content-length": statSync(file).size, "x-checkpoint-id": id });
        createReadStream(file).pipe(res);
        return;
      }
      if (method === "PUT" && checkpointMatch[2]) {
        const out = checkpointFile(id);
        if (existsSync(out)) throw new HttpError(409, "That checkpoint already exists.");
        const body = await readRaw(req, MAX_CHECKPOINT_BYTES);
        await writeFile(out, body);
        try {
          const details = await core.info(out); // validates with safe (weights-only) loading
          mirror(id);
          return send(res, 201, { checkpointId: id, ...details });
        } catch (error) {
          await rm(out, { force: true });
          throw new HttpError(422, `Not a valid A.L.I.C.E. checkpoint: ${(error as Error).message}`);
        }
      }
    }
    if (method === "POST" && p === "/internal/v1/training-runs") {
      const job = startTraining(await readJson(req, WorkerTrainingRequestSchema));
      return send(res, 202, { runId: job.runId, status: job.status });
    }
    const trainingMatch = p.match(/^\/internal\/v1\/training-runs\/([^/]+)$/);
    if (method === "GET" && trainingMatch) {
      const job = jobs.training(decodeURIComponent(trainingMatch[1]));
      if (!job) throw new HttpError(404, "Training run not found.");
      return send(res, 200, job);
    }
    if (method === "POST" && p === "/internal/v1/evaluations") {
      const input = await readJson(req, WorkerEvaluationRequestSchema);
      const existing = jobs.evaluation(input.evaluationId);
      if (existing) return send(res, 202, { evaluationId: existing.evaluationId, status: existing.status });
      const checkpoint = requireCheckpoint(input.checkpointId);
      const baseline = input.baselineCheckpointId ? requireCheckpoint(input.baselineCheckpointId) : null;
      const dataset = datasetFile(input.datasetId);
      if (!existsSync(dataset)) throw new HttpError(404, "Evaluation dataset not found on the worker.");
      const accepted = queue.add(async () => {
        jobs.updateEvaluation(input.evaluationId, { status: "running" });
        try {
          const metrics = await core.evaluate(checkpoint, dataset);
          const baselineMetrics = baseline ? { checkpointId: input.baselineCheckpointId!, ...(await core.evaluate(baseline, dataset)) } : null;
          jobs.updateEvaluation(input.evaluationId, { status: "completed", result: { ...metrics, baseline: baselineMetrics } });
        } catch (error) {
          jobs.updateEvaluation(input.evaluationId, { status: "failed", error: (error as Error).message });
        }
      });
      if (!accepted) throw new HttpError(409, "The model worker queue is full; try again later.");
      jobs.putEvaluation({ evaluationId: input.evaluationId, status: "queued", result: null, error: null });
      return send(res, 202, { evaluationId: input.evaluationId, status: "queued" });
    }
    const evaluationMatch = p.match(/^\/internal\/v1\/evaluations\/([^/]+)$/);
    if (method === "GET" && evaluationMatch) {
      const job = jobs.evaluation(decodeURIComponent(evaluationMatch[1]));
      if (!job) throw new HttpError(404, "Evaluation not found.");
      return send(res, 200, job);
    }
    throw new HttpError(404, "Route not found.");
  }

  const server = createServer((req, res) => {
    handle(req, res).catch((error: unknown) => {
      if (res.headersSent) { res.destroy(); return; }
      if (error instanceof ZodError) return send(res, 422, { error: "Request validation failed.", issues: error.issues });
      if (error instanceof HttpError) return send(res, error.status, { error: error.message });
      log({ level: "error", event: "worker.request_failed", path: req.url, message: (error as Error).message });
      send(res, 500, { error: (error as Error).message || "Model worker error." });
    });
  });
  server.requestTimeout = 0; // checkpoint uploads and generation can take a while

  return {
    server,
    queue,
    async close() {
      core.close();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

async function main(): Promise<void> {
  const config = loadWorkerConfig();
  const handle = createWorker(config);
  const blob = config.azuriteConnectionString ? new BlobMirror(config.azuriteConnectionString) : null;
  if (blob) await blob.ensureContainer().catch((error: Error) => console.warn(JSON.stringify({ level: "warn", event: "blob.container_unavailable", message: error.message })));
  handle.server.listen(config.port, config.host, () => {
    console.log(JSON.stringify({ level: "info", event: "worker.started", port: config.port, modelCoreDir: config.modelCoreDir, ollamaFallback: config.ollama.enabled }));
  });
  for (const signal of ["SIGINT", "SIGTERM"] as const) process.once(signal, () => { void handle.close().finally(() => process.exit(0)); });
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) void main();
