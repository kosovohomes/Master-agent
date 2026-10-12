import { NextResponse } from "next/server";
import { requirePermission } from "@/lib/auth/guards";
import { buScopeForUser } from "@/lib/auth/rbac";
import { requestIdFor } from "@/lib/audit";
import { getPlanDetail } from "@/lib/supervisor/service";
import { settleSupervisorPlan } from "@/lib/supervisor/monitor";
import { query } from "@/lib/db";

export const runtime = "nodejs";

/**
 * GET /api/admin/supervisor/plans/[id] (Phase 15, roadmap P14).
 *
 * Plan detail with §23 handoff log + child tasks + measured LLM spend.
 * Settle-on-touch: an open plan is advanced deterministically on read (the
 * same settle pattern the workflow engine uses), so the owner never stares
 * at a stale graph between cron passes. Scope: supervisor.manage +
 * buScopeForUser defense-in-depth (cross-scope plan reads 404, not 403 —
 * existence is not disclosed, mirroring the analytics routes).
 */
export async function GET(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const requestId = requestIdFor(req);
  const gate = await requirePermission(req, "supervisor.manage");
  if (!gate.ok) return gate.response;
  const user = gate.ctx.user;

  const planId = Number((await params).id);
  if (!Number.isInteger(planId)) {
    return NextResponse.json({ errors: [{ code: "INVALID_PLAN" }] }, { status: 400 });
  }

  const detail = await getPlanDetail(planId);
  if (!detail) {
    return NextResponse.json({ errors: [{ code: "PLAN_NOT_FOUND" }] }, { status: 404 });
  }

  const scope = user ? await buScopeForUser(user.id) : { kind: "list" as const, businessUnitIds: [] };
  if (scope.kind !== "all" && !scope.businessUnitIds.includes(detail.plan.business_unit_id)) {
    return NextResponse.json({ errors: [{ code: "PLAN_NOT_FOUND" }] }, { status: 404 });
  }

  await settleSupervisorPlan(planId);
  const fresh = await getPlanDetail(planId);

  const taskIds = (fresh?.handoffs ?? []).map((h) => h.task_id).filter((t): t is number => t != null);
  const childTasks = taskIds.length
    ? await query<{ id: number; kind: string; status: string; error: string | null; result: Record<string, unknown> | null; budget_usd: string | null }>(
        `SELECT id, kind, status, error, result, budget_usd FROM tasks WHERE id = ANY($1::bigint[]) ORDER BY id ASC`,
        [taskIds]
      )
    : [];

  return NextResponse.json({ data: { ...fresh, childTasks }, meta: { requestId } });
}
