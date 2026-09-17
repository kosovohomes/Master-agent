import { NextResponse } from "next/server";
import { requirePermission, requireAnyPermission } from "@/lib/auth/guards";
import { query } from "@/lib/db";
import { listLeads, upsertLead } from "@/lib/sales/service";
import { writeAudit, requestIdFor } from "@/lib/audit";
import { SalesServiceError } from "@/lib/sales/types";

export const runtime = "nodejs";

/**
 * /api/admin/sales/leads (Phase 12).
 *  GET  — sales.manage / audit.read: leads ordered funnel-first (open
 *         stages before won/lost), score descending.
 *  POST — sales.manage: manual lead creation. Dedup = (bu, lower(email))
 *         with the score-ratchet upsert — re-adding an existing contact
 *         updates fields, never regresses the score. Audited.
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

  const leads = await listLeads(buId, 100);
  return NextResponse.json({ data: { leads }, meta: { requestId } });
}

export async function POST(req: Request) {
  const requestId = requestIdFor(req);
  const gate = await requirePermission(req, "sales.manage");
  if (!gate.ok) return gate.response;
  const userId = gate.ctx.user?.id ?? null;

  let body: {
    businessUnitId?: number;
    company?: string;
    contactName?: string;
    contactEmail?: string;
    contactPhone?: string;
    leadScore?: number;
    nextAction?: string;
  };
  try {
    body = (await req.json()) as typeof body;
  } catch {
    return NextResponse.json({ errors: [{ code: "INVALID_JSON" }] }, { status: 400 });
  }
  if (
    !body.company && !body.contactName && !body.contactEmail
  ) {
    return NextResponse.json(
      { errors: [{ code: "INVALID_LEAD_INPUT", detail: "at least one of company, contactName, contactEmail is required" }] },
      { status: 400 }
    );
  }
  if (body.contactEmail !== undefined && body.contactEmail !== null) {
    if (typeof body.contactEmail !== "string" || body.contactEmail.length > 320 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(body.contactEmail)) {
      return NextResponse.json({ errors: [{ code: "INVALID_LEAD_INPUT", detail: "contactEmail" }] }, { status: 400 });
    }
  }
  if (body.leadScore !== undefined && (!Number.isFinite(body.leadScore) || (body.leadScore as number) < 0 || (body.leadScore as number) > 100)) {
    return NextResponse.json({ errors: [{ code: "INVALID_LEAD_INPUT", detail: "leadScore must be 0-100" }] }, { status: 400 });
  }

  const buRaw = body.businessUnitId;
  const buId =
    buRaw && Number.isInteger(buRaw) && buRaw > 0
      ? buRaw
      : (await query<{ id: number }>("SELECT id FROM business_units ORDER BY id ASC LIMIT 1"))[0]?.id;
  if (!buId) return NextResponse.json({ errors: [{ code: "NO_BUSINESS_UNIT" }] }, { status: 400 });

  try {
    const { lead, created } = await upsertLead({
      businessUnitId: buId,
      company: body.company ?? null,
      contactName: body.contactName ?? null,
      contactEmail: body.contactEmail ?? null,
      contactPhone: body.contactPhone ?? null,
      source: "manual",
      leadScore: body.leadScore ?? 0,
      scoredBy: "deterministic",
      scoreRationale: "manual entry — score set by the operator",
      nextAction: body.nextAction ?? null,
      createdByUserId: userId,
    });
    await writeAudit({
      actorType: "user",
      actorId: userId,
      action: "sales.lead.create",
      resource: "leads",
      resourceId: lead.id,
      result: "success",
      requestId,
      metadata: { created, businessUnitId: buId, score: lead.lead_score, band: lead.score_band },
    });
    return NextResponse.json({ data: { lead, created }, meta: { ts: new Date().toISOString(), requestId } }, { status: created ? 201 : 200 });
  } catch (e) {
    if (e instanceof SalesServiceError) {
      return NextResponse.json({ errors: [{ code: e.code, detail: e.message }] }, { status: e.httpStatus });
    }
    return NextResponse.json({ errors: [{ code: "LEAD_CREATE_FAILED" }] }, { status: 500 });
  }
}
