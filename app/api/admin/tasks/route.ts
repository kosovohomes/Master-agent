import { NextResponse } from "next/server";
import { spawnTask, listTasks, getTask, listTaskSteps } from "@/lib/tasks/queue";
import type { TaskStatus } from "@/lib/tasks/types";
import { knownTaskKinds } from "@/lib/tasks/handlers";
import { ensureRegisteredForApi } from "@/lib/tasks/bootstrap";
import { requirePermission } from "@/lib/auth/guards";
import { writeAudit, requestIdFor } from "@/lib/audit";

export const runtime = "nodejs";

/**
 * /api/admin/tasks (Phase 3 — task engine v1).
 *  GET           — audit.read: task list (status filter) + current handler kinds.
 *  POST {kind, payload, ...} — ops.run: spawn a task. Known kinds:
 *    agent_dispatch {tenantId, topic, channel, context?, allowFallback?}
 *      — dispatch() wrapped as a task; classifier FALLBACK escalates unless
 *        allowFallback is explicitly true (legacy manual behavior).
 *    publishing_sweep {} — Workflow #1 body, spawnable on demand.
 *  Mutations are audited; idempotencyKey deduplicates spawns per BU.
 */
export async function GET(req: Request) {
  const requestId = requestIdFor(req);
  const gate = await requirePermission(req, "audit.read");
  if (!gate.ok) return gate.response;

  const url = new URL(req.url);
  const statusParam = url.searchParams.get("status");
  const limit = Number(url.searchParams.get("limit") ?? 50);
  ensureRegisteredForApi();
  const rows = await listTasks({
    status: statusParam ? (statusParam as TaskStatus) : undefined,
    limit: Number.isFinite(limit) ? limit : 50,
  });
  // Map snake_case rows to the Command Center read model.
  const tasks = rows.map((t) => ({
    id: t.id, kind: t.kind, status: t.status as string, priority: t.priority,
    attempts: t.attempts, maxAttempts: t.max_attempts,
    error: t.error, errorClass: t.error_class, runId: t.run_id,
    workflowRunId: t.workflow_run_id, idempotencyKey: t.idempotency_key,
    cancelRequested: t.cancel_requested,
    createdAt: t.created_at, startedAt: t.started_at, finishedAt: t.finished_at,
  }));
  return NextResponse.json({ data: { tasks, handlerKinds: knownTaskKinds() }, meta: { requestId } });
}
export async function POST(req: Request) {
  const requestId = requestIdFor(req);
  const gate = await requirePermission(req, "ops.run");
  if (!gate.ok) return gate.response;
  ensureRegisteredForApi();

  let body: Record<string, unknown>;
  try {
    body = (await req.json()) as Record<string, unknown>;
  } catch {
    return NextResponse.json({ errors: [{ code: "INVALID_JSON" }] }, { status: 400 });
  }

  const kind = String(body.kind ?? "");
  if (!kind || !knownTaskKinds().includes(kind)) {
    return NextResponse.json({ errors: [{ code: "UNKNOWN_TASK_KIND", detail: knownTaskKinds() }] }, { status: 400 });
  }
  if (kind === "agent_dispatch" && !Number.isInteger(body.tenantId)) {
    return NextResponse.json({ errors: [{ code: "INVALID_TENANT" }] }, { status: 400 });
  }

  const payload = (body.payload && typeof body.payload === "object")
    ? body.payload as Record<string, unknown>
    : {
        tenantId: body.tenantId,
        topic: body.topic,
        channel: body.channel,
        context: body.context,
        allowFallback: body.allowFallback,
      };

  const spawn = await spawnTask({
    tenantId: Number.isInteger(body.tenantId) ? (body.tenantId as number) : null,
    kind,
    payload,
    idempotencyKey: typeof body.idempotencyKey === "string" ? body.idempotencyKey : null,
    maxAttempts: Number.isInteger(body.maxAttempts) ? (body.maxAttempts as number) : undefined,
    priority: Number.isInteger(body.priority) ? (body.priority as number) : undefined,
    createdBy: gate.ctx.user ? `user:${gate.ctx.user.id}` : "ops:bearer",
  });

  await writeAudit({
    actorType: gate.ctx.user ? "user" : "system",
    actorId: gate.ctx.user?.id ?? null,
    actorLabel: gate.ctx.user ? undefined : "ops:bearer",
    action: "tasks.spawn", resource: "tasks", resourceId: spawn.taskId,
    result: "success", requestId,
    metadata: { kind, created: spawn.created, via: gate.ctx.via },
  });

  const task = await getTask(spawn.taskId);
  return NextResponse.json({
    data: { ...spawn, task, steps: await listTaskSteps(spawn.taskId) },
    meta: { ts: new Date().toISOString(), requestId },
  }, { status: spawn.created ? 201 : 200 });
}
