import type { ChatMessage } from "@assistant/shared";

/** Optional developer fallback; disabled unless OLLAMA_ENABLED=true. */
export class OllamaClient {
  constructor(readonly baseUrl: string, readonly defaultModel: string, private readonly fetchImpl: typeof fetch = fetch) {}

  async models(): Promise<string[]> {
    const response = await this.fetchImpl(`${this.baseUrl}/api/tags`, { signal: AbortSignal.timeout(3_000) });
    if (!response.ok) throw new Error(`Ollama returned HTTP ${response.status}`);
    const body = (await response.json()) as { models?: Array<{ name?: string }> };
    return (body.models ?? []).map((item) => item.name ?? "").filter(Boolean);
  }

  async chat(messages: ChatMessage[], model = this.defaultModel): Promise<string> {
    const response = await this.fetchImpl(`${this.baseUrl}/api/chat`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model, messages, stream: false, options: { num_ctx: 4096, num_predict: 1024 } }),
      signal: AbortSignal.timeout(300_000),
    });
    if (!response.ok) throw new Error(`Ollama returned HTTP ${response.status}`);
    const body = (await response.json()) as { message?: { content?: string } };
    const text = body.message?.content?.trim() ?? "";
    if (!text) throw new Error("Ollama returned an empty response.");
    return text;
  }
}
