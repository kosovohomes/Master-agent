import type { LLMClient } from "../ai/types";
import type { GatewayClient } from "../ai/gateway";
import { linkRun, runTotals } from "../ai/usage";
import type { AgentGoal } from "./types";
import type { KnowledgeCitation } from "../knowledge/types";
import { routeAgent, recordRun, classifyError } from "./core";
import { promptHash, checkRunnable, buIdForLegacyTenant, getAgentBySlug, currentVersion } from "./registry";
import { BOUND_EXECUTORS, makeGenericLLMExecutor } from "./executors";
import { query } from "../db";

/**
 * Tenant brand config. Phase 2 (C-13): the dead `content_system_prompt`
 * column is no longer read — per-BU prompt overrides return as
 * `agent_versions` config when needed. The column itself remains in the
 * schema (additive-first; drop is a later cleanup phase).
 */
export interface TenantCfg {
  brandVoice: string; persona: string; audience: string;
}

export async function getTenantConfig(tenantId: number): Promise<TenantCfg> {
  const rows = await query<TenantCfg>(
    "SELECT brand_voice AS \"brandVoice\", persona, audience FROM tenant_config WHERE tenant_id = $1",
    [tenantId]
  );
  if (rows.length === 0) return { brandVoice: "", persona: "", audience: "" };
  return rows[0];
}

export interface DispatchResult {
  runId: number; agent: string; routeReason: string; draftId: number | null;
  /** Phase 5: research grounding citations (tier + provenance) when grounded. */
  citations?: KnowledgeCitation[] | null;
}

export type AgentNotRunnableCode =
  | "AGENT_NOT_FOUND" | "AGENT_DISABLED" | "AGENT_ARCHIVED"
  | "AGENT_BU_DISABLED" | "AGENT_KILL_SWITCH" | "AGENT_EXECUTOR_MISSING";

/** Raised when the registry refuses an execution (status/BU/kill-switch). */
export class AgentNotRunnableError extends Error {
  code: AgentNotRunnableCode;
  constructor(code: AgentNotRunnableCode) {
    super(`agent not runnable: ${code}`);
    this.code = code;
    this.name = "AgentNotRunnableError";
  }
}

function currentModel(): string {
  return process.env.OPENAI_MODEL ?? "gpt-4o-mini";
}

/**
 * Registry-driven dispatch (Phase 2). The deterministic router classifies the
 * goal; the registry decides whether the agent may run (global status ×
 * per-BU enablement × emergency kill-switch); the executor bound to the
 * agent (or the generic LLM executor) produces the draft; the run record
 * carries full attribution (agent_id, business_unit_id, prompt_version_id,
 * real prompt_hash, model, timing, failure class). Flipping any enablement
 * layer propagates to behavior within one run, zero deploys.
 */
