import { NextResponse } from "next/server";
import { requirePermission } from "@/lib/auth/guards";
import { buScopeForUser } from "@/lib/auth/rbac";
import { rateLimit, clientIp } from "@/lib/security/ratelimit";
import { writeAudit, requestIdFor } from "@/lib/audit";
import { cancelPlan, getPlan } from "@/lib/supervisor/service";

export const runtime = "nodejs";

/**
 * POST /api/admin/supervisor/plans/[id]/cancel (Phase 15, roadmap P14).
 *
 * Operator stop for an open plan: cancels the planning task + every
 * non-terminal delegated child, blocks the never-delegated steps, closes the
 * plan as `cancelled` (once — guarded transition). supervisor.manage +
 * scope check; rate limited; audited with the outcome.
 */
export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const requestId = requestIdFor(req);
  const ip = clientIp(req);

  const rl = await rateLimit(`supervisor-cancel:${ip}`, 10, 60 * 1000);
  if (!rl.allowed) {
    return NextResponse.json({ errors: [{ code: "RATE_LIMITED" }] }, { status: 429, headers: { "Retry-After": String(rl.retryAfterSec) } });
  }

  const gate = await requirePermission(req, "supervisor.manage");
  if (!gate.ok) return gate.response;
  const user = gate.ctx.user;

  const planId = Number((await params).id);
  if (!Number.isInteger(planId)) {
    return NextResponse.json({ errors: [{ code: "INVALID_PLAN" }] }, { status: 400 });
  }

  const plan = await getPlan(planId);
  if (!plan) {
    return NextResponse.json({ errors: [{ code: "PLAN_NOT_FOUND" }] }, { status: 404 });
  }

  const scope = user ? await buScopeForUser(user.id) : { kind: "list" as const, businessUnitIds: [] };
  if (scope.kind !== "all" && !scope.businessUnitIds.includes(plan.business_unit_id)) {
    return NextResponse.json({ errors: [{ code: "PLAN_NOT_FOUND" }] }, { status: 404 });
  }

  const result = await cancelPlan(planId, user ? `user:${user.id}` : "ops:bearer");
  await writeAudit({
    actorType: user ? "user" : "system",
    actorId: user?.id ?? null,
    action: "supervisor.plan_cancel",
    resource: "supervisor_plans",
    resourceId: planId,
    result: "success",
    requestId,
    ip,
    metadata: { tasksCancelled: result?.cancelled ?? 0, planStatus: plan.status, noop: !(result?.ok ?? false) },
  });

  return NextResponse.json({
    data: { planId, ok: result?.ok ?? false, tasksCancelled: result?.cancelled ?? 0 },
    meta: { requestId },
  });
}
