import { NextResponse } from "next/server";
import { requirePermission, requireAnyPermission } from "@/lib/auth/guards";
import { getLead, transitionLead, updateLeadActions } from "@/lib/sales/service";
import { SalesServiceError, LEAD_FLOW, type LeadStage } from "@/lib/sales/types";
import { writeAudit, requestIdFor } from "@/lib/audit";

export const runtime = "nodejs";

const STAGES = Object.keys(LEAD_FLOW) as LeadStage[];

/**
 * /api/admin/sales/leads/[id] (Phase 12).
 *  GET   — sales.manage / audit.read: lead detail.
 *  PATCH — sales.manage: the HUMAN-ONLY stage doorway (§91: lead stages are
 *          human decisions). {to: LeadStage} transitions the funnel FSM;
 *          {nextAction} updates the working note without a stage move.
 *          Audited; transitions stamped with the session user via audit.
 */
export async function GET(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const requestId = requestIdFor(req);
  const gate = await requireAnyPermission(req, ["sales.manage", "audit.read"]);
  if (!gate.ok) return gate.response;

  const { id: idRaw } = await ctx.params;
  const id = Number(idRaw);
  if (!Number.isInteger(id) || id <= 0) {
    return NextResponse.json({ errors: [{ code: "INVALID_ID" }] }, { status: 400 });
  }
  const lead = await getLead(id);
  if (!lead) return NextResponse.json({ errors: [{ code: "NOT_FOUND" }] }, { status: 404 });
  return NextResponse.json({ data: { lead }, meta: { requestId } });
}

export async function PATCH(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const requestId = requestIdFor(req);
  const gate = await requirePermission(req, "sales.manage");
  if (!gate.ok) return gate.response;
  const userId = gate.ctx.user?.id ?? null;

  const { id: idRaw } = await ctx.params;
  const id = Number(idRaw);
  if (!Number.isInteger(id) || id <= 0) {
    return NextResponse.json({ errors: [{ code: "INVALID_ID" }] }, { status: 400 });
  }

  let body: { to?: string; nextAction?: string };
  try {
    body = (await req.json()) as typeof body;
  } catch {
    return NextResponse.json({ errors: [{ code: "INVALID_JSON" }] }, { status: 400 });
  }

  const to = body.to as LeadStage | undefined;
  if (to !== undefined && !STAGES.includes(to)) {
    return NextResponse.json(
      { errors: [{ code: "INVALID_STAGE", detail: `to must be one of ${STAGES.join(", ")}` }] },
      { status: 400 }
    );
  }
  if (to === undefined && body.nextAction === undefined) {
    return NextResponse.json({ errors: [{ code: "INVALID_PATCH", detail: "provide to or nextAction" }] }, { status: 400 });
  }

  try {
    const lead = to
      ? await transitionLead(id, to, { nextAction: body.nextAction ?? null })
      : await updateLeadActions(id, { nextAction: body.nextAction ?? null });
    await writeAudit({
      actorType: "user",
      actorId: userId,
      action: to ? "sales.lead.transition" : "sales.lead.update",
      resource: "leads",
      resourceId: lead.id,
      result: "success",
      requestId,
      metadata: to ? { to, from: lead.stage } : { nextAction: body.nextAction ?? null },
    });
    return NextResponse.json({ data: { lead }, meta: { ts: new Date().toISOString(), requestId } });
  } catch (e) {
    if (e instanceof SalesServiceError) {
      if (e.code === "NOT_FOUND") return NextResponse.json({ errors: [{ code: "NOT_FOUND" }] }, { status: 404 });
      if (e.code === "BAD_TRANSITION") return NextResponse.json({ errors: [{ code: "BAD_TRANSITION", detail: e.message }] }, { status: 409 });
    }
    return NextResponse.json({ errors: [{ code: "LEAD_UPDATE_FAILED" }] }, { status: 500 });
  }
}
