import type { LLMClient } from "../llm";
import type { AgentGoal, AgentId } from "./types";
import { routeAgent, recordRun } from "./core";
import { generateDraft } from "./generators";
import { query } from "../db";

export interface TenantCfg {
  brandVoice: string; persona: string; audience: string; contentSystemPrompt: string;
}

export async function getTenantConfig(tenantId: number): Promise<TenantCfg> {
  const rows = await query<TenantCfg>(
    "SELECT brand_voice AS \"brandVoice\", persona, audience, content_system_prompt AS \"contentSystemPrompt\" FROM tenant_config WHERE tenant_id = $1",
    [tenantId]
  );
  if (rows.length === 0) return { brandVoice: "", persona: "", audience: "", contentSystemPrompt: "" };
  return rows[0];
}

export interface DispatchResult {
  runId: number; agent: AgentId; routeReason: string; draftId: number | null;
}

export async function dispatch(
  ctx: { llm: LLMClient; getConfig(tenantId: number): Promise<TenantCfg> },
  goal: AgentGoal
): Promise<DispatchResult> {
  const route = routeAgent(goal);
  const promptHash = goal.topic;

  if (route.agent !== "customer_service") {
    const config = await ctx.getConfig(goal.tenantId);
    const { draftId } = await generateDraft({ llm: ctx.llm }, {
      tenantId: goal.tenantId,
      agent: route.agent,
      channel: goal.channel,
      topic: goal.topic,
      config,
      context: goal.context,
    });
    const run = await recordRun({ tenantId: goal.tenantId, agent: route.agent, trigger: "manual", promptHash });
    return { runId: run.runId, agent: route.agent, routeReason: route.reason, draftId };
  }

  const run = await recordRun({ tenantId: goal.tenantId, agent: "customer_service", trigger: "manual", promptHash });
  return { runId: run.runId, agent: "customer_service", routeReason: route.reason, draftId: null };
}