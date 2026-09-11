import type { LLMClient } from "../llm";
import type { AgentGoal } from "./types";
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
  ctx: { llm: LLMClient; getConfig(tenantId: number): Promise<TenantCfg> },
  goal: AgentGoal
): Promise<DispatchResult> {
  const route = routeAgent(goal);

  if (route.agent === "customer_service") {
    // Chat answers are executed by the public chat route; dispatch only
    // records the run (legacy behavior preserved).
    const run = await recordRun({
      tenantId: goal.tenantId, agent: "customer_service", trigger: "manual",
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

  const input = {
    tenantId: goal.tenantId,
    channel: goal.channel,
    topic: goal.topic,
    context: goal.context,
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
          })
        : undefined;
  if (!executor) throw new AgentNotRunnableError("AGENT_EXECUTOR_MISSING");

  const startedAt = new Date();
  try {
    const out = await executor({ llm: ctx.llm }, input);
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
    });
    return { runId: run.runId, agent: agent.slug, routeReason: route.reason, draftId: out.draftId };
  } catch (e) {
    const completedAt = new Date();
    // Failed executions are recorded (§71) — the run ledger must show them.
    await recordRun({
      tenantId: goal.tenantId,
      agent: agent.slug,
      agentId: agent.id,
      businessUnitId,
      trigger: "manual",
      status: "failed",
      promptVersionId: version?.id ?? null,
      topic: goal.topic,
      model: currentModel(),
      startedAt,
      completedAt,
      durationMs: completedAt.getTime() - startedAt.getTime(),
      error: e instanceof Error ? e.message : String(e),
      errorClass: classifyError(e),
    }).catch(() => undefined); // never mask the original failure
    throw e;
  }
}
