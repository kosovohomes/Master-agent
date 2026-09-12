/**
 * BACK-COMPAT SHIM (Phase 4). The LLM client moved to lib/ai per the
 * Phase 0.5 §323 module tree:
 *   lib/llm.ts  →  lib/ai/providers/openai.ts (+ gateway in lib/ai/gateway.ts)
 *
 * This shim re-exports the moved surface for ONE transition phase so old
 * imports keep compiling. New code MUST import from "@/lib/ai"; the
 * call-site grep test (tests/call-site-grep-tests.ts) enforces that nothing
 * outside lib/ai and this shim references the provider. Composition roots
 * (dispatch, chat route, task executors) already consume the gateway-wrapped
 * client — see lib/ai/gateway.ts.
 */
export {
  makeOpenAI,
  makeOpenAI as makeLLM, // legacy alias (tests use it to exercise the raw provider)
  openai,
  openai as llm, // legacy alias: the RAW provider — composition roots must NOT use this
  DEFAULT_CHAT_MODEL,
  DEFAULT_EMBED_MODEL,
} from "./ai/providers/openai";
export type { ChatMessage, LLMClient } from "./ai/types";
