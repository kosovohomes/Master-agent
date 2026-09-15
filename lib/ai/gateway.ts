/**
 * AI Gateway (Phase 4 — the ONE controlled doorway, Phase 0.5 §8/§41).
 *
 * Every completion and embedding in the platform flows through here:
 *
 *   flag gate      ai_gateway feature flag OFF → raw provider passthrough
 *                  (the rollback path: pre-Phase-4 behavior, zero deploys)
 *   provider       LLM_PROVIDER env → resolve.ts adapter (openai | gemini |
 *                  groq | openrouter | custom); ledger carries the real name
 *   routing        explicit opts.model > per-agent model (attribution-borne)
 *                  > provider-aware default (defaultChatModelFor)
 *   budgets        pre-call hard-stop (BudgetExceededError, SEC-L9);
 *                  post-call re-check pages ops via the event bus
 *   rate limit     per-BU call-rate limit (DB-backed buckets, global)
 *   retry+fallback retriable (429/5xx/timeout) failures walk the fallback
 *                  model chain once; every attempt is ledgered
 *   usage          every attempt writes llm_requests (provider, model,
 *                  tokens, cost via model_prices, latency, attribution)
 *
 * The gateway IS an LLMClient: call sites never change. Composition roots
 * attach attribution via withAttribution(); dispatch additionally links
 * ledger rows to agent_runs and feeds token-accurate totals back onto the
 * run record (§71's "token-accurate costing is Phase 4").
 */
import {
  type ChatMessage,
  type GatewayAttribution,
  type LLMClient,
  type ProviderClient,
  BudgetExceededError,
  LlmProviderError,
  LlmRateLimitedError,
  ProviderHttpError,
} from "./types";
import { resolveProviderSafe, defaultChatModelFor, defaultEmbedModelFor } from "./providers/resolve";
import { priceFor, computeCostUsd } from "./prices";
import { recordRequest } from "./usage";
import { checkBudgets, firstOverBudgetAfterCall, hardStopEventOnCooldown } from "./budgets";
import { isFlagEnabled } from "../settings";
import { rateLimit } from "../security/ratelimit";

export interface GatewayDeps {
  fetchImpl?: typeof fetch;
  /** Tests inject a stub provider; production resolves via LLM_PROVIDER (resolve.ts). */
  provider?: ProviderClient;
  /** Ledger provider name for an injected stub (default "openai" — test compat). */
  providerName?: string;
  /** Fallback chain for retriable chat failures (first entry = primary). */
  fallbackModels?: string[];
  timeoutMs?: number;
  /** Per-BU chat calls per minute (0 = off). Default 120. */
  ratePerMin?: number;
  /** Tests: skip the DB flag read and force the gateway ON. */
  alwaysGateway?: boolean;
  /** Tests: stub the hard-stop event emitter. */
  emitHardStop?: (attr: GatewayAttribution, info: { scope: string; spentUsd: number; limitUsd: number }) => Promise<void>;
}

