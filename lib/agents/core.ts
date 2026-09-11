import type { AgentGoal, PlanRoute } from "./types";
import { query } from "../db";

const SALES_TERMS = ["outreach", "pitch", "lead", "partnership", "prospect", "sell", "sales"];
const RESEARCH_TERMS = ["research", "news", "intel", "trend", "brief", "gather"];
const AMBASSADOR_TERMS = ["promote", "awareness", "mention", "testimonial", "event", "ambassador", "endorse"];
const SERVICE_CHANNELS = new Set(["chat"]);

/**
 * Deterministic router (classifier v1). Phase 2 change per the Phase 0.5
 * §6.1 fold decision: `ambassador` is NOT a platform-level agent —
 * promotion/awareness topics now route to `marketing` (the content path),
 * where the ambassador persona survives as a prompt-variant config. The
 * ambassador bound executor is retained in lib/agents/executors.ts.
 */
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
    return { agent: "marketing", reason: "topic is promotion/awareness (ambassador folded to content path)" };
  }
  return { agent: "marketing", reason: "default marketing" };
}

export interface RunRecordParams {
  tenantId: number;
  /** registry slug (legacy agent_runs.agent TEXT column) */
  agent: string;
  trigger: string;
  /** legacy column; Phase 2 writes a real sha-256 prompt hash here */
  promptHash?: string | null;
  outputRef?: string | null;
  /** Phase 2 attribution columns (all optional; additive) */
  agentId?: number | null;
  businessUnitId?: number | null;
  promptVersionId?: number | null;
  topic?: string | null;
  model?: string | null;
  status?: "completed" | "failed";
  startedAt?: Date | null;
  completedAt?: Date | null;
  durationMs?: number | null;
  inputTokens?: number | null;
  outputTokens?: number | null;
  estimatedCost?: number | null;
  error?: string | null;
  errorClass?: string | null;
}

/**
 * Run record (§71). Phase 2: rows carry registry attribution (agent_id,
 * business_unit_id, prompt_version_id), real prompt hashes, timing, and
 * failure information. The legacy "always completed" behavior is corrected:
 * failed executions are recorded as failed with an error class, while the
 * old call shape keeps working unchanged (defaults preserved).
 */
export async function recordRun(p: RunRecordParams): Promise<{ runId: number }> {
  const rows = await query<{ id: number }>(
    `INSERT INTO agent_runs (
       tenant_id, agent, trigger, status, prompt_hash, output_ref,
       agent_id, business_unit_id, prompt_version_id, topic, model,
       started_at, completed_at, duration_ms, input_tokens, output_tokens,
       estimated_cost, error, error_class
     )
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19)
     RETURNING id`,
    [
      p.tenantId,
      p.agent,
      p.trigger,
      p.status ?? "completed",
      p.promptHash ?? null,
      p.outputRef ?? null,
      p.agentId ?? null,
      p.businessUnitId ?? null,
      p.promptVersionId ?? null,
      p.topic ?? null,
      p.model ?? null,
      p.startedAt ?? null,
      p.completedAt ?? null,
      p.durationMs ?? null,
      p.inputTokens ?? null,
      p.outputTokens ?? null,
      p.estimatedCost ?? null,
      p.error ? p.error.slice(0, 2000) : null,
      p.errorClass ?? null,
    ]
  );
  return { runId: rows[0].id };
}

/** Coarse error taxonomy for run records (token-accurate costing is Phase 4). */
export function classifyError(e: unknown): string {
  const msg = e instanceof Error ? e.message : String(e);
  if (/insufficient_quota|billing|429/.test(msg)) return "provider_quota";
  if (/timeout|ETIMEDOUT|aborted/i.test(msg)) return "timeout";
  if (/llm (complete|embed) 4\d\d/.test(msg)) return "provider_request";
  if (/llm (complete|embed) 5\d\d/.test(msg)) return "provider_unavailable";
  return "internal";
}
