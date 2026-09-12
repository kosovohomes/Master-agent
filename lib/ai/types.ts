/**
 * AI Gateway shared contracts (Phase 4 — Phase 0.5 §8, §323).
 *
 * `LLMClient` is THE provider contract for the whole platform: every
 * executor/generator/chat call site keeps receiving a plain LLMClient and
 * never changes. The gateway wraps provider adapters behind the same
 * interface, so call sites are composition-root swaps only (grep-enforced:
 * tests/call-site-grep-tests.ts forbids provider imports outside lib/ai).
 */

export type ChatMessage = { role: "system" | "user" | "assistant"; content: string };

export type LLMClient = {
  complete(messages: ChatMessage[], opts?: { model?: string; temperature?: number }): Promise<string>;
  embed(texts: string[]): Promise<number[][]>;
};

/**
 * Attribution attached at composition roots (dispatch, chat route, task
 * engine). Call sites never pass it — the wrapper carries it so every
 * llm_requests row is attributable to a BU / agent / task.
 */
export interface GatewayAttribution {
  businessUnitId?: number | null;
  agentId?: number | null;
  agentSlug?: string | null;
  taskId?: number | null;
  purpose?: string | null; // draft_generation | chat_answer | retrieval | ingest | structured
}

/** Richer provider surface used by the gateway only. */
export interface CompletionUsage {
  promptTokens: number | null;
  completionTokens: number | null;
  totalTokens: number | null;
}

export interface CompletionResult {
  content: string;
  model: string;
  usage: CompletionUsage;
}

export interface EmbedUsage {
  promptTokens: number | null;
}

export interface EmbedResult {
  vectors: number[][];
  model: string;
  usage: EmbedUsage;
}

/**
 * Provider adapter contract. The OpenAI adapter (lib/ai/providers/openai.ts)
 * implements this; the gateway consumes it. Retriable errors are surfaced as
 * ProviderHttpError so retry/fallback policy stays in the gateway.
 */
export interface ProviderClient extends LLMClient {
  completeWithUsage(
    messages: ChatMessage[],
    opts?: { model?: string; temperature?: number; timeoutMs?: number }
  ): Promise<CompletionResult>;
  embedWithUsage(texts: string[], opts?: { model?: string; timeoutMs?: number }): Promise<EmbedResult>;
}

/** HTTP-level provider failure with a status code (429/5xx are retriable). */
export class ProviderHttpError extends Error {
  status: number;
  code: string;
  constructor(status: number, code: string, detail: string) {
    super(`llm ${status}: ${code}${detail ? ` — ${detail.slice(0, 200)}` : ""}`);
    this.name = "ProviderHttpError";
    this.status = status;
    this.code = code;
  }
  get retriable(): boolean {
    return this.status === 429 || this.status >= 500;
  }
}

/** Raised pre-call when a spend budget blocks execution (hard-stop, SEC-L9). */
export class BudgetExceededError extends Error {
  scopeType: "business_unit" | "agent" | "task";
  scopeId: number;
  period: string;
  spentUsd: number;
  limitUsd: number;
  constructor(p: {
    scopeType: "business_unit" | "agent" | "task";
    scopeId: number;
    period: string;
    spentUsd: number;
    limitUsd: number;
  }) {
    super(
      `budget hard-stop: ${p.scopeType}#${p.scopeId} ${p.period} spend $${p.spentUsd.toFixed(4)} >= limit $${p.limitUsd.toFixed(4)}`
    );
    this.name = "BudgetExceededError";
    this.scopeType = p.scopeType;
    this.scopeId = p.scopeId;
    this.period = p.period;
    this.spentUsd = p.spentUsd;
    this.limitUsd = p.limitUsd;
  }
}

/** Raised pre-call when the per-BU LLM call-rate limit is exhausted. */
export class LlmRateLimitedError extends Error {
  retryAfterSec: number;
  constructor(retryAfterSec: number) {
    super(`llm rate limited for this business unit; retry after ${retryAfterSec}s`);
    this.name = "LlmRateLimitedError";
    this.retryAfterSec = retryAfterSec;
  }
}

/** Raised when every model attempt in the fallback chain failed. */
export class LlmProviderError extends Error {
  attempts: Array<{ model: string; status?: number; code?: string; message: string }>;
  constructor(attempts: Array<{ model: string; status?: number; code?: string; message: string }>) {
    super(
      `llm call failed after ${attempts.length} attempt(s): ${attempts[attempts.length - 1]?.message ?? "unknown"}`
    );
    this.name = "LlmProviderError";
    this.attempts = attempts;
  }
}
