/**
 * Provider resolution (Phase 10.5 — free-tier enablement).
 *
 * LLM_PROVIDER picks the backing adapter; everything else is composition
 * config. Rollback to the paid path = set LLM_PROVIDER=openai (or unset the
 * var) — zero code changes, ledger and budgets intact.
 *
 *   openai      OPENAI_API_KEY                    api.openai.com/v1        (paid, baseline)
 *   gemini      GEMINI_API_KEY (or LLM_API_KEY)   Google AI Studio free tier —
 *                                                 chat (gemini-2.0-flash) AND 1536-dim
 *                                                 embeddings (gemini-embedding-001) —
 *                                                 the recommended free provider: it is
 *                                                 the only free tier covering both
 *                                                 halves of the RAG loop
 *   groq        GROQ_API_KEY (or LLM_API_KEY)     chat only (llama-3.3-70b), no embeddings
 *   openrouter  OPENROUTER_API_KEY (or LLM_API_KEY) free-tier models (:free suffix), chat only
 *   custom      LLM_BASE_URL + LLM_API_KEY + LLM_CHAT_MODEL  any OpenAI-compatible endpoint
 *
 * Unknown models price at $0 via the model_prices miss path (Phase 4
 * prices.ts) — free tiers ledger with cost 0 and an unpriced_model flag,
 * never silently mis-costed, never blocked.
 */
import { type ProviderClient } from "../types";
import { makeOpenAI } from "./openai";
import { makeOpenAICompatible, requireEnv } from "./openai-compatible";

export interface ResolvedProvider {
  name: string;
  client: ProviderClient;
}

export const OPENROUTER_DEFAULT_CHAT_MODEL = "meta-llama/llama-3.3-70b-instruct:free";
export const GROQ_DEFAULT_CHAT_MODEL = "llama-3.3-70b-versatile";
export const GEMINI_DEFAULT_CHAT_MODEL = "gemini-2.0-flash";
export const GEMINI_DEFAULT_EMBED_MODEL = "gemini-embedding-001";

const GROQ_NO_EMBEDDINGS =
  'provider "groq" serves chat only — knowledge/RAG ingestion needs embeddings; use LLM_PROVIDER=gemini (free tier covers chat AND embeddings) or keep openai for embeddings';
const OPENROUTER_NO_EMBEDDINGS =
  'provider "openrouter" free models serve chat only — knowledge/RAG ingestion needs embeddings; use LLM_PROVIDER=gemini (free tier covers chat AND embeddings) or keep openai for embeddings';

