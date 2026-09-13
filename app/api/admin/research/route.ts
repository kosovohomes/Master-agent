import { NextResponse } from "next/server";
import { requireAnyPermission, requirePermission } from "@/lib/auth/guards";
import {
  listItems,
  listSchedules,
  listCompetitors,
  listCompetitorEvents,
  stats,
  createSchedule,
  normalizeSources,
  ResearchServiceError,
} from "@/lib/research/service";
import type { ResearchCadence, ResearchItemStatus } from "@/lib/research/types";
import { isFlagEnabled } from "@/lib/settings";
import { writeAudit, requestIdFor } from "@/lib/audit";

export const runtime = "nodejs";

const CADENCES: ResearchCadence[] = ["hourly", "daily", "weekly"];
const AGENT_SLUGS = ["research", "intelligence", "legal_intelligence", "competitor"];

/**
 * /api/admin/research (Phase 7 — research workforce control surface).
 *  GET  — research.manage / audit.read: items (filterable), schedules,
 *         competitors, competitor events, per-status stats, flag state.
 *  POST — research.manage: create a schedule
 *         {businessUnitId, agentSlug?, name, topic, queries?, cadence?,
 *          maxItems?}. Audited. Spawning stays flag-gated elsewhere.
 */
export async function GET(req: Request) {
  const requestId = requestIdFor(req);
  const gate = await requireAnyPermission(req, ["research.manage", "audit.read"]);
  if (!gate.ok) return gate.response;

  const url = new URL(req.url);
  const buRaw = url.searchParams.get("businessUnitId");
  const businessUnitId = buRaw && /^\d+$/.test(buRaw) ? Number(buRaw) : null;
  const statusRaw = url.searchParams.get("status");
  const status = statusRaw && statusRaw !== "" ? (statusRaw as ResearchItemStatus) : null;

  const [items, schedules, competitors, events, statRows, flag] = await Promise.all([
    listItems({ businessUnitId, status, limit: 100 }),
    listSchedules(businessUnitId),
    listCompetitors(businessUnitId),
    listCompetitorEvents(businessUnitId, 50),
    stats(businessUnitId),
    isFlagEnabled("research", false),
  ]);
  return NextResponse.json({
    data: { items, schedules, competitors, events, stats: statRows, flag },
    meta: { requestId },
  });
}

export async function POST(req: Request) {
  const requestId = requestIdFor(req);
  const gate = await requirePermission(req, "research.manage");
  if (!gate.ok) return gate.response;

  let body: Record<string, unknown>;
  try {
    body = (await req.json()) as Record<string, unknown>;
  } catch {
    return NextResponse.json({ errors: [{ code: "INVALID_JSON" }] }, { status: 400 });
  }

  const businessUnitId = Number(body.businessUnitId);
  if (!Number.isInteger(businessUnitId) || businessUnitId <= 0) {
    return NextResponse.json({ errors: [{ code: "BUSINESS_UNIT_ID_REQUIRED" }] }, { status: 400 });
  }
  const name = String(body.name ?? "").trim();
  if (name === "" || name.length > 120) {
    return NextResponse.json({ errors: [{ code: "INVALID_NAME", detail: "name must be 1-120 chars" }] }, { status: 400 });
  }
  const topic = String(body.topic ?? "").trim();
  if (topic === "" || topic.length > 500) {
    return NextResponse.json({ errors: [{ code: "INVALID_TOPIC", detail: "topic must be 1-500 chars" }] }, { status: 400 });
  }
  const agentSlug = body.agentSlug != null ? String(body.agentSlug) : "research";
  if (!AGENT_SLUGS.includes(agentSlug)) {
    return NextResponse.json({ errors: [{ code: "INVALID_AGENT", detail: `agentSlug must be one of ${AGENT_SLUGS.join(", ")}` }] }, { status: 400 });
  }
  const cadence = body.cadence != null ? String(body.cadence) : "daily";
  if (!CADENCES.includes(cadence as ResearchCadence)) {
    return NextResponse.json({ errors: [{ code: "INVALID_CADENCE", detail: `cadence must be one of ${CADENCES.join(", ")}` }] }, { status: 400 });
  }
  const queries = Array.isArray(body.queries)
    ? body.queries.map((q) => String(q).trim()).filter((q) => q !== "").slice(0, 4)
    : [];
  const sources = normalizeSources(body.sources);

  try {
    const schedule = await createSchedule({
      businessUnitId,
      agentSlug,
      name,
      topic,
      queries,
      sources,
      cadence: cadence as ResearchCadence,
      maxItems: body.maxItems != null ? Number(body.maxItems) : undefined,
    });
    await writeAudit({
      actorType: "user",
      actorId: gate.ctx.user?.id ?? null,
      action: "research.schedule.create",
      resource: "research_schedules",
      resourceId: schedule.id,
      result: "success",
      requestId,
      metadata: { businessUnitId, agentSlug, cadence: schedule.cadence, name: schedule.name, sources: schedule.sources.length },
    });
    return NextResponse.json({ data: { schedule }, meta: { requestId } });
  } catch (e) {
    if (e instanceof ResearchServiceError) {
      const status = e.code === "NOT_FOUND" ? 404 : 400;
      await writeAudit({
        actorType: "user", actorId: gate.ctx.user?.id ?? null,
        action: "research.schedule.create", resource: "research_schedules",
        result: "denied", requestId, metadata: { code: e.code, detail: e.message },
      });
      return NextResponse.json({ errors: [{ code: e.code, detail: e.message }] }, { status });
    }
    throw e;
  }
}
