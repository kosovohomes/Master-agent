import { NextResponse } from "next/server";
import { requirePermission } from "@/lib/auth/guards";
import { processInquiry } from "@/lib/sales/tasks";
import { isFlagEnabled } from "@/lib/settings";
import { writeAudit, requestIdFor } from "@/lib/audit";
import { SalesServiceError } from "@/lib/sales/types";
import { BudgetExceededError } from "@/lib/ai";

export const runtime = "nodejs";

/**
 * /api/admin/sales/classify (Phase 12) — re-run the §55 classification +
 * scoring pipeline on an inquiry (new or classified). THE LLM-leg trigger:
 * sales flag OFF → 423 FLAG_DISABLED (fail-closed; nothing degrades
 * silently for an operator action — they asked for the LLM leg, they must
 * know it did not run). Gateway-attributed purpose="sales". Audited.
 */
export async function POST(req: Request) {
  const requestId = requestIdFor(req);
  const gate = await requirePermission(req, "sales.manage");
  if (!gate.ok) return gate.response;
  const userId = gate.ctx.user?.id ?? null;

  let body: { inquiryId?: number };
  try {
    body = (await req.json()) as typeof body;
  } catch {
    return NextResponse.json({ errors: [{ code: "INVALID_JSON" }] }, { status: 400 });
  }
  if (!Number.isInteger(body.inquiryId) || (body.inquiryId as number) <= 0) {
    return NextResponse.json({ errors: [{ code: "INVALID_ID", detail: "inquiryId" }] }, { status: 400 });
  }

  if (!(await isFlagEnabled("sales", false))) {
    await writeAudit({
      actorType: "user",
      actorId: userId,
      action: "sales.classify",
      resource: "inquiries",
      resourceId: body.inquiryId as number,
      result: "denied",
      requestId,
      metadata: { reason: "sales_flag_off" },
    });
    return NextResponse.json({ errors: [{ code: "FLAG_DISABLED", detail: "sales flag is OFF" }] }, { status: 423 });
  }

  try {
    const { ai } = await import("@/lib/ai");
    const { getInquiry } = await import("@/lib/sales/service");
    const inquiry = await getInquiry(body.inquiryId as number);
    if (!inquiry) return NextResponse.json({ errors: [{ code: "NOT_FOUND" }] }, { status: 404 });
    const salesLlm = ai.withAttribution({ businessUnitId: inquiry.business_unit_id, purpose: "sales" });
    const outcome = await processInquiry(inquiry.id, { llm: salesLlm, allowLlm: true });
    await writeAudit({
      actorType: "user",
      actorId: userId,
      action: "sales.classify",
      resource: "inquiries",
      resourceId: inquiry.id,
      result: "success",
      requestId,
      metadata: { escalated: outcome.escalated, leadId: outcome.leadId, degraded: outcome.classification.degraded },
    });
    return NextResponse.json({ data: { outcome }, meta: { ts: new Date().toISOString(), requestId } });
  } catch (e) {
    if (e instanceof SalesServiceError) {
      if (e.code === "NOT_FOUND") return NextResponse.json({ errors: [{ code: "NOT_FOUND" }] }, { status: 404 });
      if (e.code === "BAD_STATE") return NextResponse.json({ errors: [{ code: "BAD_STATE", detail: e.message }] }, { status: 409 });
    }
    if (e instanceof BudgetExceededError) {
      return NextResponse.json({ errors: [{ code: "BUDGET_EXCEEDED" }] }, { status: 429 });
    }
    return NextResponse.json({ errors: [{ code: "CLASSIFY_FAILED" }] }, { status: 500 });
  }
}
