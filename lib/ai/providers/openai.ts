/**
 * OpenAI provider adapter (Phase 4 — the innermost adapter, Phase 0.5 §8).
 *
 * Since Phase 10.5 this file is a thin, zero-config instance of the generic
 * OpenAI-compatible factory (openai-compatible.ts): the OpenAI wire protocol
 * IS the platform's canonical provider protocol. Behavior is byte-identical
 * to the Phase 4 original — same URLs, same OPENAI_MODEL /
 * OPENAI_EMBEDDINGS_MODEL resolution, same error mapping — so the existing
 * llm suite remains the behavioral contract.
 *
 * `lib/llm.ts` remains as a re-export shim for one phase so any straggler
 * import keeps compiling; the call-site grep test forbids NEW provider
 * imports anywhere outside lib/ai.
 */
import { type ProviderClient } from "../types";
import { makeOpenAICompatible, requireEnv } from "./openai-compatible";

export type { ChatMessage, LLMClient } from "../types";

export const DEFAULT_CHAT_MODEL = "gpt-4o-mini";
export const DEFAULT_EMBED_MODEL = "text-embedding-3-small";

export function makeOpenAI(fetchImpl: typeof fetch = fetch): ProviderClient {
  return makeOpenAICompatible(
    {
      provider: "openai",
      baseUrl: "https://api.openai.com/v1",
      apiKey: () => requireEnv("OPENAI_API_KEY"),
      chatModelEnv: "OPENAI_MODEL",
      embedModelEnv: "OPENAI_EMBEDDINGS_MODEL",
      defaultChatModel: DEFAULT_CHAT_MODEL,
      defaultEmbedModel: DEFAULT_EMBED_MODEL,
    },
    fetchImpl
  );
}

/** Production singleton — imported ONLY by the gateway (grep-enforced). */
export const openai: ProviderClient = makeOpenAI();
