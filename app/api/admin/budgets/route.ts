import { NextResponse } from "next/server";
import { requireAnyPermission, requirePermission } from "@/lib/auth/guards";
import { listBudgets, upsertBudget } from "@/lib/ai/budgets";
import { writeAudit, requestIdFor } from "@/lib/audit";

export const runtime = "nodejs";

/**
 * /api/admin/budgets (Phase 4, SEC-L9 — budgets as first-class objects).
 *  GET  — llm.view / audit.read / budgets.manage: current budget objects.
 *  POST — budgets.manage: create or upsert one budget:
 *         {scopeType: "business_unit"|"agent", scopeId, period:
 *          "daily"|"monthly", limitUsd, enabled?}. Audited.
 */
export async function GET(req: Request) {
  const requestId = requestIdFor(req);
  const gate = await requireAnyPermission(req, ["llm.view", "audit.read", "budgets.manage"]);
  if (!gate.ok) return gate.response;
  return NextResponse.json({ data: { budgets: await listBudgets() }, meta: { requestId } });
}

export async function POST(req: Request) {
  const requestId = requestIdFor(req);
  const gate = await requirePermission(req, "budgets.manage");
  if (!gate.ok) return gate.response;

  let body: {
    scopeType?: string;
    scopeId?: number;
    period?: string;
    limitUsd?: number;
    enabled?: boolean;
  };
  try {
    body = (await req.json()) as typeof body;
  } catch {
    return NextResponse.json({ errors: [{ code: "INVALID_JSON" }] }, { status: 400 });
  }

  const scopeType = body.scopeType;
  const period = body.period;
  if (scopeType !== "business_unit" && scopeType !== "agent") {
    return NextResponse.json({ errors: [{ code: "INVALID_SCOPE_TYPE" }] }, { status: 400 });
  }
  if (period !== "daily" && period !== "monthly") {
    return NextResponse.json({ errors: [{ code: "INVALID_PERIOD" }] }, { status: 400 });
  }
  if (!Number.isInteger(body.scopeId) || (body.scopeId as number) <= 0) {
    return NextResponse.json({ errors: [{ code: "INVALID_SCOPE_ID" }] }, { status: 400 });
  }
  if (typeof body.limitUsd !== "number" || !Number.isFinite(body.limitUsd) || body.limitUsd < 0) {
    return NextResponse.json({ errors: [{ code: "INVALID_LIMIT" }] }, { status: 400 });
  }

  try {
    const budget = await upsertBudget({
      scopeType,
      scopeId: body.scopeId as number,
      period,
      limitUsd: body.limitUsd,
      enabled: body.enabled ?? true,
      createdByUserId: gate.ctx.user?.id ?? null,
    });
    await writeAudit({
      actorType: "user",
      actorId: gate.ctx.user?.id ?? null,
      action: "budgets.upsert",
      resource: "budgets",
      resourceId: budget.id,
      result: "success",
      requestId,
      metadata: { scopeType, scopeId: body.scopeId, period, limitUsd: body.limitUsd, enabled: budget.enabled },
    });
    return NextResponse.json({ data: { budget }, meta: { requestId } });
  } catch (e) {
    // Scope existence is enforced by nothing in v1 (soft reference) — but a
    // truly malformed request surfaces as a 400, not a 500.
    const detail = e instanceof Error ? e.message : "invalid budget";
    return NextResponse.json({ errors: [{ code: "BUDGET_INVALID", detail }] }, { status: 400 });
  }
}
