import { NextResponse } from "next/server";
import { requirePermission } from "@/lib/auth/guards";
import { deleteBudget, setBudgetEnabled, upsertBudget, listBudgets } from "@/lib/ai/budgets";
import { writeAudit, requestIdFor } from "@/lib/audit";

export const runtime = "nodejs";

/**
 * /api/admin/budgets/[id] (Phase 4) — budgets.manage.
 *  PATCH   — {enabled?: boolean, limitUsd?: number}: toggle or re-price a
 *            budget (kill-switch for a runaway scope is `enabled: false`).
 *  DELETE  — remove the budget object entirely. Both audited.
 */
export async function PATCH(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const requestId = requestIdFor(req);
  const gate = await requirePermission(req, "budgets.manage");
  if (!gate.ok) return gate.response;

  const { id } = await ctx.params;
  if (!/^\d+$/.test(id)) {
    return NextResponse.json({ errors: [{ code: "INVALID_ID" }] }, { status: 400 });
  }

  let body: { enabled?: boolean; limitUsd?: number };
  try {
    body = (await req.json()) as typeof body;
  } catch {
    return NextResponse.json({ errors: [{ code: "INVALID_JSON" }] }, { status: 400 });
  }
  if (typeof body.enabled !== "boolean" && typeof body.limitUsd !== "number") {
    return NextResponse.json({ errors: [{ code: "INVALID_BODY", detail: "enabled or limitUsd required" }] }, { status: 400 });
  }
  if (body.limitUsd !== undefined && (!Number.isFinite(body.limitUsd) || body.limitUsd < 0)) {
    return NextResponse.json({ errors: [{ code: "INVALID_LIMIT" }] }, { status: 400 });
  }

  let budget = null;
  if (typeof body.limitUsd === "number") {
    budget = await upsertExisting(Number(id), body.limitUsd, body.enabled);
  } else {
    budget = await setBudgetEnabled(Number(id), body.enabled as boolean);
  }
  if (!budget) {
    return NextResponse.json({ errors: [{ code: "NOT_FOUND" }] }, { status: 404 });
  }
  await writeAudit({
    actorType: "user",
    actorId: gate.ctx.user?.id ?? null,
    action: "budgets.update",
    resource: "budgets",
    resourceId: budget.id,
    result: "success",
    requestId,
    metadata: { enabled: budget.enabled, limitUsd: budget.limitUsd },
  });
  return NextResponse.json({ data: { budget }, meta: { requestId } });
}

export async function DELETE(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const requestId = requestIdFor(req);
  const gate = await requirePermission(req, "budgets.manage");
  if (!gate.ok) return gate.response;

  const { id } = await ctx.params;
  if (!/^\d+$/.test(id)) {
    return NextResponse.json({ errors: [{ code: "INVALID_ID" }] }, { status: 400 });
  }
  const ok = await deleteBudget(Number(id));
  if (!ok) {
    return NextResponse.json({ errors: [{ code: "NOT_FOUND" }] }, { status: 404 });
  }
  await writeAudit({
    actorType: "user",
    actorId: gate.ctx.user?.id ?? null,
    action: "budgets.delete",
    resource: "budgets",
    resourceId: Number(id),
    result: "success",
    requestId,
  });
  return NextResponse.json({ data: { deleted: true }, meta: { requestId } });
}

/** Re-price an existing budget row (keeps scope/period identity). */
async function upsertExisting(id: number, limitUsd: number, enabled?: boolean) {
  const all = await listBudgets();
  const existing = all.find((b) => b.id === id);
  if (!existing) return null;
  return upsertBudget({
    scopeType: existing.scopeType,
    scopeId: existing.scopeId,
    period: existing.period,
    limitUsd,
    enabled: enabled ?? existing.enabled,
  });
}
