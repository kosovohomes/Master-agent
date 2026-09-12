/**
 * lib/ai — public surface. Composition roots import from here:
 *
 *   import { ai } from "@/lib/ai";             // the gateway (an LLMClient)
 *   import { withAttribution } from "@/lib/ai" // not needed — use ai.withAttribution
 *
 * Executors and generators never import this module; they receive the
 * gateway as their plain LLMClient (zero call-site changes, §8).
 */
export { ai, makeGatewayClient, type GatewayClient, type GatewayDeps } from "./gateway";
export {
  type ChatMessage,
  type LLMClient,
  type GatewayAttribution,
  type ProviderClient,
  BudgetExceededError,
  LlmProviderError,
  LlmRateLimitedError,
  ProviderHttpError,
} from "./types";
export { completeJSON, validateAgainstSchema } from "./structured";
export { listBudgets, upsertBudget, setBudgetEnabled, deleteBudget, type Budget } from "./budgets";
export { usageRollup, type UsageRollupRow } from "./usage";
