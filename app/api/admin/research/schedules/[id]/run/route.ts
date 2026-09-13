import { NextResponse } from "next/server";
import { requirePermission } from "@/lib/auth/guards";
import { listSchedules } from "@/lib/research/service";
import { spawnTask } from "@/lib/tasks/queue";
import { isFlagEnabled } from "@/lib/settings";
import { writeAudit, requestIdFor } from "@/lib/audit";
import { ensureRegisteredForApi } from "@/lib/tasks/bootstrap";

export const runtime = "nodejs";

/**
 * POST /api/admin/research/schedules/[id]/run (Phase 7) — run now.
 * Spawns one research_run task for the schedule, bypassing the cadence
 * clock. Flag-gated fail-closed (409 when the research workforce is off),
 * audited, and idempotent-keyed per click so a double submit still runs
 * exactly twice-by-intent — each run's content dedup happens at store time.
 */
export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const requestId = requestIdFor(req);
  const gate = await requirePermission(req, "research.manage");
  if (!gate.ok) return gate.response;

  const { id: idRaw } = await ctx.params;
  const id = Number(idRaw);
  if (!Number.isInteger(id) || id <= 0) {
    return NextResponse.json({ errors: [{ code: "INVALID_ID" }] }, { status: 400 });
  }

  if (!(await isFlagEnabled("research", false))) {
    await writeAudit({
      actorType: "user", actorId: gate.ctx.user?.id ?? null,
      action: "research.schedule.run", resource: "research_schedules", resourceId: id,
      result: "denied", requestId, metadata: { reason: "research_flag_off" },
    });
    return NextResponse.json({ errors: [{ code: "RESEARCH_DISABLED", detail: "the research flag is OFF" }] }, { status: 409 });
  }

  const schedules = await listSchedules(null);
  const schedule = schedules.find((s) => s.id === id);
  if (!schedule) {
    return NextResponse.json({ errors: [{ code: "NOT_FOUND" }] }, { status: 404 });
  }

  ensureRegisteredForApi();
  const { taskId } = await spawnTask({
    businessUnitId: schedule.businessUnitId,
    kind: "research_run",
    payload: {
      scheduleId: schedule.id,
      agentSlug: schedule.agentSlug,
      topic: schedule.topic,
      queries: schedule.queries,
      sources: schedule.sources,
      maxItems: schedule.maxItems,
    },
    priority: 10, // manual runs outrank cron work
    maxAttempts: 3,
    createdBy: `user:${gate.ctx.user?.id ?? "unknown"}`,
  });

  await writeAudit({
    actorType: "user", actorId: gate.ctx.user?.id ?? null,
    action: "research.schedule.run", resource: "research_schedules", resourceId: id,
    result: "success", requestId, metadata: { taskId },
  });
  return NextResponse.json({ data: { taskId, scheduleId: id }, meta: { requestId } });
}
