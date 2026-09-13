import { NextResponse } from "next/server";
import { requirePermission } from "@/lib/auth/guards";
import { updateSchedule, deleteSchedule, ResearchServiceError } from "@/lib/research/service";
import type { ResearchCadence } from "@/lib/research/types";
import { writeAudit, requestIdFor } from "@/lib/audit";

export const runtime = "nodejs";

const CADENCES: ResearchCadence[] = ["hourly", "daily", "weekly"];

/**
 * /api/admin/research/schedules/[id] (Phase 7).
 *  PATCH  — research.manage: {enabled?, cadence?, topic?, queries?, maxItems?}
 *  DELETE — research.manage: remove the schedule (findings are retained;
 *           the column is ON DELETE SET NULL by design).
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

  const cadence = body.cadence != null ? String(body.cadence) : null;
  if (cadence !== null && !CADENCES.includes(cadence as ResearchCadence)) {
    return NextResponse.json({ errors: [{ code: "INVALID_CADENCE", detail: `cadence must be one of ${CADENCES.join(", ")}` }] }, { status: 400 });
  }

  try {
    const schedule = await updateSchedule(id, {
      enabled: typeof body.enabled === "boolean" ? body.enabled : undefined,
      cadence: (cadence as ResearchCadence) ?? undefined,
      topic: typeof body.topic === "string" && body.topic.trim() !== "" ? body.topic.trim() : undefined,
      queries: Array.isArray(body.queries)
        ? body.queries.map((q) => String(q).trim()).filter((q) => q !== "").slice(0, 4)
        : undefined,
      maxItems: body.maxItems != null ? Number(body.maxItems) : undefined,
    });
    if (!schedule) {
      return NextResponse.json({ errors: [{ code: "NOT_FOUND" }] }, { status: 404 });
    }
    await writeAudit({
      actorType: "user", actorId: gate.ctx.user?.id ?? null,
      action: "research.schedule.update", resource: "research_schedules", resourceId: id,
      result: "success", requestId,
      metadata: { enabled: schedule.enabled, cadence: schedule.cadence },
    });
    return NextResponse.json({ data: { schedule }, meta: { requestId } });
  } catch (e) {
    if (e instanceof ResearchServiceError) {
      return NextResponse.json({ errors: [{ code: e.code, detail: e.message }] }, { status: 400 });
    }
    throw e;
  }
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

  const deleted = await deleteSchedule(id);
  await writeAudit({
    actorType: "user", actorId: gate.ctx.user?.id ?? null,
    action: "research.schedule.delete", resource: "research_schedules", resourceId: id,
    result: deleted ? "success" : "denied", requestId,
    metadata: deleted ? {} : { reason: "not_found" },
  });
  if (!deleted) {
    return NextResponse.json({ errors: [{ code: "NOT_FOUND" }] }, { status: 404 });
  }
  return NextResponse.json({ data: { deleted: true }, meta: { requestId } });
}
