import { NextResponse } from "next/server";
import { requirePermission } from "@/lib/auth/guards";
import { updateSegment, deleteSegment } from "@/lib/marketing/service";
import { MarketingServiceError } from "@/lib/marketing/types";
import { writeAudit, requestIdFor } from "@/lib/audit";

export const runtime = "nodejs";

/**
 * /api/admin/marketing/segments/[id] (Phase 11).
 *  PATCH  — marketing.manage: {name?, description?, criteria?, estimatedSize?}.
 *           Audited.
 *  DELETE — marketing.manage: remove the segment. Campaigns referencing it
 *           keep their rows (FK ON DELETE SET NULL). Audited.
 */
export async function PATCH(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const requestId = requestIdFor(req);
  const gate = await requirePermission(req, "marketing.manage");
  if (!gate.ok) return gate.response;

  const { id: idRaw } = await ctx.params;
  const id = Number(idRaw);
  if (!Number.isInteger(id) || id <= 0) {
    return NextResponse.json({ errors: [{ code: "INVALID_ID" }] }, { status: 400 });
  }

  let body: Record<string, unknown>;
  try {
    body = (await req.json()) as Record<string, unknown>;
  } catch {
    return NextResponse.json({ errors: [{ code: "INVALID_JSON" }] }, { status: 400 });
  }

  try {
    const segment = await updateSegment(id, {
      name: typeof body.name === "string" ? body.name : undefined,
      description: body.description !== undefined ? (typeof body.description === "string" ? body.description : null) : undefined,
      criteria: (body.criteria as Record<string, unknown> | undefined) ?? undefined,
      estimatedSize: body.estimatedSize !== undefined ? Number(body.estimatedSize) : undefined,
    });
    await writeAudit({
      actorType: "user",
      actorId: gate.ctx.user?.id ?? null,
      action: "marketing.segment.update",
      resource: "audience_segments",
      resourceId: segment.id,
      result: "success",
      requestId,
      metadata: { name: segment.name },
    });
    return NextResponse.json({ data: { segment }, meta: { requestId } });
  } catch (e) {
    const code = e instanceof MarketingServiceError ? e.code : "SEGMENT_UPDATE_FAILED";
    const status = code === "NOT_FOUND" ? 404 : code === "DUPLICATE" ? 409 : code === "BAD_NAME" ? 400 : 500;
    return NextResponse.json({ errors: [{ code }] }, { status });
  }
}

export async function DELETE(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const requestId = requestIdFor(req);
  const gate = await requirePermission(req, "marketing.manage");
  if (!gate.ok) return gate.response;

  const { id: idRaw } = await ctx.params;
  const id = Number(idRaw);
  if (!Number.isInteger(id) || id <= 0) {
    return NextResponse.json({ errors: [{ code: "INVALID_ID" }] }, { status: 400 });
  }

  const deleted = await deleteSegment(id);
  await writeAudit({
    actorType: "user",
    actorId: gate.ctx.user?.id ?? null,
    action: "marketing.segment.delete",
    resource: "audience_segments",
    resourceId: id,
    result: deleted ? "success" : "failure",
    requestId,
    metadata: {},
  });
  if (!deleted) return NextResponse.json({ errors: [{ code: "NOT_FOUND" }] }, { status: 404 });
  return NextResponse.json({ data: { deleted: true }, meta: { requestId } });
}
