import { NextResponse } from "next/server";
import { listWorkflows, triggerWorkflow } from "@/lib/tasks/engine";
import type { WorkflowRow } from "@/lib/tasks/engine";
import { requirePermission } from "@/lib/auth/guards";
import { query } from "@/lib/db";
import { writeAudit, requestIdFor } from "@/lib/audit";

export const runtime = "nodejs";

/**
 * /api/admin/workflows (Phase 3 — workflow observability + manual trigger).
 *  GET  — audit.read: workflow definitions + recent runs.
 *  POST — ops.run: {slug} manually trigger a workflow run (trigger_kind is
 *         recorded as manual regardless of the definition's kind).
 */
// Raw rows are snake_case from the DB — map to the Command Center's
// camelCase read models (same convention as /api/admin/agents).
function mapWorkflow(w: WorkflowRow) {
  return {
    id: w.id, slug: w.slug, name: w.name,
    triggerKind: w.trigger_kind, triggerConfig: w.trigger_config,
    taskKind: w.task_kind, taskPayload: w.task_payload, enabled: w.enabled,
  };
}
function mapRun(r: Record<string, unknown>) {
  return {
    id: r.id, workflowSlug: r.workflow_slug, triggerKind: r.trigger_kind,
    status: r.status, taskId: r.task_id, startedAt: r.started_at, finishedAt: r.finished_at,
  };
}

export async function GET(req: Request) {
  const requestId = requestIdFor(req);
  const gate = await requirePermission(req, "audit.read");
  if (!gate.ok) return gate.response;

  const workflows = await listWorkflows();
  const runs = await query<Record<string, unknown>>(
    `SELECT wr.*, w.slug AS workflow_slug
     FROM workflow_runs wr JOIN workflows w ON w.id = wr.workflow_id
     ORDER BY wr.id DESC LIMIT 50`
  );
  return NextResponse.json({
    data: { workflows: workflows.map(mapWorkflow), runs: runs.map(mapRun) },
    meta: { requestId },
  });
}

export async function POST(req: Request) {
  const requestId = requestIdFor(req);
  const gate = await requirePermission(req, "ops.run");
  if (!gate.ok) return gate.response;

  let body: { slug?: string };
  try {
    body = (await req.json()) as { slug?: string };
  } catch {
    return NextResponse.json({ errors: [{ code: "INVALID_JSON" }] }, { status: 400 });
  }
  const slug = String(body.slug ?? "");
  if (!slug) {
    return NextResponse.json({ errors: [{ code: "MISSING_SLUG" }] }, { status: 400 });
  }

  const actor = gate.ctx.user ? `user:${gate.ctx.user.id}` : "ops:bearer";
  const triggered = await triggerWorkflow(slug, { createdBy: actor, triggerRef: "manual-api" });
  if (!triggered) {
    return NextResponse.json({ errors: [{ code: "WORKFLOW_NOT_FOUND_OR_DISABLED" }] }, { status: 404 });
  }

  await writeAudit({
    actorType: gate.ctx.user ? "user" : "system",
    actorId: gate.ctx.user?.id ?? null,
    actorLabel: gate.ctx.user ? undefined : "ops:bearer",
    action: "workflows.trigger", resource: "workflows", resourceId: triggered.workflowRunId,
    result: "success", requestId,
    metadata: { slug, taskId: triggered.taskId, created: triggered.taskCreated },
  });
  return NextResponse.json({ data: triggered, meta: { requestId } }, { status: 201 });
}
