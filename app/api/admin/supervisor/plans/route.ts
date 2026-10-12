import { NextResponse } from "next/server";
import { requirePermission, requireAnyPermission } from "@/lib/auth/guards";
import { buScopeForUser } from "@/lib/auth/rbac";
import { rateLimit, clientIp } from "@/lib/security/ratelimit";
import { isFlagEnabled } from "@/lib/settings";
import { writeAudit, requestIdFor } from "@/lib/audit";
import { createPlan, listPlans, SupervisorPlanError } from "@/lib/supervisor/service";
import { maxPlanBudgetUsd } from "@/lib/supervisor/types";
import { query } from "@/lib/db";

export const runtime = "nodejs";

/**
 * /api/admin/supervisor/plans (Phase 15, roadmap P14 — §57 Supervisor
 * Contract).
 *
 * POST — state a goal. supervisor.manage + `supervisor` flag ON (423 flag
 * drill otherwise) + rate limit (5/min per IP, the agents.run cadence).
 * The permission ENVELOPE (requester's permission keys) is snapshotted onto
 * the plan — delegation can never exceed what the requester holds. Audited.
 *
 * GET — plan list. supervisor.manage (owner/administrator); buScopeForUser
 * is applied defensively even though the permission currently only reaches
 * platform roles.
 */
export async function POST(req: Request) {
  const requestId = requestIdFor(req);
  const ip = clientIp(req);

  const rl = await rateLimit(`supervisor-plans:${ip}`, 5, 60 * 1000);
  if (!rl.allowed) {
    await writeAudit({ actorType: "anonymous", actorLabel: "ip", action: "supervisor.plan", resource: "supervisor_plans", result: "denied", requestId, ip, metadata: { reason: "rate_limited" } });
    return NextResponse.json({ errors: [{ code: "RATE_LIMITED" }] }, { status: 429, headers: { "Retry-After": String(rl.retryAfterSec) } });
  }

  const gate = await requirePermission(req, "supervisor.manage");
  if (!gate.ok) {
    await writeAudit({ actorType: "anonymous", actorLabel: "ip", action: "supervisor.plan", resource: "supervisor_plans", result: "denied", requestId, ip, metadata: { reason: "unauthorized" } });
    return gate.response;
  }
  const user = gate.ctx.user;

  if (!(await isFlagEnabled("supervisor", false))) {
    await writeAudit({ actorType: user ? "user" : "system", actorId: user?.id ?? null, action: "supervisor.plan", resource: "supervisor_plans", result: "denied", requestId, ip, metadata: { reason: "flag_disabled" } });
    return NextResponse.json({ errors: [{ code: "FLAG_DISABLED", detail: "supervisor workforce is flag-off" }] }, { status: 423 });
  }

  let body: {
    objective?: string;
    businessUnitId?: number;
    constraints?: Record<string, unknown>;
    budgetUsd?: number;
    deadline?: string;
  };
  try {
    body = (await req.json()) as typeof body;
  } catch {
    return NextResponse.json({ errors: [{ code: "INVALID_JSON" }] }, { status: 400 });
  }

  // Permission envelope: session users contribute their OWN permission keys;
  // ops-level legacy bearer admission is owner-class trust (`*`).
  const envelope = user ? [...(user.permissions ?? [])] : ["*"];

  try {
    const result = await createPlan(
      {
        objective: String(body.objective ?? ""),
        businessUnitId: Number(body.businessUnitId),
        constraints: body.constraints ?? null,
        budgetUsd: body.budgetUsd != null ? Number(body.budgetUsd) : null,
        deadline: body.deadline ?? null,
      },
      { userId: user?.id ?? null, permissions: envelope, via: gate.ctx.via }
    );
    await writeAudit({
      actorType: user ? "user" : "system",
      actorId: user?.id ?? null,
      actorLabel: user ? undefined : "ops:bearer",
      action: "supervisor.plan",
      resource: "supervisor_plans",
      resourceId: result.planId,
      result: "success",
      requestId,
      ip,
      metadata: {
        businessUnitId: body.businessUnitId,
        taskId: result.taskId,
        budgetUsd: result.budgetUsd,
        deadline: body.deadline ?? null,
        envelopeSize: envelope.length,
      },
    });
    return NextResponse.json(
      { data: { planId: result.planId, taskId: result.taskId, budgetUsd: result.budgetUsd }, meta: { ts: new Date().toISOString(), requestId } },
      { status: 201 }
    );
  } catch (e) {
    if (e instanceof SupervisorPlanError) {
      await writeAudit({ actorType: user ? "user" : "system", actorId: user?.id ?? null, action: "supervisor.plan", resource: "supervisor_plans", result: "denied", requestId, ip, metadata: { reason: e.code } });
      return NextResponse.json({ errors: [{ code: e.code, detail: e.message }] }, { status: e.code === "BU_NOT_FOUND" ? 404 : 400 });
    }
    await writeAudit({ actorType: user ? "user" : "system", actorId: user?.id ?? null, action: "supervisor.plan", resource: "supervisor_plans", result: "failure", requestId, ip, metadata: {} });
    return NextResponse.json({ errors: [{ code: "PLAN_FAILED", detail: "internal error" }] }, { status: 500 });
  }
}

export async function GET(req: Request) {
  const requestId = requestIdFor(req);
  const gate = await requireAnyPermission(req, ["supervisor.manage"]);
  if (!gate.ok) return gate.response;
  const user = gate.ctx.user;

  const scope = user ? await buScopeForUser(user.id) : { kind: "list" as const, businessUnitIds: [] };
  const rows = await listPlans(null, 50);
  const visible = scope.kind === "all" ? rows : rows.filter((p) => scope.businessUnitIds.includes(p.business_unit_id));

  return NextResponse.json({
    data: {
      plans: visible,
      budgetCeilingUsd: maxPlanBudgetUsd(),
      flags: { supervisor: await isFlagEnabled("supervisor", false) },
    },
    meta: { requestId },
  });
}
