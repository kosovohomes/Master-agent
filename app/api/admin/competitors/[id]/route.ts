import { NextResponse } from "next/server";
import { requirePermission } from "@/lib/auth/guards";
import { updateCompetitor, deleteCompetitor } from "@/lib/research/service";
import { writeAudit, requestIdFor } from "@/lib/audit";

export const runtime = "nodejs";

/**
 * /api/admin/competitors/[id] (Phase 7).
 *  PATCH  — research.manage: {enabled?, url?, notes?}
 *  DELETE — research.manage: untrack (events cascade; findings keep their
 *           citations — they are evidence, not registry rows).
 */
export async function PATCH(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const requestId = requestIdFor(req);
  const gate = await requirePermission(req, "research.manage");
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

  const url = body.url != null && String(body.url).trim() !== "" ? String(body.url).trim() : null;
  if (body.url != null && url !== null && !/^https?:\/\//i.test(url)) {
    return NextResponse.json({ errors: [{ code: "INVALID_URL", detail: "url must start with http(s)://" }] }, { status: 400 });
  }

  const competitor = await updateCompetitor(id, {
    enabled: typeof body.enabled === "boolean" ? body.enabled : undefined,
    url,
    notes: body.notes != null ? String(body.notes).slice(0, 1000) : undefined,
  });
  if (!competitor) {
    return NextResponse.json({ errors: [{ code: "NOT_FOUND" }] }, { status: 404 });
  }
  await writeAudit({
    actorType: "user", actorId: gate.ctx.user?.id ?? null,
    action: "research.competitor.update", resource: "competitors", resourceId: id,
    result: "success", requestId, metadata: { enabled: competitor.enabled },
  });
  return NextResponse.json({ data: { competitor }, meta: { requestId } });
}

export async function DELETE(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const requestId = requestIdFor(req);
  const gate = await requirePermission(req, "research.manage");
  if (!gate.ok) return gate.response;

  const { id: idRaw } = await ctx.params;
  const id = Number(idRaw);
  if (!Number.isInteger(id) || id <= 0) {
    return NextResponse.json({ errors: [{ code: "INVALID_ID" }] }, { status: 400 });
  }

  const deleted = await deleteCompetitor(id);
  await writeAudit({
    actorType: "user", actorId: gate.ctx.user?.id ?? null,
    action: "research.competitor.delete", resource: "competitors", resourceId: id,
    result: deleted ? "success" : "denied", requestId,
    metadata: deleted ? {} : { reason: "not_found" },
  });
  if (!deleted) {
    return NextResponse.json({ errors: [{ code: "NOT_FOUND" }] }, { status: 404 });
  }
  return NextResponse.json({ data: { deleted: true }, meta: { requestId } });
}
