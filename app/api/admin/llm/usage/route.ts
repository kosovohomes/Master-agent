import { NextResponse } from "next/server";
import { requireAnyPermission } from "@/lib/auth/guards";
import { usageRollup } from "@/lib/ai/usage";
import { requestIdFor } from "@/lib/audit";
import { query } from "@/lib/db";

export const runtime = "nodejs";

/**
 * /api/admin/llm/usage (Phase 4 — P4 acceptance: "cost per agent/BU/task/
 * month visible"). GET — llm.view (or the staff-read set): rollups of the
 * llm_requests ledger by agent / business unit / model / purpose / task,
 * plus totals and the latest raw rows. `?months=1..24`,
 * `?businessUnitId=` scope.
 */
export async function GET(req: Request) {
  const requestId = requestIdFor(req);
  const gate = await requireAnyPermission(req, ["llm.view", "audit.read", "agents.manage"]);
  if (!gate.ok) return gate.response;

  const url = new URL(req.url);
  const monthsRaw = url.searchParams.get("months");
  const months = monthsRaw && /^\d+$/.test(monthsRaw) ? Number(monthsRaw) : 3;
  const buRaw = url.searchParams.get("businessUnitId");
  const businessUnitId = buRaw && /^\d+$/.test(buRaw) ? Number(buRaw) : null;

  const [byAgent, byBu, byModel, byPurpose, byTask] = await Promise.all([
    usageRollup("agent", months, businessUnitId),
    usageRollup("bu", months, businessUnitId),
    usageRollup("model", months, businessUnitId),
    usageRollup("purpose", months, businessUnitId),
    usageRollup("task", months, businessUnitId),
  ]);

  const recent = await query<{
    id: number;
    agent_slug: string | null;
    model: string;
    kind: string;
    status: string;
    error_code: string | null;
    total_tokens: number | null;
    cost_usd: string;
    latency_ms: number | null;
    attempt_no: number;
    created_at: string;
  }>(
    `SELECT id, agent_slug, model, kind, status, error_code, total_tokens,
            cost_usd::text AS cost_usd, latency_ms, attempt_no, created_at
     FROM llm_requests
     ${businessUnitId != null ? "WHERE business_unit_id = $1" : ""}
     ORDER BY id DESC LIMIT 50`,
    businessUnitId != null ? [businessUnitId] : []
  );

  const totals = byBu.reduce(
    (acc, r) => {
      acc.calls += r.calls;
      acc.costUsd += r.costUsd;
      acc.promptTokens += r.promptTokens;
      acc.completionTokens += r.completionTokens;
      return acc;
    },
    { calls: 0, costUsd: 0, promptTokens: 0, completionTokens: 0 }
  );

  return NextResponse.json({
    data: {
      windowMonths: Math.max(1, Math.min(24, months)),
      totals,
      byAgent,
      byBu,
      byModel,
      byPurpose,
      byTask,
      recent: recent.map((r) => ({
        id: r.id,
        agentSlug: r.agent_slug,
        model: r.model,
        kind: r.kind,
        status: r.status,
        errorCode: r.error_code,
        totalTokens: r.total_tokens,
        costUsd: Number(r.cost_usd),
        latencyMs: r.latency_ms,
        attemptNo: r.attempt_no,
        createdAt: r.created_at,
      })),
    },
    meta: { requestId },
  });
}
