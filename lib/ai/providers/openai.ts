/**
 * OpenAI provider adapter (Phase 4 — the innermost adapter, Phase 0.5 §8).
 *
 * This file is the Phase 1-3 `lib/llm.ts` client, moved per the §323 module
 * tree and extended with (a) token usage capture (the `usage` field was
 * discarded before — §24) and (b) timeout/abort. Policy (budgets, rate
 * limits, retries, fallback, ledger) lives in the gateway, NOT here.
 *
 * `lib/llm.ts` remains as a re-export shim for one phase so any straggler
 * import keeps compiling; the call-site grep test forbids NEW provider
 * imports anywhere outside lib/ai.
 */
import {
  type ChatMessage,
  type CompletionResult,
  type EmbedResult,
  type ProviderClient,
  ProviderHttpError,
} from "../types";

export type { ChatMessage, LLMClient } from "../types";

export const DEFAULT_CHAT_MODEL = "gpt-4o-mini";
export const DEFAULT_EMBED_MODEL = "text-embedding-3-small";

function requireKey(): string {
  const key = process.env.OPENAI_API_KEY;
  if (!key) throw new Error("OPENAI_API_KEY not set");
  return key;
}

/** Compose an internal timeout with an optional external abort signal. */
function withTimeout(timeoutMs: number | undefined, external?: AbortSignal): { signal: AbortSignal; done(): void } {
  const ctrl = new AbortController();
  let timer: NodeJS.Timeout | undefined;
  if (timeoutMs && timeoutMs > 0) {
    timer = setTimeout(() => ctrl.abort(new Error(`llm timeout after ${timeoutMs}ms`)), timeoutMs);
  }
  if (external) {
    if (external.aborted) ctrl.abort(external.reason);
    else external.addEventListener("abort", () => ctrl.abort(external.reason), { once: true });
  }
  return { signal: ctrl.signal, done: () => timer && clearTimeout(timer) };
}

/** OpenAI error bodies carry { error: { message, code, type } }. */
async function toProviderError(res: Response): Promise<ProviderHttpError> {
  let detail = "";
  let code = `http_${res.status}`;
  try {
    const body = (await res.json()) as { error?: { message?: string; code?: string } };
    detail = body?.error?.message ?? JSON.stringify(body).slice(0, 200);
    if (body?.error?.code) code = body.error.code;
  } catch {
    detail = res.statusText;
  }
  return new ProviderHttpError(res.status, code, detail);
}

export function makeOpenAI(fetchImpl: typeof fetch = fetch): ProviderClient {
  return {
    async complete(messages, opts = {}) {
      const out = await this.completeWithUsage(messages, opts);
      return out.content;
    },

    async completeWithUsage(messages, opts = {}) {
      const apiKey = requireKey();
      const model = opts.model ?? process.env.OPENAI_MODEL ?? DEFAULT_CHAT_MODEL;
      const { signal, done } = withTimeout(opts.timeoutMs);
      try {
        const res = await fetchImpl("https://api.openai.com/v1/chat/completions", {
          method: "POST",
          headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
          body: JSON.stringify({ model, temperature: opts.temperature ?? 0.7, messages }),
          signal,
        });
        if (!res.ok) throw await toProviderError(res);
        const json = (await res.json()) as {
          model?: string;
          choices: { message: { content: string } }[];
          usage?: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number };
        };
        return {
          content: json.choices[0]?.message?.content ?? "",
          model: json.model ?? model,
          usage: {
            promptTokens: json.usage?.prompt_tokens ?? null,
            completionTokens: json.usage?.completion_tokens ?? null,
            totalTokens: json.usage?.total_tokens ?? null,
          },
        };
      } finally {
        done();
      }
    },

    async embed(texts) {
      const out = await this.embedWithUsage(texts);
      return out.vectors;
    },

    async embedWithUsage(texts, opts = {}) {
      const apiKey = requireKey();
      const model = opts.model ?? process.env.OPENAI_EMBEDDINGS_MODEL ?? DEFAULT_EMBED_MODEL;
      const { signal, done } = withTimeout(opts.timeoutMs);
      try {
        const res = await fetchImpl("https://api.openai.com/v1/embeddings", {
          method: "POST",
          headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
          body: JSON.stringify({ model, input: texts }),
          signal,
        });
        if (!res.ok) throw await toProviderError(res);
        const json = (await res.json()) as {
          model?: string;
          data: { embedding: number[] }[];
          usage?: { prompt_tokens?: number; total_tokens?: number };
        };
        return {
          vectors: json.data.map((d) => d.embedding),
          model: json.model ?? model,
          usage: { promptTokens: json.usage?.prompt_tokens ?? json.usage?.total_tokens ?? null },
        };
      } finally {
        done();
      }
    },
  };
}

/** Production singleton — imported ONLY by the gateway (grep-enforced). */
export const openai: ProviderClient = makeOpenAI();