export async function dispatch(
  ctx: {
    llm: LLMClient;
    getConfig(tenantId: number): Promise<TenantCfg>;
    /** Phase 4: engine-provided attribution (task ceiling + ledger task_id). */
    attribution?: { taskId?: number | null };
    /**
     * Phase 5: scoped knowledge retrieval for research grounding. Callers
     * pass it only when the knowledge_v2 flag is ON (flag OFF = legacy
     * behavior, zero code path difference). Absent → no grounding.
     */
    retrieveKnowledge?: (p: {
      businessUnitId: number | null;
      agentSlug: string;
      query: string;
      topK?: number;
    }) => Promise<KnowledgeCitation[]>;
  },
  goal: AgentGoal
): Promise<DispatchResult> {
  const route = routeAgent(goal);

  if (route.agent === "customer_service") {
    // Chat answers are executed by the public chat route; dispatch only
    // records the run (legacy behavior preserved). prompt_hash is NOT NULL
    // in the legacy schema: attribute the run to the agent's canonical
    // prompt hash from the registry.
    const csAgent = await getAgentBySlug("customer_service");
    const csVersion = csAgent ? await currentVersion(csAgent.id) : null;
    const run = await recordRun({
      tenantId: goal.tenantId, agent: "customer_service", trigger: "manual",
      promptHash: promptHash(csVersion?.systemPrompt ?? "unattributed-failure"),
      agentId: csAgent?.id ?? null,
      promptVersionId: csVersion?.id ?? null,
      topic: goal.topic, model: currentModel(),
    });
    return { runId: run.runId, agent: "customer_service", routeReason: route.reason, draftId: null };
  }

  const businessUnitId = await buIdForLegacyTenant(goal.tenantId);
  const runnable = await checkRunnable(route.agent, businessUnitId);
  if (!runnable.ok) throw new AgentNotRunnableError(runnable.code);

  const agent = await getAgentBySlug(route.agent);
  if (!agent) throw new AgentNotRunnableError("AGENT_NOT_FOUND");
  const version = await currentVersion(agent.id);

  // Phase 5: research agents ground their briefs in scoped knowledge. The
  // scope set is resolved HERE (BU + agent identity) so the researcher can
  // never receive another BU's corpus or agent-restricted material. Best
  // effort: a retrieval failure degrades to an ungrounded run, never a crash.
  let citations: KnowledgeCitation[] | null = null;
  if (agent.slug === "research" && ctx.retrieveKnowledge) {
    try {
      citations = await ctx.retrieveKnowledge({
        businessUnitId,
        agentSlug: "research",
        query: goal.topic,
        topK: 5,
      });
    } catch {
      citations = null;
    }
  }

  const groundedContext =
    citations && citations.length > 0
      ? [
          goal.context ?? "",
          "Grounded knowledge passages (cite as [title — authority tier Tn]; never invent facts beyond them):",
          ...citations.map(
            (c) => `[${c.title} — authority tier T${c.authorityTier}] ${c.content}`
          ),
        ]
          .filter((part) => part !== "")
          .join("\n\n")
      : goal.context;

  const input = {
    tenantId: goal.tenantId,
    channel: goal.channel,
    topic: goal.topic,
    context: groundedContext,
    config: await ctx.getConfig(goal.tenantId),
  };

  const executor =
    agent.executorKind === "bound"
      ? BOUND_EXECUTORS[agent.slug]
      : version
        ? makeGenericLLMExecutor({
            systemPrompt: version.systemPrompt,
            agentSlug: agent.slug,
            outputSchema: version.outputSchema,
            // Phase 4 routing policy: per-agent model override rides the
            // version config (agent_versions.config.model). Absent → gateway
            // default resolution (env > gpt-4o-mini).
            model: (version.config as { model?: string } | null)?.model ?? undefined,
          })
        : undefined;
  if (!executor) throw new AgentNotRunnableError("AGENT_EXECUTOR_MISSING");

  // Phase 4: attach gateway attribution so every ledger row carries BU /
  // agent / task / purpose. Plain test stubs (no withAttribution) pass
  // through untouched — dispatch stays test-seam compatible.
  const gatewayClient = ctx.llm as LLMClient & Partial<GatewayClient>;
  const runLlm: LLMClient =
    typeof gatewayClient.withAttribution === "function"
      ? gatewayClient.withAttribution({
          businessUnitId,
          agentId: agent.id,
          agentSlug: agent.slug,
          taskId: ctx.attribution?.taskId ?? null,
          purpose: "draft_generation",
        })
      : ctx.llm;

  const startedAt = new Date();
  try {
    const out = await executor({ llm: runLlm }, input);
    const completedAt = new Date();
    const run = await recordRun({
      tenantId: goal.tenantId,
      agent: agent.slug,
      agentId: agent.id,
      businessUnitId,
      trigger: "manual",
      status: "completed",
      promptHash: promptHash(out.systemPrompt),
      promptVersionId: version?.id ?? null,
      topic: goal.topic,
      model: currentModel(),
      startedAt,
      completedAt,
      durationMs: completedAt.getTime() - startedAt.getTime(),
      outputRef: out.draftId != null ? `drafts/${out.draftId}` : null,
      citations: citations ?? undefined,
    });
    // Phase 4: back-link ledger rows to the run + token-accurate run totals
    // (agent_runs.input_tokens/output_tokens/estimated_cost, §71 P4 note).
    await linkRun({ runId: run.runId, agentId: agent.id, businessUnitId, since: startedAt });
    const totals = await runTotals(run.runId).catch(() => null);
    if (totals) {
      await query(
        "UPDATE agent_runs SET input_tokens = $2, output_tokens = $3, estimated_cost = $4 WHERE id = $1",
        [run.runId, totals.promptTokens, totals.completionTokens, totals.costUsd]
      ).catch(() => undefined);
    }
    return { runId: run.runId, agent: agent.slug, routeReason: route.reason, draftId: out.draftId, citations };
  } catch (e) {
    const completedAt = new Date();
    // Failed executions are recorded (§71) — the run ledger must show them.
    const failedRun = await recordRun({
      tenantId: goal.tenantId,
      agent: agent.slug,
      agentId: agent.id,
      businessUnitId,
      trigger: "manual",
      status: "failed",
      // prompt_hash is NOT NULL in the legacy schema — attribute the failure
      // to the agent's canonical prompt hash even when execution never ran.
      promptHash: promptHash(version?.systemPrompt ?? "unattributed-failure"),
      promptVersionId: version?.id ?? null,
      topic: goal.topic,
      model: currentModel(),
      startedAt,
      completedAt,
      durationMs: completedAt.getTime() - startedAt.getTime(),
      error: e instanceof Error ? e.message : String(e),
      errorClass: classifyError(e),
    }).catch(() => null); // never mask the original failure
    // Attribute any ledgered attempts (errors/blocks) of this run too.
    if (failedRun) {
      await linkRun({ runId: failedRun.runId, agentId: agent.id, businessUnitId, since: startedAt }).catch(
        () => undefined
      );
    }
    throw e;
  }
}
