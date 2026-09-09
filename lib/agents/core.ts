import type { AgentGoal, AgentId, PlanRoute } from "./types";
import { query } from "../db";

const SALES_TERMS = ["outreach", "pitch", "lead", "partnership", "prospect", "sell", "sales"];
const RESEARCH_TERMS = ["research", "news", "intel", "trend", "brief", "gather"];
const AMBASSADOR_TERMS = ["promote", "awareness", "mention", "testimonial", "event", "ambassador", "endorse"];
const SERVICE_CHANNELS = new Set(["chat"]);

export function routeAgent(goal: Pick<AgentGoal, "topic" | "channel">): PlanRoute {
  const t = goal.topic.toLowerCase();

  if (SERVICE_CHANNELS.has(goal.channel.toLowerCase())) {
    return { agent: "customer_service", reason: "chat channel requires verified answers" };
  }
  if (RESEARCH_TERMS.some((w) => t.includes(w))) {
    return { agent: "research", reason: "topic is research/intel" };
  }
  if (SALES_TERMS.some((w) => t.includes(w))) {
    return { agent: "sales", reason: "topic is sales/outreach" };
  }
  if (AMBASSADOR_TERMS.some((w) => t.includes(w))) {
    return { agent: "ambassador", reason: "topic is promotion/awareness" };
  }
  return { agent: "marketing", reason: "default marketing" };
}

export async function recordRun(p: {
  tenantId: number;
  agent: AgentId;
  trigger: string;
  promptHash: string;
  outputRef?: string;
}): Promise<{ runId: number }> {
  const rows = await query<{ id: number }>(
    `INSERT INTO agent_runs (tenant_id, agent, trigger, status, prompt_hash, output_ref)
     VALUES ($1, $2, $3, 'completed', $4, $5) RETURNING id`,
    [p.tenantId, p.agent, p.trigger, p.promptHash, p.outputRef ?? null]
  );
  return { runId: rows[0].id };
}