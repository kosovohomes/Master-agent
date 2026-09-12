/**
 * Agent executors (Phase 2 — Phase 0.5 §6.4).
 *
 * Two executor kinds behind one interface:
 *  (a) BOUND executors — the pre-registry TypeScript implementations, keyed
 *      by slug. Bound executors delegate to lib/agents/generators.ts — the
 *      EXACT legacy code path — so behavior is byte-identical; they only add
 *      attribution (the rendered system prompt for prompt_hash).
 *      The folded ambassador executor is retained (prompt-variant pathway)
 *      but is never selected by the deterministic router (§6.1 fold).
 *  (b) the GENERIC LLM EXECUTOR — runs ANY registry agent from its versioned
 *      prompt + config. This is what makes arbitrary future agents possible
 *      with zero code: seed a row, version a prompt, enable.
 *
 * P2 scope guard: tools are registry rows only — NOTHING here executes side
 * effects (no posting, no web calls beyond the LLM itself). The task engine
 * and tool execution arrive with Phase 3+.
 */
import type { LLMClient } from "../ai/types";
import { createDraft } from "./approval";
import { generateDraft, systemPromptFor, channelHint } from "./generators";

export interface ExecutorInput {
  tenantId: number;
  channel: string;
  topic: string;
  context?: string;
  config: { brandVoice: string; persona: string; audience: string };
}

export interface ExecutorOutput {
  draftId: number | null;
  content: string | null;
  /** the actual system prompt used — the attribution basis for prompt_hash */
  systemPrompt: string;
}

export type BoundExecutor = (ctx: { llm: LLMClient }, input: ExecutorInput) => Promise<ExecutorOutput>;

function runBoundGeneration(agent: "research" | "marketing" | "sales" | "ambassador"): BoundExecutor {
  return async (ctx, input) => {
    // Same function the legacy generators use → identical prompt string.
    const systemPrompt = systemPromptFor(agent, input.config);
    const { draftId, content } = await generateDraft(
      { llm: ctx.llm },
      {
        tenantId: input.tenantId,
        agent,
        channel: input.channel,
        topic: input.topic,
        config: input.config,
        context: input.context,
      }
    );
    return { draftId, content, systemPrompt };
  };
}

/**
 * The bound registry. `customer_service` binds to its chat implementation in
 * the chat route (public widget path — behavior unchanged this phase); it is
 * NOT a generation executor. `ambassador` is retained per the fold decision
 * (§6.1): executable as a prompt variant, never router-selected.
 */
export const BOUND_EXECUTORS: Record<string, BoundExecutor> = {
  research: runBoundGeneration("research"),
  marketing: runBoundGeneration("marketing"),
  sales: runBoundGeneration("sales"),
  ambassador: runBoundGeneration("ambassador"),
};

/**
 * Generic LLM executor: runs any registry agent from its version row.
 * Prompt assembly = version.system_prompt + brand config + channel hint +
 * topic, exactly the shape the bound executors produce, so output quality
 * and attribution are uniform across both executor kinds.
 */
export function makeGenericLLMExecutor(p: {
  systemPrompt: string;
  agentSlug: string;
  outputSchema?: Record<string, unknown> | null;
  /** Phase 4 routing policy: per-agent model override (version config). */
  model?: string;
}): BoundExecutor {
  return async (ctx, input) => {
    const systemPrompt = [
      p.systemPrompt.trim(),
      `Brand voice: ${input.config.brandVoice || "professional"}`,
      `Persona: ${input.config.persona || "helpful brand representative"}`,
      `Target audience: ${input.config.audience || "general"}`,
      `Rules: no invented facts; no legal claims not present in the input; never mention abilities you lack.`,
    ].join("\n");
    const messages = [
      { role: "system", content: systemPrompt },
      { role: "user", content: `${channelHint(input.channel)}\n\nTopic: ${input.topic}${input.context ? `\nContext: ${input.context}` : ""}` },
    ] as const;
    const content = await ctx.llm.complete(messages as never, {
      temperature: 0.7,
      model: p.model, // undefined → gateway default resolution
    });
    const { draftId } = await createDraft({
      tenantId: input.tenantId,
      agent: p.agentSlug,
      channel: input.channel,
      content,
    });
    return { draftId, content, systemPrompt };
  };
}
