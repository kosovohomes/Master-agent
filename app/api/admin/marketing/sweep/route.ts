import { NextResponse } from "next/server";
import { requirePermission } from "@/lib/auth/guards";
import { spawnTask } from "@/lib/tasks/queue";
import { ensureRegisteredForApi } from "@/lib/tasks/bootstrap";
import { writeAudit, requestIdFor } from "@/lib/audit";
import { isFlagEnabled } from "@/lib/settings";

export const runtime = "nodejs";

/**
 * /api/admin/marketing/sweep (Phase 11).
 *  POST — marketing.manage: spawn a marketing_sweep task NOW (on-demand
 *  auto-completion of active campaigns past their ends_at; precision
 *  backstop for the cron cadence — same shape as the social sweep).
 *  Durable via the task engine; idempotent per minute. Flag-off is
 *  reported but the spawn is allowed (the handler skips fail-closed).
 */
export async function POST(req: Request) {
  const requestId = requestIdFor(req);
  const gate = await requirePermission(req, "marketing.manage");
  if (!gate.ok) return gate.response;

  await ensureRegisteredForApi();
  const flag = await isFlagEnabled("marketing", false);
  const minuteBucket = Math.floor(Date.now() / 60_000);
  const spawned = await spawnTask({
    businessUnitId: null,
    kind: "marketing_sweep",
    payload: {},
    priority: 50,
    maxAttempts: 3,
    idempotencyKey: `marketing_sweep:manual:${minuteBucket}`,
    createdBy: `user:${gate.ctx.user?.id ?? "unknown"}`,
  });

  await writeAudit({
    actorType: "user",
    actorId: gate.ctx.user?.id ?? null,
    action: "marketing.sweep.spawn",
    resource: "tasks",
    resourceId: spawned.taskId,
    result: "success",
    requestId,
    metadata: { duplicate: !spawned.created, marketingFlag: flag },
  });
  return NextResponse.json({
    data: { taskId: spawned.taskId, created: spawned.created, marketingFlag: flag },
    meta: { requestId },
  });
}
