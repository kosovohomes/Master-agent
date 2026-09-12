import { NextResponse } from "next/server";
import { sweepDue, getPublisher, type ChannelKind } from "@/lib/agents/publishers/index";
import { decryptChannelToken } from "@/lib/channels";
import { safeEqual } from "@/lib/security";
import { isFlagEnabled } from "@/lib/settings";
import { writeAudit, requestIdFor } from "@/lib/audit";
import { tick, triggerWorkflow, settleWorkflowRun } from "@/lib/tasks/engine";
import { spawnDueKnowledgeFetches } from "@/lib/knowledge/service";

export const runtime = "nodejs";
export const maxDuration = 60;

async function realPublish(p: { channel: ChannelKind; content: string; token: string }) {
  return getPublisher(p.channel).publish({ env: process.env as NodeJS.ProcessEnv }, p);
}

/**
 * Phase 3: this cron endpoint is now the TRIGGER of Workflow #1
 * (scheduled_publishing_sweep, seeded in migration 017) and a general
 * engine worker tick (roadmap §126). The engine path is default-on:
 *   cron → triggerWorkflow (daily-idempotent spawn) → engine tick
 *   (claim & run the sweep task + any other due work) → settle run row.
 *
 * Rollback (§140 acceptance soak): the feature flag `legacy_sweep_direct`
 * restores the pre-engine direct sweepDue() path with zero code change.
 * The GET alias + secret gate stay exactly as before.
 */
async function handle(req: Request) {
  const requestId = requestIdFor(req);
  const auth = req.headers.get("x-cron-secret");
  if (!safeEqual(auth, process.env.CRON_SECRET)) {
    await writeAudit({ actorType: "anonymous", actorLabel: "cron", action: "publishing.sweep", resource: "drafts", result: "denied", requestId, metadata: { reason: "bad_cron_secret" } });
    return NextResponse.json({ errors: [{ code: "UNAUTHORIZED" }] }, { status: 401 });
  }

  // Emergency flag (SEC-L8 v1): disable_publishing halts the scheduled sweep
  // without touching approval state or stored credentials.
  if (await isFlagEnabled("disable_publishing", false)) {
    await writeAudit({ actorType: "system", actorLabel: "cron", action: "publishing.sweep", resource: "drafts", result: "denied", requestId, metadata: { reason: "disable_publishing" } });
    return NextResponse.json({ data: { skipped: true, reason: "disable_publishing" } });
  }

  // Rollback hatch: direct legacy sweep, engine bypassed entirely.
  if (await isFlagEnabled("legacy_sweep_direct", false)) {
    const result = await sweepDue({
      publish: async (p) => {
        const plain = decryptChannelToken(p.token);
        return realPublish({ channel: p.channel, content: p.content, token: plain });
      },
    });
    await writeAudit({ actorType: "system", actorLabel: "cron", action: "publishing.sweep", resource: "drafts", result: "success", requestId, metadata: { mode: "legacy_direct", result: result as unknown as Record<string, unknown> } });
    return NextResponse.json({ data: { mode: "legacy_direct", ...result }, meta: { requestId } });
  }

  // Engine path (Phase 3): workflow trigger + worker tick.
  const dayKey = new Date().toISOString().slice(0, 10);
  const triggered = await triggerWorkflow("scheduled_publishing_sweep", {
    triggerRef: `cron:${dayKey}`,
    idempotencyKey: `sweep:${dayKey}`,
    createdBy: "cron",
  });

  let tickResult: Awaited<ReturnType<typeof tick>> | null = null;
  let knowledgeSpawned: Awaited<ReturnType<typeof spawnDueKnowledgeFetches>> | null = null;
  if (triggered) {
    tickResult = await tick({ workerId: "cron-sweep", batch: 20 });
    await settleWorkflowRun(triggered.workflowRunId);
  }

  // Phase 5: scheduled knowledge refresh — spawn fetch tasks for due sources
  // (gated by the knowledge_v2 flag so the rollback hatch covers this too).
  if (await isFlagEnabled("knowledge_v2", false)) {
    knowledgeSpawned = await spawnDueKnowledgeFetches().catch(() => null);
  }

  await writeAudit({
    actorType: "system", actorLabel: "cron", action: "publishing.sweep", resource: "drafts",
    result: "success", requestId,
    metadata: {
      mode: "engine", workflow: triggered ?? null, tick: tickResult as unknown as Record<string, unknown> | null,
      knowledgeSpawned: knowledgeSpawned as unknown as Record<string, unknown> | null,
    },
  });
  return NextResponse.json({
    data: {
      mode: "engine" as const,
      workflow: triggered,
      tick: tickResult,
      knowledgeSpawned,
    },
    meta: { requestId },
  });
}

export async function POST(req: Request) {
  return handle(req);
}

// Vercel Cron invokes the configured path with an HTTP GET request.
// Without this alias every scheduled sweep would fail with 405.
export const GET = POST;
