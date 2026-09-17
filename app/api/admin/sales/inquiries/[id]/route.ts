import { NextResponse } from "next/server";
import { requirePermission, requireAnyPermission } from "@/lib/auth/guards";
import { getInquiry, transitionInquiry, getMessages } from "@/lib/sales/service";
import { SalesServiceError, INQUIRY_FLOW, type InquiryStatus } from "@/lib/sales/types";
import { writeAudit, requestIdFor } from "@/lib/audit";

export const runtime = "nodejs";

const STATUSES = Object.keys(INQUIRY_FLOW) as InquiryStatus[];

/**
 * /api/admin/sales/inquiries/[id] (Phase 12).
 *  GET   — sales.manage / audit.read: inquiry + its conversation transcript
 *          (visitor/assistant turns only — §65 internal-reasoning shield).
 *  PATCH — sales.manage: THE human escalation doorway. {to: InquiryStatus}
 *          moves the FSM (escalate / resolve / dismiss); a human resolve on
 *          an escalated inquiry is the completion of the §55 loop. Audited.
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
  const inquiry = await getInquiry(id);
  if (!inquiry) return NextResponse.json({ errors: [{ code: "NOT_FOUND" }] }, { status: 404 });

  const messages = inquiry.conversation_id ? await getMessages(inquiry.conversation_id) : [];
  return NextResponse.json({ data: { inquiry, messages }, meta: { requestId } });
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

  let body: { to?: string };
  try {
    body = (await req.json()) as typeof body;
  } catch {
    return NextResponse.json({ errors: [{ code: "INVALID_JSON" }] }, { status: 400 });
  }
  const to = body.to as InquiryStatus;
  if (!STATUSES.includes(to)) {
    return NextResponse.json(
      { errors: [{ code: "INVALID_STATUS", detail: `to must be one of ${STATUSES.join(", ")}` }] },
      { status: 400 }
    );
  }

  try {
    const inquiry = await transitionInquiry(id, to);
    await writeAudit({
      actorType: "user",
      actorId: userId,
      action: "sales.inquiry.transition",
      resource: "inquiries",
      resourceId: inquiry.id,
      result: "success",
      requestId,
      metadata: { to, from: inquiry.status },
    });
    return NextResponse.json({ data: { inquiry }, meta: { ts: new Date().toISOString(), requestId } });
  } catch (e) {
    if (e instanceof SalesServiceError) {
      if (e.code === "NOT_FOUND") return NextResponse.json({ errors: [{ code: "NOT_FOUND" }] }, { status: 404 });
      if (e.code === "BAD_TRANSITION") return NextResponse.json({ errors: [{ code: "BAD_TRANSITION", detail: e.message }] }, { status: 409 });
    }
    return NextResponse.json({ errors: [{ code: "TRANSITION_FAILED" }] }, { status: 500 });
  }
}
