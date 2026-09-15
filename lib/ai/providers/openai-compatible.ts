/**
 * OpenAI-compatible provider factory (Phase 10.5 — free-tier enablement).
 *
 * Most inference gateways (Google Gemini's OpenAI-compat layer, Groq,
 * OpenRouter, vLLM/LiteLLM self-hosts) expose the OpenAI chat-completions +
 * embeddings wire protocol. One parameterized adapter covers them all: the
 * OpenAI adapter (openai.ts) is the zero-config instance of this factory,
 * and free providers are pure composition-root config (resolve.ts) — no
 * call-site or gateway changes (Phase 0.5 §8 module tree holds).
 *
 * Embeddings safety: the platform's vector column is vector(1536).
 * Providers whose default embedding width differs are handled two ways:
 *   (a) request `dimensions: 1536` when the provider supports the parameter
 *       (Gemini gemini-embedding-001 does);
 *   (b) Matryoshka (MRL) fallback — MRL-trained embeddings are DESIGNED to
 *       be truncated to a lower width, so an oversized vector is truncated
 *       to 1536 and L2-renormalized. Undersized vectors fail loudly (they
 *       cannot be padded without corrupting retrieval semantics).
 */
import {
  type CompletionResult,
  type EmbedResult,
  type ProviderClient,
  ProviderHttpError,
} from "../types";

export type { ChatMessage, LLMClient } from "../types";
import type { ChatMessage } from "../types";

export interface OpenAICompatibleConfig {
  /** Ledger name in llm_requests.provider (e.g. "gemini", "groq"). */
  provider: string;
  /** OpenAI-compatible root WITHOUT trailing slash (e.g. https://api.groq.com/openai/v1). */
  baseUrl: string;
  /** Lazy key resolver — resolves at call time so a missing key never breaks module load. */
  apiKey: () => string;
  defaultChatModel: string;
  /** null = provider serves no embeddings → embed() fails with an actionable error. */
  defaultEmbedModel: string | null;
  /** Provider-specific model env overrides, read at call time. */
  chatModelEnv?: string;
  embedModelEnv?: string;
  /** Message shown when the provider serves no embeddings (RAG guidance). */
  embedUnsupportedMessage?: string;
  /** Request a specific embedding width when the provider supports `dimensions`. */
  embedDimensions?: number;
  /** MRL truncate target: trim+renormalize vectors wider than this (vector(1536) column). */
  embedTargetDim?: number;
  /** Extra headers (OpenRouter expects app attribution; harmless elsewhere). */
  extraHeaders?: Record<string, string>;
}

/** First non-empty env var among `names`; throws listing every accepted name. */
export function requireEnv(...names: string[]): string {
  for (const n of names) {
    const v = process.env[n];
    if (v && v.trim()) return v.trim();
  }
  throw new Error(`missing API key: set ${names.join(" or ")}`);
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

/** OpenAI-protocol error bodies carry { error: { message, code } }. */
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

/** L2-renormalize a vector (cosine space) after MRL truncation. */
function l2Normalize(v: number[]): number[] {
  let sq = 0;
  for (const x of v) sq += x * x;
  const norm = Math.sqrt(sq);
  return norm === 0 ? v : v.map((x) => x / norm);
}

export function makeOpenAICompatible(cfg: OpenAICompatibleConfig, fetchImpl: typeof fetch = fetch): ProviderClient {
  function chatModel(opts?: { model?: string }): string {
    const envModel = cfg.chatModelEnv ? process.env[cfg.chatModelEnv] : undefined;
    return opts?.model ?? (envModel && envModel.trim() ? envModel.trim() : undefined) ?? cfg.defaultChatModel;
  }

  function embedModel(opts?: { model?: string }): string {
    const envModel = cfg.embedModelEnv ? process.env[cfg.embedModelEnv] : undefined;
    const m =
      opts?.model ??
      (envModel && envModel.trim() ? envModel.trim() : undefined) ??
      cfg.defaultEmbedModel;
    if (!m) {
      throw new Error(
        cfg.embedUnsupportedMessage ??
          `provider "${cfg.provider}" does not serve an embeddings model; RAG/knowledge needs one — use a provider with embeddings (e.g. LLM_PROVIDER=gemini)`
      );
    }
    return m;
  }

  const headers = (): Record<string, string> => ({
    "Content-Type": "application/json",
    Authorization: `Bearer ${cfg.apiKey()}`,
    ...(cfg.extraHeaders ?? {}),
  });

  return {
    async complete(messages: ChatMessage[], opts = {}) {
      const out = await this.completeWithUsage(messages, opts);
      return out.content;
    },

    async completeWithUsage(messages, opts = {}): Promise<CompletionResult> {
      const model = chatModel(opts);
      const { signal, done } = withTimeout(opts.timeoutMs);
      try {
        const res = await fetchImpl(`${cfg.baseUrl}/chat/completions`, {
          method: "POST",
          headers: headers(),
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

    async embed(texts: string[]) {
      const out = await this.embedWithUsage(texts);
      return out.vectors;
    },

    async embedWithUsage(texts, opts = {}): Promise<EmbedResult> {
      const model = embedModel(opts);
      const { signal, done } = withTimeout(opts.timeoutMs);
      try {
        const res = await fetchImpl(`${cfg.baseUrl}/embeddings`, {
          method: "POST",
          headers: headers(),
          body: JSON.stringify({
            model,
            input: texts,
            ...(cfg.embedDimensions ? { dimensions: cfg.embedDimensions } : {}),
          }),
          signal,
        });
        if (!res.ok) throw await toProviderError(res);
        const json = (await res.json()) as {
          model?: string;
          data: { embedding: number[] }[];
          usage?: { prompt_tokens?: number; total_tokens?: number };
        };
        let vectors = json.data.map((d) => d.embedding);
        const targetDim = cfg.embedTargetDim;
        if (targetDim) {
          vectors = vectors.map((v) => {
            if (v.length === targetDim) return v;
            if (v.length > targetDim) return l2Normalize(v.slice(0, targetDim));
            throw new Error(
              `embedding width ${v.length} < required ${targetDim} — provider "${cfg.provider}" model "${model}" cannot serve the platform vector(${targetDim}) column`
            );
          });
        }
        return {
          vectors,
          model: json.model ?? model,
          usage: { promptTokens: json.usage?.prompt_tokens ?? json.usage?.total_tokens ?? null },
        };
      } finally {
        done();
      }
    },
  };
}
