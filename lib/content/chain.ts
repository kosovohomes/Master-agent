/**
 * Content chain (Phase 8) — strategy → content → fact_check.
 *
 * Three registry agents execute in sequence, each from its VERSIONED prompt
 * (agent_versions via lib/agents/registry) with a structured output schema.
 * The chain is PURE with respect to storage: it takes the item + source
 * material and returns the artifacts; lib/content/tasks persists them. That
 * keeps the LLM sequence unit-testable with a fake client (same seam as the
 * research pipeline).
 *
 * Prompts follow the loadPrompt pattern: DB versioned prompt wins, code
 * default is the fallback so a registry hiccup degrades instead of crashing.
 */
import { completeJSON } from "../ai/structured";
import type { LLMClient } from "../ai/types";
import { currentVersion, getAgentBySlug } from "../agents/registry";
import {
  CONTENT_DRAFT_SCHEMA,
  CONTENT_PLAN_SCHEMA,
  FACT_CHECK_SCHEMA,
  type ContentDraftOutput,
  type ContentPlan,
  type FactCheckReport,
} from "./types";

export interface ChainSource {
  index: number;
  title: string;
  url: string | null;
  snippet: string;
}

export interface ChainPrompt {
  version: number;
  systemPrompt: string;
}

const STRATEGY_DEFAULT = `You are the Content Strategy Agent. Given research material and a brief, produce an editorial plan: the angle, target audience, channel fit, tone, key messages (each mapped to the [n] source citations that support it), and an outline of sections. Cite sources by [n] index. If the material cannot support a defensible plan, set ambiguous=true instead of inventing direction. Never fabricate facts not present in the sources.`;
const CONTENT_DEFAULT = `You are the Content Agent. Given an editorial plan and SOURCE excerpts, write the piece: a headline and the full body in markdown. Use ONLY facts present in the source excerpts or the plan; mark claims inline as [n] matching the source list. Match the requested tone, audience and channel conventions. Never fabricate statistics, quotes or facts; if a claim is not backed by the sources, leave it out.`;
const FACT_CHECK_DEFAULT = `You are the Fact Check Agent. Given a draft and the SOURCE excerpts it cites, verify every factual claim against the sources. Return a verdict per claim (supported | unsupported | contradicted | unverifiable) with the supporting citation indexes, a corrected wording where a small fix is possible, and an overall status: pass (all claims supported), warnings (unsupported or unverifiable claims remain), or fail (contradicted or fabricated content). Flag rather than fix: never silently rewrite the meaning of the draft.`;

async function loadAgentPrompt(slug: string, fallback: string): Promise<ChainPrompt> {
  try {
    const agent = await getAgentBySlug(slug);
    if (agent) {
      const v = await currentVersion(agent.id);
      if (v?.systemPrompt) return { version: v.version, systemPrompt: v.systemPrompt };
    }
  } catch {
    /* fall through to the code default */
  }
  return { version: 0, systemPrompt: fallback };
}

export async function loadChainPrompts(): Promise<{
  strategy: ChainPrompt;
  content: ChainPrompt;
  factCheck: ChainPrompt;
}> {
  const [strategy, content, factCheck] = await Promise.all([
    loadAgentPrompt("content_strategy", STRATEGY_DEFAULT),
    loadAgentPrompt("content", CONTENT_DEFAULT),
    loadAgentPrompt("fact_check", FACT_CHECK_DEFAULT),
  ]);
  return { strategy, content, factCheck };
}

function materialBlock(brief: string, sources: ChainSource[]): string {
  const list = sources.length > 0
    ? `SOURCE EXCERPTS:\n\n${sources
        .map((s) => `[${s.index}] ${s.title}\nURL: ${s.url ?? "n/a"}\n${s.snippet}`)
        .join("\n\n---\n\n")}`
    : "SOURCE EXCERPTS: (none provided — work strictly from the brief and say so in the plan)";
  return `BRIEF:\n${brief}\n\n${list}`;
}

export interface ChainOutcome {
  plan: ContentPlan;
  draft: ContentDraftOutput;
  factCheck: FactCheckReport;
  prompts: { strategy: ChainPrompt; content: ChainPrompt; factCheck: ChainPrompt };
}

/** Run the full three-step chain. Throws on LLM failure (caller degrades). */
export async function runChain(input: {
  brief: string;
  sources: ChainSource[];
  llm: LLMClient;
  type?: string;
}): Promise<ChainOutcome> {
  const prompts = await loadChainPrompts();
  const material = materialBlock(input.brief, input.sources);

  // Step 1 — strategy: plan from the material.
  const planOut = await completeJSON<ContentPlan>(
    input.llm,
    [
      { role: "system", content: prompts.strategy.systemPrompt },
      { role: "user", content: `${material}\n\nContent type: ${input.type ?? "article"}\n\nProduce the JSON editorial plan now.` },
    ],
    CONTENT_PLAN_SCHEMA,
    { temperature: 0.3 }
  );

  // Step 2 — content: draft from the plan + the same sources.
  const draftOut = await completeJSON<ContentDraftOutput>(
    input.llm,
    [
      { role: "system", content: prompts.content.systemPrompt },
      {
        role: "user",
        content: `${material}\n\nEDITORIAL PLAN:\n${JSON.stringify(planOut.value, null, 2)}\n\nWrite the JSON {title, body} piece now. The body must be markdown.`,
      },
    ],
    CONTENT_DRAFT_SCHEMA,
    { temperature: 0.7 }
  );

  // Step 3 — fact_check: verify the draft against the same sources.
  const factOut = await completeJSON<FactCheckReport>(
    input.llm,
    [
      { role: "system", content: prompts.factCheck.systemPrompt },
      {
        role: "user",
        content: `${material}\n\nDRAFT TO VERIFY:\nTITLE: ${draftOut.value.title}\n\n${draftOut.value.body}\n\nReturn the JSON fact-check report now.`,
      },
    ],
    FACT_CHECK_SCHEMA,
    { temperature: 0 }
  );

  return { plan: planOut.value, draft: draftOut.value, factCheck: factOut.value, prompts };
}