export function resolveProvider(fetchImpl: typeof fetch = fetch): ResolvedProvider {
  const name = (process.env.LLM_PROVIDER ?? "openai").trim().toLowerCase() || "openai";
  switch (name) {
    case "openai":
      return { name: "openai", client: makeOpenAI(fetchImpl) };

    case "gemini":
      return {
        name,
        client: makeOpenAICompatible(
          {
            provider: "gemini",
            baseUrl: "https://generativelanguage.googleapis.com/v1beta/openai",
            apiKey: () => requireEnv("GEMINI_API_KEY", "LLM_API_KEY"),
            chatModelEnv: "LLM_CHAT_MODEL",
            embedModelEnv: "LLM_EMBED_MODEL",
            defaultChatModel: GEMINI_DEFAULT_CHAT_MODEL,
            defaultEmbedModel: GEMINI_DEFAULT_EMBED_MODEL,
            // Gemini honors the OpenAI `dimensions` param on
            // gemini-embedding-001; the MRL truncate guard below is the
            // safety net if a future model ignores it.
            embedDimensions: 1536,
            embedTargetDim: 1536,
          },
          fetchImpl
        ),
      };

    case "groq":
      return {
        name,
        client: makeOpenAICompatible(
          {
            provider: "groq",
            baseUrl: "https://api.groq.com/openai/v1",
            apiKey: () => requireEnv("GROQ_API_KEY", "LLM_API_KEY"),
            chatModelEnv: "LLM_CHAT_MODEL",
            embedModelEnv: "LLM_EMBED_MODEL",
            defaultChatModel: GROQ_DEFAULT_CHAT_MODEL,
            defaultEmbedModel: null,
            embedUnsupportedMessage: GROQ_NO_EMBEDDINGS,
          },
          fetchImpl
        ),
      };

    case "openrouter":
      return {
        name,
        client: makeOpenAICompatible(
          {
            provider: "openrouter",
            baseUrl: "https://openrouter.ai/api/v1",
            apiKey: () => requireEnv("OPENROUTER_API_KEY", "LLM_API_KEY"),
            chatModelEnv: "LLM_CHAT_MODEL",
            embedModelEnv: "LLM_EMBED_MODEL",
            defaultChatModel: OPENROUTER_DEFAULT_CHAT_MODEL,
            defaultEmbedModel: null,
            embedUnsupportedMessage: OPENROUTER_NO_EMBEDDINGS,
            extraHeaders: {
              "HTTP-Referer": process.env.NEXT_PUBLIC_APP_URL ?? "https://localhost",
              "X-Title": "AgentOS",
            },
          },
          fetchImpl
        ),
      };

    case "custom": {
      const baseUrl = process.env.LLM_BASE_URL?.trim();
      if (!baseUrl) {
        throw new Error('LLM_PROVIDER=custom requires LLM_BASE_URL (OpenAI-compatible root, e.g. https://host/v1)');
      }
      const chatModel = process.env.LLM_CHAT_MODEL?.trim();
      if (!chatModel) {
        throw new Error('LLM_PROVIDER=custom requires LLM_CHAT_MODEL (the model name your endpoint serves)');
      }
      return {
        name,
        client: makeOpenAICompatible(
          {
            provider: "custom",
            baseUrl,
            apiKey: () => requireEnv("LLM_API_KEY"),
            chatModelEnv: "LLM_CHAT_MODEL",
            embedModelEnv: "LLM_EMBED_MODEL",
            defaultChatModel: chatModel,
            defaultEmbedModel: process.env.LLM_EMBED_MODEL?.trim() || null,
          },
          fetchImpl
        ),
      };
    }

    default:
      throw new Error(`LLM_PROVIDER "${name}" is not supported — use openai | gemini | groq | openrouter | custom`);
  }
}

/**
 * Never throws: a misconfigured LLM_PROVIDER falls back to the OpenAI
 * adapter (which fails loudly at call time on the missing/invalid key) so a
 * bad env var can never take the whole app down at module load.
 */
export function resolveProviderSafe(fetchImpl: typeof fetch = fetch): ResolvedProvider {
  try {
    return resolveProvider(fetchImpl);
  } catch (e) {
    console.error("[ai/providers] provider resolution failed — falling back to openai:", e instanceof Error ? e.message : e);
    return { name: "openai", client: makeOpenAI(fetchImpl) };
  }
}

/** Gateway-path primary chat model, provider-aware. null = misconfig (gateway fails fast with guidance). */
export function defaultChatModelFor(provider: string): string | null {
  switch (provider) {
    case "openai":
      return process.env.OPENAI_MODEL?.trim() || "gpt-4o-mini";
    case "gemini":
      return process.env.LLM_CHAT_MODEL?.trim() || GEMINI_DEFAULT_CHAT_MODEL;
    case "groq":
      return process.env.LLM_CHAT_MODEL?.trim() || GROQ_DEFAULT_CHAT_MODEL;
    case "openrouter":
      return process.env.LLM_CHAT_MODEL?.trim() || OPENROUTER_DEFAULT_CHAT_MODEL;
    default:
      return process.env.LLM_CHAT_MODEL?.trim() || null;
  }
}

/** Ledger label for an embed error row before/outside a successful response. */
export function defaultEmbedModelFor(provider: string): string {
  switch (provider) {
    case "openai":
      return process.env.OPENAI_EMBEDDINGS_MODEL?.trim() || "text-embedding-3-small";
    case "gemini":
      return process.env.LLM_EMBED_MODEL?.trim() || GEMINI_DEFAULT_EMBED_MODEL;
    default:
      return process.env.LLM_EMBED_MODEL?.trim() || "unavailable";
  }
}
