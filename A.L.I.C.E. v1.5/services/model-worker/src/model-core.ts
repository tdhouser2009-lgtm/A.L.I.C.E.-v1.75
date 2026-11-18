/**
 * Adapter to A.L.I.C.E.'s Python/PyTorch model core (model_bridge.py in the project root).
 * One-off commands (init/train/evaluate/info) run as child processes; chat generation uses a
 * long-lived `serve` process so models stay loaded between messages.
 */
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import path from "node:path";
import readline from "node:readline";
import type { ChatMessage, CheckpointConfig, EvaluationMetrics, ModelArchitecture } from "@assistant/shared";

export interface CheckpointDetails {
  config: CheckpointConfig;
  parameters: number;
  totalSteps: number;
}

export interface TrainOptions {
  out: string;
  corpus: string;
  steps: number;
  base?: string | null;
  config?: ModelArchitecture;
  batchSize?: number;
}

export interface ModelCore {
  init(out: string, config: ModelArchitecture): Promise<CheckpointDetails>;
  train(options: TrainOptions, onProgress: (step: number, loss: number) => void): Promise<{ loss: number; config: CheckpointConfig; totalSteps: number }>;
  evaluate(checkpoint: string, dataset: string): Promise<EvaluationMetrics>;
  info(checkpoint: string): Promise<CheckpointDetails>;
  generate(input: { checkpoint: string; messages: ChatMessage[]; maxNewTokens?: number }): Promise<string>;
  close(): void;
}

type BridgeEvent = Record<string, unknown> & { event?: string };

export class PythonModelCore implements ModelCore {
  private server: ChildProcessWithoutNullStreams | null = null;
  private ready: Promise<void> | null = null;
  private nextId = 1;
  private readonly pending = new Map<string, { resolve: (text: string) => void; reject: (error: Error) => void }>();

  constructor(private readonly python: string, private readonly coreDir: string) {}

  private get script(): string {
    return path.join(this.coreDir, "model_bridge.py");
  }

  private env(): NodeJS.ProcessEnv {
    return { ...process.env, PYTHONPATH: [this.coreDir, process.env.PYTHONPATH].filter(Boolean).join(path.delimiter), PYTHONUNBUFFERED: "1" };
  }

  /** Runs one bridge command and resolves with its final `done` event. */
  run(args: string[], onEvent?: (event: BridgeEvent) => void): Promise<BridgeEvent> {
    return new Promise((resolve, reject) => {
      const child = spawn(this.python, [this.script, ...args], { cwd: this.coreDir, env: this.env() });
      let final: BridgeEvent | null = null;
      let stderr = "";
      child.stderr.on("data", (chunk: Buffer) => { stderr = (stderr + chunk.toString()).slice(-4_000); });
      readline.createInterface({ input: child.stdout }).on("line", (line) => {
        let event: BridgeEvent;
        try { event = JSON.parse(line) as BridgeEvent; } catch { return; }
        if (event.event === "done" || event.event === "error") final = event;
        else onEvent?.(event);
      });
      child.on("error", (error) => reject(new Error(`Could not start the Python model core (${this.python}): ${error.message}`)));
      child.on("close", (code) => {
        const result = final as BridgeEvent | null;
        if (result?.event === "done" && code === 0) resolve(result);
        else reject(new Error(String(result?.error ?? (stderr.trim().split("\n").pop() || `model core exited with code ${code}`))));
      });
    });
  }

  async init(out: string, config: ModelArchitecture): Promise<CheckpointDetails> {
    const result = await this.run(["init", "--out", out, "--config", JSON.stringify(config)]);
    return { config: result.config as CheckpointConfig, parameters: Number(result.parameters), totalSteps: 0 };
  }

  async train(options: TrainOptions, onProgress: (step: number, loss: number) => void) {
    const args = ["train", "--out", options.out, "--corpus", options.corpus, "--steps", String(options.steps)];
    if (options.base) args.push("--base", options.base);
    if (options.config && Object.keys(options.config).length) args.push("--config", JSON.stringify(options.config));
    if (options.batchSize) args.push("--batch-size", String(options.batchSize));
    const result = await this.run(args, (event) => {
      if (event.event === "progress") onProgress(Number(event.step), Number(event.loss));
    });
    return { loss: Number(result.loss), config: result.config as CheckpointConfig, totalSteps: Number(result.totalSteps) };
  }

  async evaluate(checkpoint: string, dataset: string): Promise<EvaluationMetrics> {
    const result = await this.run(["evaluate", "--checkpoint", checkpoint, "--dataset", dataset]);
    return { loss: Number(result.loss), perplexity: Number(result.perplexity), bytesEvaluated: Number(result.bytesEvaluated) };
  }

  async info(checkpoint: string): Promise<CheckpointDetails> {
    const result = await this.run(["info", "--checkpoint", checkpoint]);
    return { config: result.config as CheckpointConfig, parameters: Number(result.parameters), totalSteps: Number(result.totalSteps) };
  }

  private startServer(): Promise<void> {
    if (this.ready) return this.ready;
    this.ready = new Promise((resolve, reject) => {
      const child = spawn(this.python, [this.script, "serve"], { cwd: this.coreDir, env: this.env() });
      this.server = child;
      let started = false;
      child.stderr.on("data", () => undefined);
      readline.createInterface({ input: child.stdout }).on("line", (line) => {
        let message: Record<string, unknown>;
        try { message = JSON.parse(line) as Record<string, unknown>; } catch { return; }
        if (message.event === "ready") { started = true; resolve(); return; }
        const waiter = this.pending.get(String(message.id));
        if (!waiter) return;
        this.pending.delete(String(message.id));
        if (message.ok) waiter.resolve(String(message.text ?? ""));
        else waiter.reject(new Error(String(message.error ?? "Generation failed.")));
      });
      const fail = (error: Error) => {
        this.server = null;
        this.ready = null;
        for (const waiter of this.pending.values()) waiter.reject(error);
        this.pending.clear();
        if (!started) reject(error);
      };
      child.on("error", (error) => fail(new Error(`Could not start the Python model core: ${error.message}`)));
      child.on("exit", (code) => fail(new Error(`The model core stopped (exit code ${code}).`)));
    });
    return this.ready;
  }

  async generate(input: { checkpoint: string; messages: ChatMessage[]; maxNewTokens?: number }): Promise<string> {
    await this.startServer();
    const id = String(this.nextId++);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error("The model core timed out while generating a reply."));
      }, 120_000);
      this.pending.set(id, {
        resolve: (text) => { clearTimeout(timer); resolve(text); },
        reject: (error) => { clearTimeout(timer); reject(error); },
      });
      this.server?.stdin.write(`${JSON.stringify({ id, op: "generate", checkpoint: input.checkpoint, messages: input.messages, maxNewTokens: input.maxNewTokens ?? 240 })}\n`);
    });
  }

  close(): void {
    this.server?.kill();
    this.server = null;
    this.ready = null;
  }
}
