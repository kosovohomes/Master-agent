import { NextResponse } from "next/server";
import { requirePermission, requireAnyPermission } from "@/lib/auth/guards";
import { createSegment, listSegments } from "@/lib/marketing/service";
import { MarketingServiceError } from "@/lib/marketing/types";
import { writeAudit, requestIdFor } from "@/lib/audit";

export const runtime = "nodejs";

/**
 * /api/admin/marketing/segments (Phase 11 — audience analysis, §468).
 *  GET — marketing.manage / audit.read: list segments.
 *  POST — marketing.manage: create a segment (name, criteria JSON, size).
 *         Audited.
 */
export async function GET(req: Request) {
  const requestId = requestIdFor(req);
  const gate = await requireAnyPermission(req, ["marketing.manage", "audit.read"]);
  if (!gate.ok) return gate.response;
  const url = new URL(req.url);
  const buRaw = url.searchParams.get("businessUnitId");
  const businessUnitId = buRaw && /^\d+$/.test(buRaw) ? Number(buRaw) : null;
  const segments = await listSegments({ businessUnitId });
  return NextResponse.json({ data: { segments }, meta: { requestId } });
}

export async function POST(req: Request) {
  const requestId = requestIdFor(req);
  const gate = await requirePermission(req, "marketing.manage");
  if (!gate.ok) return gate.response;

  let body: Record<string, unknown>;
  try {
    body = (await req.json()) as Record<string, unknown>;
  } catch {
    return NextResponse.json({ errors: [{ code: "INVALID_JSON" }] }, { status: 400 });
  }

  const businessUnitId = Number(body.businessUnitId);
  const name = typeof body.name === "string" ? body.name : "";
  if (!Number.isInteger(businessUnitId) || businessUnitId <= 0) {
    return NextResponse.json({ errors: [{ code: "INVALID_BUSINESS_UNIT" }] }, { status: 400 });
  }
  if (!name.trim()) {
    return NextResponse.json({ errors: [{ code: "INVALID_NAME" }] }, { status: 400 });
  }

  try {
    const segment = await createSegment({
      businessUnitId,
      name,
      description: typeof body.description === "string" ? body.description : null,
      criteria: (body.criteria ?? {}) as Record<string, unknown>,
      estimatedSize: body.estimatedSize != null ? Number(body.estimatedSize) : null,
      userId: gate.ctx.user?.id ?? null,
    });
    await writeAudit({
      actorType: "user",
      actorId: gate.ctx.user?.id ?? null,
      action: "marketing.segment.create",
      resource: "audience_segments",
      resourceId: segment.id,
      result: "success",
      requestId,
      metadata: { name: segment.name, businessUnitId },
    });
    return NextResponse.json({ data: { segment }, meta: { requestId } }, { status: 201 });
  } catch (e) {
    const code = e instanceof MarketingServiceError ? e.code : "SEGMENT_CREATE_FAILED";
    const status = code === "DUPLICATE" ? 409 : code === "BAD_NAME" ? 400 : 500;
    return NextResponse.json({ errors: [{ code }] }, { status });
  }
}