function envFallbackModels(): string[] {
  return (process.env.LLM_FALLBACK_MODELS ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

function scopeKeyOf(attr: GatewayAttribution, scopeType: string, scopeId: number): string {
  return `${scopeType}#${scopeId}${attr.taskId != null ? `+task#${attr.taskId}` : ""}`;
}

async function defaultEmitHardStop(
  attr: GatewayAttribution,
  info: { scope: string; spentUsd: number; limitUsd: number }
): Promise<void> {
  try {
    const { emitEvent } = await import("../tasks/events");
    await emitEvent(attr.businessUnitId ?? null, "budget.hard_stop", {
      scope: info.scope,
      spentUsd: Number(info.spentUsd.toFixed(4)),
      limitUsd: Number(info.limitUsd.toFixed(4)),
      agentSlug: attr.agentSlug ?? null,
      taskId: attr.taskId ?? null,
      purpose: attr.purpose ?? null,
    });
  } catch (e) {
    console.error("[ai/gateway] budget hard-stop event failed", e instanceof Error ? e.message : e);
  }
}

export interface GatewayClient extends LLMClient {
  /** Attach attribution at a composition root; returns a plain LLMClient. */
  withAttribution(attr: GatewayAttribution): LLMClient;
}

export function makeGatewayClient(deps: GatewayDeps = {}): GatewayClient {
  const resolved = deps.provider
    ? { name: deps.providerName ?? "openai", client: deps.provider }
    : resolveProviderSafe(deps.fetchImpl);
  const provider = resolved.client;
  const providerName = resolved.name;
  const timeoutMs = deps.timeoutMs ?? Number(process.env.LLM_TIMEOUT_MS ?? 60_000);
  const configuredChain = deps.fallbackModels ?? envFallbackModels();
  const ratePerMin = deps.ratePerMin ?? Number(process.env.LLM_RATE_PER_MIN ?? 120);
  const emitHardStop = deps.emitHardStop ?? defaultEmitHardStop;

  async function gatewayEnabled(): Promise<boolean> {
    if (deps.alwaysGateway) return true;
    try {
      return await isFlagEnabled("ai_gateway", true);
    } catch {
      return true; // fail open to gateway behavior; provider errors still surface
    }
  }

  async function maybePageOps(attr: GatewayAttribution, scopeType: string, scopeId: number, spentUsd: number, limitUsd: number): Promise<void> {
    const scope = scopeKeyOf(attr, scopeType, scopeId);
    if (await hardStopEventOnCooldown(scope)) return;
    await emitHardStop(attr, { scope, spentUsd, limitUsd });
  }

  async function enforceRateLimit(attr: GatewayAttribution): Promise<void> {
    if (ratePerMin <= 0 || attr.businessUnitId == null) return;
    const rl = await rateLimit(`llm:bu:${attr.businessUnitId}`, ratePerMin, 60_000);
    if (!rl.allowed) {
      await recordRequest({
        provider: providerName,
        kind: "chat",
        model: "pre-call",
        status: "rate_limited",
        attribution: attr,
        errorCode: "LLM_RATE_LIMITED",
      });
      throw new LlmRateLimitedError(rl.retryAfterSec);
    }
  }

  async function gatewayComplete(
    attr: GatewayAttribution,
    messages: ChatMessage[],
    opts: { model?: string; temperature?: number } = {}
  ): Promise<string> {
    if (!(await gatewayEnabled())) {
      return provider.complete(messages, opts); // rollback passthrough (no ledger — pre-P4 behavior)
    }

    await checkBudgets(attr).catch(async (e) => {
      if (e instanceof BudgetExceededError) {
        await recordRequest({
          provider: providerName,
          kind: "chat",
          model: opts.model ?? "pre-call",
          status: "budget_blocked",
          attribution: attr,
          errorCode: "BUDGET_EXCEEDED",
          metadata: { scope: `${e.scopeType}#${e.scopeId}`, period: e.period, limitUsd: e.limitUsd, spentUsd: e.spentUsd },
        });
        await maybePageOps(attr, e.scopeType, e.scopeId, e.spentUsd, e.limitUsd);
      }
      throw e;
    });

    await enforceRateLimit(attr);

    const primary = opts.model ?? defaultChatModelFor(providerName);
    if (!primary) {
      throw new Error(`model required for provider "${providerName}": pass opts.model or set LLM_CHAT_MODEL`);
    }
    const chain = [primary, ...configuredChain.filter((m) => m !== primary)];
    const attempts: Array<{ model: string; status?: number; code?: string; message: string }> = [];

    for (let i = 0; i < chain.length; i++) {
      const model = chain[i];
      const startedAt = Date.now();
      try {
        const out = await provider.completeWithUsage(messages, { model, temperature: opts.temperature, timeoutMs });
        const latencyMs = Date.now() - startedAt;
        const price = await priceFor(providerName, out.model, "chat");
        const costUsd = computeCostUsd(price, out.usage);
        await recordRequest({
          provider: providerName,
          kind: "chat",
          model: out.model,
          status: "ok",
          attribution: attr,
          promptTokens: out.usage.promptTokens,
          completionTokens: out.usage.completionTokens,
          totalTokens: out.usage.totalTokens,
          costUsd,
          latencyMs,
          attemptNo: i + 1,
        });
        // Post-call accounting: this call may have crossed a budget — the
        // NEXT call is hard-stopped by checkBudgets; page ops now.
        const over = await firstOverBudgetAfterCall(attr).catch(() => null);
        if (over) await maybePageOps(attr, over.scopeType, over.scopeId, over.spentUsd, over.limitUsd);
        return out.content;
      } catch (e) {
        const latencyMs = Date.now() - startedAt;
        const http = e instanceof ProviderHttpError ? e : null;
        const errorCode = http ? http.code : e instanceof Error && e.name === "AbortError" ? "timeout" : "provider_error";
        attempts.push({ model, status: http?.status, code: errorCode, message: e instanceof Error ? e.message : String(e) });
        await recordRequest({
          provider: providerName,
          kind: "chat",
          model,
          status: "error",
          attribution: attr,
          latencyMs,
          attemptNo: i + 1,
          errorCode,
        });
        const retriable = http ? http.retriable : true; // timeouts/aborts are retriable
        if (!retriable || i === chain.length - 1) {
          throw new LlmProviderError(attempts);
        }
      }
    }
    throw new LlmProviderError(attempts); // unreachable; satisfies the type system
  }

  async function gatewayEmbed(attr: GatewayAttribution, texts: string[]): Promise<number[][]> {
    if (!(await gatewayEnabled())) return provider.embed(texts);

    await checkBudgets(attr).catch(async (e) => {
      if (e instanceof BudgetExceededError) {
        await recordRequest({
          provider: providerName,
          kind: "embed",
          model: "pre-call",
          status: "budget_blocked",
          attribution: attr,
          errorCode: "BUDGET_EXCEEDED",
          metadata: { scope: `${e.scopeType}#${e.scopeId}`, period: e.period },
        });
        await maybePageOps(attr, e.scopeType, e.scopeId, e.spentUsd, e.limitUsd);
      }
      throw e;
    });

    const startedAt = Date.now();
    try {
      const out = await provider.embedWithUsage(texts, { timeoutMs });
      const latencyMs = Date.now() - startedAt;
      const price = await priceFor(providerName, out.model, "embed");
      const costUsd = computeCostUsd(price, { promptTokens: out.usage.promptTokens, completionTokens: null });
      await recordRequest({
        provider: providerName,
        kind: "embed",
        model: out.model,
        status: "ok",
        attribution: attr,
        promptTokens: out.usage.promptTokens,
        totalTokens: out.usage.promptTokens,
        costUsd,
        latencyMs,
      });
      const over = await firstOverBudgetAfterCall(attr).catch(() => null);
      if (over) await maybePageOps(attr, over.scopeType, over.scopeId, over.spentUsd, over.limitUsd);
      return out.vectors;
    } catch (e) {
      const http = e instanceof ProviderHttpError ? e : null;
      await recordRequest({
        provider: providerName,
        kind: "embed",
        model: defaultEmbedModelFor(providerName),
        status: "error",
        attribution: attr,
        latencyMs: Date.now() - startedAt,
        errorCode: http ? http.code : "provider_error",
      });
      throw e;
    }
  }

  return {
    async complete(messages, opts = {}) {
      return gatewayComplete({}, messages, opts);
    },
    async embed(texts) {
      return gatewayEmbed({}, texts);
    },
    withAttribution(attr: GatewayAttribution): LLMClient {
      return {
        complete: (messages, opts = {}) => gatewayComplete(attr, messages, opts),
        embed: (texts: string[]) => gatewayEmbed(attr, texts),
      };
    },
  };
}

/**
 * Production gateway singleton. Composition roots import THIS (`ai`) —
 * never the provider. Executors/generators/chat receive it unchanged as
 * their plain LLMClient.
 */
export const ai: GatewayClient = makeGatewayClient();
