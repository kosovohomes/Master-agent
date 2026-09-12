/**
 * Usage / cost ledger (Phase 4 — `llm_requests`, §24).
 *
 * One row per gateway attempt: ok, error, budget_blocked, rate_limited.
 * Blocked/failed rows cost $0 but keep the observability trail — a runaway
 * agent shows up as blocked rows, not silence. Cost math happens in the
 * gateway via model_prices; this module is pure persistence + rollups.
 */
import { query } from "../db";
import type { GatewayAttribution } from "./types";

export type LlmRequestStatus = "ok" | "error" | "budget_blocked" | "rate_limited";

export interface RecordRequestInput {
  provider: string;
  kind: "chat" | "embed";
  model: string;
  status: LlmRequestStatus;
  attribution?: GatewayAttribution | null;
  promptTokens?: number | null;
  completionTokens?: number | null;
  totalTokens?: number | null;
  costUsd?: number | null;
  latencyMs?: number | null;
  attemptNo?: number;
  errorCode?: string | null;
  metadata?: Record<string, unknown>;
}

export async function recordRequest(p: RecordRequestInput): Promise<number | null> {
  // Never let ledger failures break the calling path (the provider result
  // still returns to the executor); observability degrades, work doesn't.
  try {
    const rows = await query<{ id: number }>(
      `INSERT INTO llm_requests (
         business_unit_id, agent_id, agent_slug, task_id, provider, kind, model,
         status, error_code, prompt_tokens, completion_tokens, total_tokens,
         cost_usd, latency_ms, attempt_no, purpose, metadata
       ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17::jsonb)
       RETURNING id`,
      [
        p.attribution?.businessUnitId ?? null,
        p.attribution?.agentId ?? null,
        p.attribution?.agentSlug ?? null,
        p.attribution?.taskId ?? null,
        p.provider,
        p.kind,
        p.model,
        p.status,
        p.errorCode ?? null,
        p.promptTokens ?? null,
        p.completionTokens ?? null,
        p.totalTokens ?? null,
        p.costUsd ?? 0,
        p.latencyMs ?? null,
        p.attemptNo ?? 1,
        p.attribution?.purpose ?? null,
        JSON.stringify(p.metadata ?? {}),
      ]
    );
    return rows[0].id;
  } catch (e) {
    console.error("[ai/usage] llm_requests insert failed", e instanceof Error ? e.message : e);
    return null;
  }
}

/**
 * Post-run link: agent_runs rows are recorded AFTER execution (Phase 2
 * design), so llm_requests rows written during the run are back-linked to
 * the run id in the same request that records the run.
 */
export async function linkRun(p: {
  runId: number;
  agentId: number | null;
  businessUnitId: number | null;
  since: Date;
}): Promise<void> {
  if (p.agentId == null && p.businessUnitId == null) return;
  try {
    await query(
      `UPDATE llm_requests SET agent_run_id = $1
       WHERE agent_run_id IS NULL
         AND created_at >= $4
         AND (($2::bigint IS NOT NULL AND agent_id = $2) OR ($2::bigint IS NULL AND agent_id IS NULL AND $3::bigint IS NOT NULL AND business_unit_id = $3))`,
      [p.runId, p.agentId, p.businessUnitId, p.since]
    );
  } catch (e) {
    console.error("[ai/usage] linkRun failed", e instanceof Error ? e.message : e);
  }
}

/** Token-accurate totals for one run (feeds agent_runs token/cost columns). */
export async function runTotals(runId: number): Promise<{
  promptTokens: number;
  completionTokens: number;
  costUsd: number;
}> {
  const rows = await query<{ pt: string | null; ct: string | null; cost: string | null }>(
    `SELECT SUM(prompt_tokens)::text AS pt, SUM(completion_tokens)::text AS ct, SUM(cost_usd)::text AS cost
     FROM llm_requests WHERE agent_run_id = $1`,
    [runId]
  );
  return {
    promptTokens: Number(rows[0]?.pt ?? 0),
    completionTokens: Number(rows[0]?.ct ?? 0),
    costUsd: Number(rows[0]?.cost ?? 0),
  };
}

