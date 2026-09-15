import { NextResponse } from "next/server";
import { requirePermission } from "@/lib/auth/guards";
import { spawnTask } from "@/lib/tasks/queue";
import { ensureRegisteredForApi } from "@/lib/tasks/bootstrap";
import { writeAudit, requestIdFor } from "@/lib/audit";
import { isFlagEnabled } from "@/lib/settings";

export const runtime = "nodejs";

/**
 * /api/admin/social/sweep (Phase 10).
 *  POST — social.manage: spawn a social_sweep task NOW (on-demand publishing
 *  of due posts; precision backstop for the cron cadence — see the Phase 10
 *  report §scheduling). Durable via the task engine; idempotent per minute.
 *  Flag-off is reported but the spawn is allowed (the handler skips
 *  fail-closed — same discipline as the SEO scan).
 */
export async function POST(req: Request) {
  const requestId = requestIdFor(req);
  const gate = await requirePermission(req, "social.manage");
  if (!gate.ok) return gate.response;

  await ensureRegisteredForApi();
  const flag = await isFlagEnabled("social", false);
  const minuteBucket = Math.floor(Date.now() / 60_000);
  const spawned = await spawnTask({
    businessUnitId: null,
    kind: "social_sweep",
    payload: {},
    priority: 50,
    maxAttempts: 3,
    idempotencyKey: `social_sweep:manual:${minuteBucket}`,
    createdBy: `user:${gate.ctx.user?.id ?? "unknown"}`,
  });

  await writeAudit({
    actorType: "user",
    actorId: gate.ctx.user?.id ?? null,
    action: "social.sweep.spawn",
    resource: "tasks",
    resourceId: spawned.taskId,
    result: "success",
    requestId,
    metadata: { duplicate: !spawned.created, socialFlag: flag },
  });
  return NextResponse.json({
    data: { taskId: spawned.taskId, created: spawned.created, socialFlag: flag },
    meta: { requestId },
  });
}
