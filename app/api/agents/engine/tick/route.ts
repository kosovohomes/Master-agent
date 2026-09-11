import { NextResponse } from "next/server";
import { tick } from "@/lib/tasks/engine";
import { safeEqual } from "@/lib/security";
import { writeAudit, requestIdFor } from "@/lib/audit";

export const runtime = "nodejs";
export const maxDuration = 60;

/**
 * POST/GET /api/agents/engine/tick — machine worker endpoint (Phase 3).
 *
 * The Vercel cron sweeps daily (Workflow #1). For everything that needs a
 * faster pulse — retries coming out of backoff, event-spawned notification
 * tasks, manual agent_dispatch work — any external scheduler (cron-job.org,
 * GitHub Actions, uptime pinger) can hit this endpoint every few minutes
 * with the cron secret. This is the roadmap §63 sub-daily decision: the
 * Vercel cron stays as the guaranteed daily floor; the tick endpoint is the
 * high-frequency worker. Claims use FOR UPDATE SKIP LOCKED, so overlapping
 * ticks (or a tick racing the cron) are safe by construction.
 *
 * Auth: x-cron-secret (same secret as the sweep). Every tick is audited.
 */
async function handle(req: Request) {
  const requestId = requestIdFor(req);
  const auth = req.headers.get("x-cron-secret");
  if (!safeEqual(auth, process.env.CRON_SECRET)) {
    await writeAudit({ actorType: "anonymous", actorLabel: "machine", action: "engine.tick", resource: "tasks", result: "denied", requestId, metadata: { reason: "bad_cron_secret" } });
    return NextResponse.json({ errors: [{ code: "UNAUTHORIZED" }] }, { status: 401 });
  }

  const result = await tick({ workerId: "tick-endpoint", batch: 10 });
  await writeAudit({
    actorType: "system", actorLabel: "machine", action: "engine.tick", resource: "tasks",
    result: "success", requestId, metadata: { result: result as unknown as Record<string, unknown> },
  });
  return NextResponse.json({ data: result, meta: { requestId } });
}

export async function POST(req: Request) {
  return handle(req);
}

// Some external schedulers only speak GET; same gate, same handler.
export const GET = POST;
