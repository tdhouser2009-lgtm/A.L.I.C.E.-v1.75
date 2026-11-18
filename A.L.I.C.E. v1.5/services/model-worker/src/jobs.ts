import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { WorkerEvaluationStatus, WorkerJobStatus } from "@assistant/shared";

interface State {
  training: Record<string, WorkerJobStatus>;
  evaluations: Record<string, WorkerEvaluationStatus>;
}

/** Job state persisted to a JSON file so the API can poll it after worker restarts. */
export class JobStore {
  private state: State = { training: {}, evaluations: {} };

  constructor(private readonly file: string) {
    try {
      this.state = JSON.parse(readFileSync(file, "utf8")) as State;
      this.state.training ??= {};
      this.state.evaluations ??= {};
    } catch {
      this.state = { training: {}, evaluations: {} };
    }
    // Work that was in flight when the worker stopped cannot resume.
    for (const job of Object.values(this.state.training)) {
      if (job.status === "queued" || job.status === "running") Object.assign(job, { status: "failed", error: "The model worker restarted before this run finished." });
    }
    for (const job of Object.values(this.state.evaluations)) {
      if (job.status === "queued" || job.status === "running") Object.assign(job, { status: "failed", error: "The model worker restarted before this evaluation finished." });
    }
    this.save();
  }

  training(id: string): WorkerJobStatus | undefined { return this.state.training[id]; }
  evaluation(id: string): WorkerEvaluationStatus | undefined { return this.state.evaluations[id]; }

  putTraining(job: WorkerJobStatus): void { this.state.training[job.runId] = job; this.save(); }
  putEvaluation(job: WorkerEvaluationStatus): void { this.state.evaluations[job.evaluationId] = job; this.save(); }

  updateTraining(id: string, patch: Partial<WorkerJobStatus>, persist = true): void {
    const job = this.state.training[id];
    if (!job) return;
    Object.assign(job, patch);
    if (persist) this.save();
  }

  updateEvaluation(id: string, patch: Partial<WorkerEvaluationStatus>): void {
    const job = this.state.evaluations[id];
    if (!job) return;
    Object.assign(job, patch);
    this.save();
  }

  save(): void {
    mkdirSync(path.dirname(this.file), { recursive: true });
    const temporary = `${this.file}.tmp`;
    writeFileSync(temporary, JSON.stringify(this.state));
    renameSync(temporary, this.file);
  }
}

/** Runs CPU-heavy model jobs one at a time, in order. */
export class JobQueue {
  private readonly queue: Array<() => Promise<void>> = [];
  private running = false;

  constructor(private readonly limit: number) {}

  get size(): number { return this.queue.length + (this.running ? 1 : 0); }

  add(job: () => Promise<void>): boolean {
    if (this.size >= this.limit) return false;
    this.queue.push(job);
    void this.drain();
    return true;
  }

  async idle(): Promise<void> {
    while (this.size > 0) await new Promise((resolve) => setTimeout(resolve, 20));
  }

  private async drain(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      while (this.queue.length) {
        const job = this.queue.shift()!;
        try { await job(); } catch { /* each job records its own failure */ }
      }
    } finally {
      this.running = false;
    }
  }
}