/** Spend for a scope since a timestamp — the budget pre-check primitive. */
export async function spendSince(
  scope: { businessUnitId?: number | null; agentId?: number | null; taskId?: number | null },
  since?: Date | null
): Promise<number> {
  const conds: string[] = [];
  const args: unknown[] = [];
  if (scope.businessUnitId != null) {
    args.push(scope.businessUnitId);
    conds.push(`business_unit_id = $${args.length}`);
  }
  if (scope.agentId != null) {
    args.push(scope.agentId);
    conds.push(`agent_id = $${args.length}`);
  }
  if (scope.taskId != null) {
    args.push(scope.taskId);
    conds.push(`task_id = $${args.length}`);
  }
  if (conds.length === 0) return 0;
  if (since) {
    args.push(since);
    conds.push(`created_at >= $${args.length}`);
  }
  const rows = await query<{ total: string | null }>(
    `SELECT SUM(cost_usd)::text AS total FROM llm_requests WHERE ${conds.join(" AND ")}`,
    args
  );
  return Number(rows[0]?.total ?? 0);
}

export interface UsageRollupRow {
  bucket: string; // month (YYYY-MM)
  label: string; // agent slug / BU name / model / purpose
  calls: number;
  promptTokens: number;
  completionTokens: number;
  costUsd: number;
}

/**
 * Cost per agent / BU / model / purpose per month (P4 acceptance:
 * "cost per agent/BU/task/month visible"). groupBy selects the dimension;
 * task rollup exposes the task id as the label.
 */
export async function usageRollup(
  groupBy: "agent" | "bu" | "model" | "purpose" | "task",
  months = 3,
  businessUnitId?: number | null
): Promise<UsageRollupRow[]> {
  const labelExpr =
    groupBy === "agent"
      ? "COALESCE(a.slug, '(unattributed)')"
      : groupBy === "bu"
        ? "COALESCE(b.name, '(unattributed)')"
        : groupBy === "model"
          ? "l.model"
          : groupBy === "purpose"
            ? "COALESCE(l.purpose, '(none)')"
            : "COALESCE(l.task_id::text, '(none)')";
  const joinExpr =
    groupBy === "agent"
      ? "LEFT JOIN agents a ON a.id = l.agent_id"
      : groupBy === "bu"
        ? "LEFT JOIN business_units b ON b.id = l.business_unit_id"
        : "";
  const buCond = businessUnitId != null ? "WHERE l.business_unit_id = $1" : "";
  const args = businessUnitId != null ? [businessUnitId] : [];
  const rows = await query<{
    bucket: string;
    label: string;
    calls: string;
    pt: string | null;
    ct: string | null;
    cost: string | null;
  }>(
    `SELECT to_char(date_trunc('month', l.created_at), 'YYYY-MM') AS bucket,
            ${labelExpr} AS label,
            count(*)::text AS calls,
            SUM(l.prompt_tokens)::text AS pt,
            SUM(l.completion_tokens)::text AS ct,
            SUM(l.cost_usd)::text AS cost
     FROM llm_requests l ${joinExpr}
     ${buCond ? buCond + " AND " : "WHERE "}l.created_at >= date_trunc('month', now()) - make_interval(months => $${args.length + 1})
     GROUP BY 1, 2
     ORDER BY 1 DESC, cost DESC`,
    [...args, Math.max(1, Math.min(24, months))]
  );
  return rows.map((r) => ({
    bucket: r.bucket,
    label: r.label,
    calls: Number(r.calls),
    promptTokens: Number(r.pt ?? 0),
    completionTokens: Number(r.ct ?? 0),
    costUsd: Number(r.cost ?? 0),
  }));
}
