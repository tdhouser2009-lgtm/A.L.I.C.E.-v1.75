import type { IncomingMessage } from "node:http";
import { Readable } from "node:stream";
import {
  ErrorCode,
  type BackendStatus, type InferenceResponse, type WorkerCheckpointInfo, type WorkerEvaluationAccepted,
  type WorkerEvaluationStatus, type WorkerJobAccepted, type WorkerJobStatus,
} from "@assistant/shared";
import { AppError } from "./errors.js";

/** Client for the private model worker. Errors are mapped to public API errors. */
export class WorkerClient {
  constructor(private readonly baseUrl: string, private readonly fetchImpl: typeof fetch = fetch) {}

  private async raw(path: string, init?: RequestInit & { duplex?: "half" }, timeoutMs = 30_000): Promise<Response> {
    let response: Response;
    try {
      response = await this.fetchImpl(new URL(path, this.baseUrl), { ...init, signal: AbortSignal.timeout(timeoutMs) });
    } catch {
      throw new AppError(ErrorCode.SERVICE_UNAVAILABLE, "The model worker is unavailable.", 503);
    }
    if (!response.ok) {
      let detail = "";
      try { detail = String(((await response.json()) as { error?: unknown }).error ?? ""); } catch { /* ignore */ }
      if (response.status === 404) throw new AppError(ErrorCode.NOT_FOUND, detail || "Model item not found.", 404);
      if (response.status === 409) throw new AppError(ErrorCode.CONFLICT, detail || "The model worker is at capacity or the request conflicts with existing work.", 409);
      if (response.status === 422) throw new AppError(ErrorCode.VALIDATION_ERROR, detail || "The model worker rejected the request.", 422);
      throw new AppError(ErrorCode.SERVICE_UNAVAILABLE, detail || `The model worker returned HTTP ${response.status}.`, 503);
    }
    return response;
  }

  private async request<T>(path: string, init?: RequestInit, timeoutMs?: number): Promise<T> {
    const response = await this.raw(path, { ...init, headers: { "content-type": "application/json", ...init?.headers } }, timeoutMs);
    return (await response.json()) as T;
  }

  private post<T>(path: string, body: unknown, timeoutMs?: number): Promise<T> {
    return this.request<T>(path, { method: "POST", body: JSON.stringify(body) }, timeoutMs);
  }

  health(): Promise<{ status: string }> { return this.request("/health", undefined, 2_000); }
  backends(): Promise<BackendStatus> { return this.request("/internal/v1/backends", undefined, 5_000); }
  inference(input: unknown): Promise<InferenceResponse> { return this.post("/internal/v1/inference", input, 150_000); }
  writeCorpus(input: { corpusId: string; purpose: string; content: string }): Promise<{ bytes: number }> { return this.post("/internal/v1/corpora", input); }
  writeWarmStart(corpusId: string): Promise<{ bytes: number }> { return this.post("/internal/v1/corpora/warm-start", { corpusId }); }
  initCheckpoint(input: { checkpointId: string; config?: unknown }): Promise<WorkerCheckpointInfo> { return this.post("/internal/v1/checkpoints", input, 60_000); }
  checkpointInfo(id: string): Promise<WorkerCheckpointInfo> { return this.request(`/internal/v1/checkpoints/${encodeURIComponent(id)}`, undefined, 60_000); }
  createTraining(input: unknown): Promise<WorkerJobAccepted> { return this.post("/internal/v1/training-runs", input); }
  training(runId: string): Promise<WorkerJobStatus> { return this.request(`/internal/v1/training-runs/${encodeURIComponent(runId)}`); }
  createEvaluation(input: unknown): Promise<WorkerEvaluationAccepted> { return this.post("/internal/v1/evaluations", input); }
  evaluation(id: string): Promise<WorkerEvaluationStatus> { return this.request(`/internal/v1/evaluations/${encodeURIComponent(id)}`); }

  /** Streams a checkpoint file from the worker. */
  async downloadCheckpoint(id: string): Promise<{ stream: Readable; size: number | null }> {
    const response = await this.raw(`/internal/v1/checkpoints/${encodeURIComponent(id)}/file`, undefined, 300_000);
    const size = Number(response.headers.get("content-length"));
    return { stream: Readable.fromWeb(response.body as never), size: Number.isFinite(size) ? size : null };
  }

  /** Streams an uploaded checkpoint to the worker, which validates it before accepting. */
  uploadCheckpoint(id: string, body: IncomingMessage): Promise<WorkerCheckpointInfo> {
    return this.raw(`/internal/v1/checkpoints/${encodeURIComponent(id)}/file`, {
      method: "PUT",
      body: Readable.toWeb(body) as never,
      duplex: "half",
      headers: { "content-type": "application/octet-stream" },
    }, 300_000).then((response) => response.json() as Promise<WorkerCheckpointInfo>);
  }
}
