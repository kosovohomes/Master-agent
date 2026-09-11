import { NextResponse } from "next/server";
import { cancelTask, getTask, listTaskSteps } from "@/lib/tasks/queue";
import { ensureRegisteredForApi } from "@/lib/tasks/bootstrap";
import { requirePermission } from "@/lib/auth/guards";
import { writeAudit, requestIdFor } from "@/lib/audit";

export const runtime = "nodejs";

/**
 * /api/admin/tasks/[id] (Phase 3).
 *  GET  — audit.read: task detail + ordered step records.
 *  POST — ops.run: {action: "cancel"} → cooperative cancellation
 *         (queued tasks cancel outright; inflight tasks observe
 *         cancel_requested between steps). Audited.
 */
export async function GET(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const requestId = requestIdFor(req);
  const gate = await requirePermission(req, "audit.read");
  if (!gate.ok) return gate.response;

  const { id } = await ctx.params;
  if (!/^\d+$/.test(id)) {
    return NextResponse.json({ errors: [{ code: "INVALID_ID" }] }, { status: 400 });
  }
  ensureRegisteredForApi();
  const task = await getTask(Number(id));
  if (!task) {
    return NextResponse.json({ errors: [{ code: "NOT_FOUND" }] }, { status: 404 });
  }
  return NextResponse.json({ data: { task, steps: await listTaskSteps(task.id) }, meta: { requestId } });
}

export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const requestId = requestIdFor(req);
  const gate = await requirePermission(req, "ops.run");
  if (!gate.ok) return gate.response;

  const { id } = await ctx.params;
  if (!/^\d+$/.test(id)) {
    return NextResponse.json({ errors: [{ code: "INVALID_ID" }] }, { status: 400 });
  }

  let body: { action?: string } = {};
  try {
    body = (await req.json()) as { action?: string };
  } catch {
    // empty body treated as {action: undefined}
  }
  if (body.action !== "cancel") {
    return NextResponse.json({ errors: [{ code: "UNSUPPORTED_ACTION", detail: "only cancel is supported in Phase 3" }] }, { status: 400 });
  }

  const actor = gate.ctx.user ? `user:${gate.ctx.user.id}` : "ops:bearer";
  const { outcome } = await cancelTask(Number(id), actor);
  await writeAudit({
    actorType: gate.ctx.user ? "user" : "system",
    actorId: gate.ctx.user?.id ?? null,
    actorLabel: gate.ctx.user ? undefined : "ops:bearer",
    action: "tasks.cancel", resource: "tasks", resourceId: Number(id),
    result: outcome === "not_found" ? "failure" : "success", requestId,
    metadata: { outcome },
  });

  if (outcome === "not_found") {
    return NextResponse.json({ errors: [{ code: "NOT_FOUND" }] }, { status: 404 });
  }
  return NextResponse.json({
    data: { id: Number(id), outcome, task: await getTask(Number(id)) },
    meta: { requestId },
  });
}
