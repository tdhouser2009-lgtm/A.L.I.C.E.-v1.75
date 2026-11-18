import { mkdtempSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { AddressInfo } from "node:net";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { WorkerConfig } from "../src/config.js";
import { loadWorkerConfig } from "../src/config.js";
import type { ModelCore } from "../src/model-core.js";
import { OllamaClient } from "../src/ollama.js";
import { createWorker, type WorkerHandle } from "../src/worker.js";

const CONFIG = { blockSize: 16, layers: 1, heads: 2, embeddingSize: 16 };

class FakeCore implements ModelCore {
  generated: Array<{ checkpoint: string; messages: unknown[] }> = [];
  failTraining = false;
  async init(out: string) { writeFileSync(out, "weights"); return { config: CONFIG, parameters: 123, totalSteps: 0 }; }
  async train(options: { out: string; steps: number }, onProgress: (step: number, loss: number) => void) {
    if (this.failTraining) throw new Error("boom");
    onProgress(1, 5.5);
    writeFileSync(options.out, "trained");
    return { loss: 4.2, config: CONFIG, totalSteps: options.steps };
  }
  async evaluate(checkpoint: string) { return { loss: checkpoint.includes("base") ? 5 : 4, perplexity: 50, bytesEvaluated: 64 }; }
  async info() { return { config: CONFIG, parameters: 123, totalSteps: 3 }; }
  async generate(input: { checkpoint: string; messages: unknown[] }) { this.generated.push(input); return "hello from alice"; }
  close() {}
}

let directory: string;
let handle: WorkerHandle;
let base: string;
let core: FakeCore;

function config(overrides: Partial<WorkerConfig> = {}): WorkerConfig {
  return {
    port: 0, host: "127.0.0.1",
    checkpointRoot: path.join(directory, "checkpoints"), corpusRoot: path.join(directory, "corpora"),
    datasetRoot: path.join(directory, "datasets"), stateFile: path.join(directory, "state.json"),
    modelCoreDir: path.resolve("../.."), python: "python3",
    ollama: { enabled: false, baseUrl: "http://127.0.0.1:9", model: "test" }, azuriteConnectionString: null, maxQueuedJobs: 5,
    ...overrides,
  };
}

async function start(overrides: Partial<WorkerConfig> = {}, ollama?: OllamaClient) {
  core = new FakeCore();
  handle = createWorker(config(overrides), { core, ollama, blob: null, log: () => undefined });
  await new Promise<void>((resolve) => handle.server.listen(0, "127.0.0.1", resolve));
  base = `http://127.0.0.1:${(handle.server.address() as AddressInfo).port}`;
}

const post = (p: string, body: unknown) => fetch(`${base}${p}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });

beforeEach(() => { directory = mkdtempSync(path.join(tmpdir(), "worker-")); });
afterEach(async () => { await handle?.close(); rmSync(directory, { recursive: true, force: true }); });

describe("model worker", () => {
  it("reports health and that its own model is the default backend", async () => {
    await start();
    expect((await fetch(`${base}/health`)).status).toBe(200);
    const backends = await (await fetch(`${base}/internal/v1/backends`)).json();
    expect(backends.defaultBackend).toBe("local");
    expect(backends.local.available).toBe(true);
    expect(backends.ollama.available).toBe(false);
  });

  it("creates an untrained checkpoint and chats with it, passing the conversation history", async () => {
    await start();
    const created = await post("/internal/v1/checkpoints", { checkpointId: "alice-initial", config: {} });
    expect(created.status).toBe(201);
    expect((await post("/internal/v1/checkpoints", { checkpointId: "alice-initial" })).status).toBe(409);
    const messages = [{ role: "user", content: "hi" }, { role: "assistant", content: "yo" }, { role: "user", content: "again" }];
    const reply = await post("/internal/v1/inference", { requestId: "r1", messages, checkpointId: "alice-initial" });
    expect(reply.status).toBe(200);
    expect(await reply.json()).toMatchObject({ generatedText: "hello from alice", backend: "local", model: "alice-initial" });
    expect(core.generated[0].messages).toEqual(messages);
  });

  it("rejects unsafe ids, missing checkpoints, and a disabled Ollama fallback", async () => {
    await start();
    expect((await post("/internal/v1/inference", { requestId: "r", messages: [{ role: "user", content: "x" }], checkpointId: "../etc" })).status).toBe(422);
    expect((await post("/internal/v1/inference", { requestId: "r", messages: [{ role: "user", content: "x" }], checkpointId: "missing" })).status).toBe(404);
    expect((await post("/internal/v1/inference", { requestId: "r", messages: [{ role: "user", content: "x" }], backend: "ollama" })).status).toBe(422);
  });

  it("uses Ollama only when explicitly enabled", async () => {
    const fakeFetch = (async (url: string) => {
      if (String(url).endsWith("/api/tags")) return new Response(JSON.stringify({ models: [{ name: "qwen" }] }));
      return new Response(JSON.stringify({ message: { content: "from ollama" } }));
    }) as typeof fetch;
    await start({ ollama: { enabled: true, baseUrl: "http://ollama", model: "qwen" } }, new OllamaClient("http://ollama", "qwen", fakeFetch));
    const reply = await post("/internal/v1/inference", { requestId: "r", messages: [{ role: "user", content: "x" }], backend: "ollama" });
    expect(await reply.json()).toMatchObject({ generatedText: "from ollama", backend: "ollama" });
  });

  it("trains a new candidate from a base checkpoint, reports the real config, and evaluates against the base", async () => {
    await start();
    await post("/internal/v1/checkpoints", { checkpointId: "base", config: {} });
    expect((await post("/internal/v1/corpora", { corpusId: "c1", purpose: "both", content: "User: a\nAlice: b\n\n" })).status).toBe(201);
    const runId = "7c1f0b9a-8b55-4f24-9d0e-1f6f1b2b3c4d";
    const accepted = await post("/internal/v1/training-runs", { runId, corpusId: "c1", maxSteps: 3, baseCheckpointId: "base", checkpointId: "cand" });
    expect(accepted.status).toBe(202);
    await handle.queue.idle();
    const status = await (await fetch(`${base}/internal/v1/training-runs/${runId}`)).json();
    expect(status).toMatchObject({ status: "completed", checkpointId: "cand", baseCheckpointId: "base", config: CONFIG });
    const evaluationId = "0c9a3a4e-6f8d-4b3a-9a5c-2d1e0f9b8a7c";
    await post("/internal/v1/evaluations", { evaluationId, checkpointId: "cand", datasetId: "c1", baselineCheckpointId: "base" });
    await handle.queue.idle();
    const evaluation = await (await fetch(`${base}/internal/v1/evaluations/${evaluationId}`)).json();
    expect(evaluation.status).toBe("completed");
    expect(evaluation.result.loss).toBe(4);
    expect(evaluation.result.baseline).toMatchObject({ checkpointId: "base", loss: 5 });
  });

  it("records failed training and removes the partial checkpoint", async () => {
    await start();
    await post("/internal/v1/corpora", { corpusId: "c2", purpose: "training", content: "abc" });
    core.failTraining = true;
    const runId = "1c1f0b9a-8b55-4f24-9d0e-1f6f1b2b3c4d";
    await post("/internal/v1/training-runs", { runId, corpusId: "c2", maxSteps: 3, checkpointId: "broken" });
    await handle.queue.idle();
    const status = await (await fetch(`${base}/internal/v1/training-runs/${runId}`)).json();
    expect(status).toMatchObject({ status: "failed", error: "boom" });
    expect(existsSync(path.join(directory, "checkpoints", "broken.pt"))).toBe(false);
  });

  it("serves checkpoint files for download and accepts validated uploads", async () => {
    await start();
    await post("/internal/v1/checkpoints", { checkpointId: "dl", config: {} });
    const download = await fetch(`${base}/internal/v1/checkpoints/dl/file`);
    expect(download.headers.get("x-checkpoint-id")).toBe("dl");
    expect(await download.text()).toBe("weights");
    const upload = await fetch(`${base}/internal/v1/checkpoints/imported/file`, { method: "PUT", body: "bytes" });
    expect(upload.status).toBe(201);
  });

  it("marks in-flight jobs failed after a restart", async () => {
    writeFileSync(path.join(directory, "state.json"), JSON.stringify({ training: { x: { runId: "x", status: "running" } }, evaluations: {} }));
    await start();
    const status = await (await fetch(`${base}/internal/v1/training-runs/x`)).json();
    expect(status.status).toBe("failed");
  });
});

describe("worker configuration", () => {
  it("keeps the Ollama fallback off by default", () => {
    expect(loadWorkerConfig({}).ollama.enabled).toBe(false);
    expect(loadWorkerConfig({ OLLAMA_ENABLED: "true" }).ollama.enabled).toBe(true);
  });
});

const python = process.env.ALICE_TEST_PYTHON;
describe.skipIf(!python)("with the real Python model core", () => {
  it("initializes, trains, evaluates, and generates", async () => {
    const { PythonModelCore } = await import("../src/model-core.js");
    const real = new PythonModelCore(python!, path.resolve("../.."));
    const dir = mkdtempSync(path.join(tmpdir(), "core-"));
    try {
      const init = await real.init(path.join(dir, "a.pt"), CONFIG);
      expect(init.config).toEqual(CONFIG);
      writeFileSync(path.join(dir, "c.txt"), "User: hi\nAlice: hello\n\n".repeat(4));
      const steps: number[] = [];
      const trained = await real.train({ out: path.join(dir, "b.pt"), base: path.join(dir, "a.pt"), corpus: path.join(dir, "c.txt"), steps: 2, batchSize: 2 }, (s) => steps.push(s));
      expect(trained.config).toEqual(CONFIG);
      expect(steps.length).toBeGreaterThan(0);
      const metrics = await real.evaluate(path.join(dir, "b.pt"), path.join(dir, "c.txt"));
      expect(metrics.loss).toBeGreaterThan(0);
      const text = await real.generate({ checkpoint: path.join(dir, "b.pt"), messages: [{ role: "user", content: "hi" }], maxNewTokens: 4 });
      expect(typeof text).toBe("string");
    } finally {
      real.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
