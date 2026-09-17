import { NextResponse } from "next/server";
import { requirePermission, requireAnyPermission } from "@/lib/auth/guards";
import { query } from "@/lib/db";
import { createInquiry, listInquiries } from "@/lib/sales/service";
import { processInquiry } from "@/lib/sales/tasks";
import { isFlagEnabled } from "@/lib/settings";
import { writeAudit, requestIdFor } from "@/lib/audit";
import { emitEvent } from "@/lib/tasks/events";

export const runtime = "nodejs";

/**
 * /api/admin/sales/inquiries (Phase 12).
 *  GET  — sales.manage / audit.read: recent inquiries for a BU.
 *  POST — sales.manage: manual inquiry creation (email/phone walk-ins).
 *         Classified immediately (same §55 pipeline as widget intake,
 *         gateway-attributed purpose="sales", flag-gated LLM leg).
 *         Audited. created_by_user_id = session user.
 */
export async function GET(req: Request) {
  const requestId = requestIdFor(req);
  const gate = await requireAnyPermission(req, ["sales.manage", "audit.read"]);
  if (!gate.ok) return gate.response;

  const url = new URL(req.url);
  const buRaw = url.searchParams.get("businessUnitId");
  const buId =
    buRaw && /^\d+$/.test(buRaw)
      ? Number(buRaw)
      : (await query<{ id: number }>("SELECT id FROM business_units ORDER BY id ASC LIMIT 1"))[0]?.id;
  if (!buId) return NextResponse.json({ errors: [{ code: "NO_BUSINESS_UNIT" }] }, { status: 400 });

  const inquiries = await listInquiries(buId, 100);
  return NextResponse.json({ data: { inquiries }, meta: { requestId } });
}

export async function POST(req: Request) {
  const requestId = requestIdFor(req);
  const gate = await requirePermission(req, "sales.manage");
  if (!gate.ok) return gate.response;
  const userId = gate.ctx.user?.id ?? null;

  let body: {
    businessUnitId?: number;
    name?: string;
    email?: string;
    subject?: string;
    body?: string;
  };
  try {
    body = (await req.json()) as typeof body;
  } catch {
    return NextResponse.json({ errors: [{ code: "INVALID_JSON" }] }, { status: 400 });
  }
  if (typeof body.body !== "string" || body.body.trim() === "" || body.body.length > 5000) {
    return NextResponse.json({ errors: [{ code: "INVALID_INQUIRY_INPUT", detail: "body" }] }, { status: 400 });
  }
  if (body.email !== undefined && body.email !== null && (typeof body.email !== "string" || body.email.length > 320 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(body.email))) {
    return NextResponse.json({ errors: [{ code: "INVALID_INQUIRY_INPUT", detail: "email" }] }, { status: 400 });
  }

  const buRaw = body.businessUnitId;
  const buId =
    buRaw && Number.isInteger(buRaw) && buRaw > 0
      ? buRaw
      : (await query<{ id: number }>("SELECT id FROM business_units ORDER BY id ASC LIMIT 1"))[0]?.id;
  if (!buId) return NextResponse.json({ errors: [{ code: "NO_BUSINESS_UNIT" }] }, { status: 400 });

  const inquiry = await createInquiry({
    businessUnitId: buId,
    name: body.name ?? null,
    email: body.email ?? null,
    subject: body.subject ?? null,
    body: body.body.trim(),
    source: "manual",
    createdByUserId: userId,
  });
  await emitEvent(buId, "sales.inquiry_created", { inquiryId: inquiry.id, source: "manual" });

  const allowLlm = await isFlagEnabled("sales", false);
  const { ai } = await import("@/lib/ai");
  const salesLlm = ai.withAttribution({ businessUnitId: buId, purpose: "sales" });
  const outcome = await processInquiry(inquiry.id, { llm: salesLlm, allowLlm });

  await writeAudit({
    actorType: "user",
    actorId: userId,
    action: "sales.inquiry.create",
    resource: "inquiries",
    resourceId: inquiry.id,
    result: "success",
    requestId,
    metadata: { businessUnitId: buId, source: "manual", leadId: outcome.leadId, escalated: outcome.escalated },
  });

  return NextResponse.json({ data: { inquiry, outcome }, meta: { ts: new Date().toISOString(), requestId } }, { status: 201 });
}
