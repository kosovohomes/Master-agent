/**
 * Phase 3 (§11 P3) — the engine tick: background execution without a browser.
 *
 * One tick = recover stuck work + claim & run up to `batch` due tasks.
 * Ticks are driven by (a) the Vercel cron sweep route (Workflow #1) and
 * (b) POST /api/agents/engine/tick with the cron secret, so any external
 * scheduler can raise the cadence beyond Vercel's daily floor (roadmap §63).
 *
 * Terminal-failure eventing: a task that exhausts its attempts emits
 * task.failed (→ ops notification). send_notification gets a dedicated
 * hygiene rule: its notifications row is marked failed so the operations
 * screen reflects reality; the failed-delivery event still fires through
 * the generic task.failed path (guarded so a failing notification cannot
 * spawn an infinite notification cascade — no event is emitted for events
 * about failed notifications).
 */
import { registerBuiltins, TaskEscalatedError, TaskCancelledError } from "./executors";
import { getTaskHandler } from "./handlers";
import {
  cancelTask, claimNextTask, completeTask, failTask, isCancelled,
  markEscalated, markRunning, recoverStuckTasks, recordStep, spawnTask,
} from "./queue";
import { query } from "../db";
import { emitEvent } from "./events";
import type { TaskRow, TickResult } from "./types";

// Idempotent registration: importing the engine wires the builtins.
let registered = false;
function ensureBuiltins(): void {
  if (!registered) {
    registerBuiltins();
    registered = true;
  }
}

export interface TickOptions {
  workerId?: string;
  batch?: number;
}

export type RunOutcome = "succeeded" | "failed" | "retried" | "escalated" | "cancelled";

async function runOne(task: TaskRow, workerId: string): Promise<RunOutcome> {
  const handler = getTaskHandler(task.kind);
  if (!handler) {
    const { outcome } = await failTask(task.id, new Error(`no task handler registered for kind "${task.kind}"`));
    return outcome === "terminal" ? "failed" : "retried";
  }

  await markRunning(task.id);

  // Cancellation honoured at the running boundary too (claim → cancel race).
  if (await isCancelled(task.id)) {
    await cancelTask(task.id, workerId);
    return "cancelled";
  }

  let seq = 0;
  const step = async (name: string, fn: () => Promise<Record<string, unknown> | void>) => {
    const s = seq++;
    try {
      await recordStep(task.id, s, name, "running");
      const out = await fn();
      await recordStep(task.id, s, name, "done", typeof out === "object" ? out ?? {} : {});
      return out;
    } catch (e) {
      await recordStep(task.id, s, name, "failed", null, (e instanceof Error ? e.message : String(e)).slice(0, 2000));
      throw e;
    }
  };
  const cancelled = () => isCancelled(task.id);

  try {
    const result = await handler({ task, step, cancelled });
    await completeTask(task.id, (result ?? {}) as Record<string, unknown>);
    return "succeeded";
  } catch (e) {
    if (e instanceof TaskEscalatedError) {
      await markEscalated(task.id, e.message, { reason: e.message });
      // Escalations page a human (notification fanout); suppressed when no target.
      if (task.kind !== "send_notification") {
        await emitEvent(task.business_unit_id ?? null, "task.escalated", {
          taskId: task.id, kind: task.kind, reason: e.message,
        }).catch(() => undefined);
      }
      return "escalated";
    }
    if (e instanceof TaskCancelledError) {
      await query(
        `UPDATE tasks SET status = 'cancelled', finished_at = now(), updated_at = now(), error = $2
         WHERE id = $1`,
        [task.id, e.message]
      );
      return "cancelled";
    }
    const { outcome } = await failTask(task.id, e);
    if (outcome === "terminal") {
      if (task.kind === "send_notification" && typeof (task.payload as { notificationId?: number }).notificationId === "number") {
        await query(
          "UPDATE notifications SET status = 'failed', last_error = $2 WHERE id = $1",
          [(task.payload as { notificationId: number }).notificationId, (e instanceof Error ? e.message : String(e)).slice(0, 1000)]
        ).catch(() => undefined);
      }
      if (task.kind !== "send_notification") {
        await emitEvent(task.business_unit_id ?? null, "task.failed", {
          taskId: task.id, kind: task.kind,
          error: (e instanceof Error ? e.message : String(e)).slice(0, 500),
        }).catch(() => undefined);
      }
      return "failed";
    }
    return "retried";
  }
}

export async function tick(opts: TickOptions = {}): Promise<TickResult & { recovered: number }> {
  ensureBuiltins();
  const workerId = opts.workerId ?? `worker-${process.pid}-${Date.now()}`;
  const batch = Math.max(1, Math.min(opts.batch ?? 10, 50));

  const recovered = await recoverStuckTasks();
  const result: TickResult = { claimed: 0, succeeded: 0, failed: 0, retried: 0, cancelled: 0, escalated: 0 };

  for (let i = 0; i < batch; i++) {
    const task = await claimNextTask(workerId);
    if (!task) break;
    result.claimed++;
    const outcome = await runOne(task, workerId);
    if (outcome === "succeeded") result.succeeded++;
    else if (outcome === "failed") result.failed++;
    else if (outcome === "retried") result.retried++;
    else if (outcome === "cancelled") result.cancelled++;
    else if (outcome === "escalated") result.escalated++;
  }
  return { ...result, recovered };
}

/* ------------------------------------------------------------------ */
/* Workflow triggering                                                 */
/* ------------------------------------------------------------------ */

export interface WorkflowRow {
  id: number;
  business_unit_id: number | null;
  slug: string;
  name: string;
  trigger_kind: "schedule" | "event" | "manual";
  trigger_config: Record<string, unknown>;
  task_kind: string;
  task_payload: Record<string, unknown>;
  enabled: boolean;
}

export async function getWorkflowBySlug(slug: string): Promise<WorkflowRow | null> {
  const rows = await query<WorkflowRow>("SELECT * FROM workflows WHERE slug = $1 LIMIT 1", [slug]);
  return rows[0] ?? null;
}

export async function listWorkflows(): Promise<WorkflowRow[]> {
  return query<WorkflowRow>("SELECT * FROM workflows ORDER BY id");
}

/**
 * Trigger a workflow run: records the run row and spawns its task (idempotent
 * via the caller-supplied idempotency key — e.g. one sweep per day). Returns
 * null when the workflow is disabled.
 */
export async function triggerWorkflow(
  slug: string,
  opts: { triggerRef?: string; idempotencyKey?: string | null; createdBy?: string; tenantId?: number | null } = {}
): Promise<{ workflowRunId: number; taskId: number; taskCreated: boolean } | null> {
  const wf = await getWorkflowBySlug(slug);
  if (!wf || !wf.enabled) return null;

  const run = await query<{ id: number }>(
    `INSERT INTO workflow_runs (workflow_id, business_unit_id, trigger_kind, trigger_ref)
     VALUES ($1, $2, $3, $4) RETURNING id`,
    [wf.id, wf.business_unit_id, wf.trigger_kind, opts.triggerRef ?? null]
  );
  const workflowRunId = run[0].id;

  const spawn = await spawnWorkflowTask(wf, {
    workflowRunId,
    idempotencyKey: opts.idempotencyKey ?? null,
    createdBy: opts.createdBy ?? "workflow",
    tenantId: opts.tenantId ?? null,
  });

  await query("UPDATE workflow_runs SET task_id = $2 WHERE id = $1", [workflowRunId, spawn.taskId]);
  return { workflowRunId, taskId: spawn.taskId, taskCreated: spawn.created };
}

export async function spawnWorkflowTask(
  wf: WorkflowRow,
  opts: { workflowRunId: number; idempotencyKey?: string | null; createdBy?: string; tenantId?: number | null }
): Promise<{ taskId: number; created: boolean }> {
  return spawnTask({
    businessUnitId: wf.business_unit_id,
    tenantId: opts.tenantId,
    kind: wf.task_kind,
    payload: wf.task_payload,
    workflowRunId: opts.workflowRunId,
    idempotencyKey: opts.idempotencyKey,
    createdBy: opts.createdBy ?? "workflow",
  });
}

/** Finalize a workflow run from its task outcome (called by the sweep route / tick wrappers). */
export async function settleWorkflowRun(workflowRunId: number): Promise<void> {
  const rows = await query<{ task_id: number; status: string }>(
    `SELECT wr.task_id, t.status FROM workflow_runs wr LEFT JOIN tasks t ON t.id = wr.task_id
     WHERE wr.id = $1`,
    [workflowRunId]
  );
  if (rows.length === 0 || !rows[0].task_id) return;
  const status = rows[0].status;
  const map: Record<string, string> = {
    succeeded: "succeeded", failed: "failed", cancelled: "cancelled", escalated: "succeeded",
    queued: "running", claimed: "running", running: "running", waiting_approval: "running",
  };
  const finalStatus = map[status] ?? "running";
  if (finalStatus !== "running") {
    await query(
      "UPDATE workflow_runs SET status = $2, finished_at = now() WHERE id = $1",
      [workflowRunId, finalStatus]
    );
    if (finalStatus === "failed") {
      const wf = await query<{ slug: string; business_unit_id: number | null }>(
        `SELECT w.slug, w.business_unit_id FROM workflow_runs wr JOIN workflows w ON w.id = wr.workflow_id WHERE wr.id = $1`,
        [workflowRunId]
      );
      if (wf.length > 0) {
        await emitEvent(wf[0].business_unit_id, "workflow.run_failed", {
          workflow: wf[0].slug, workflowRunId,
        }).catch(() => undefined);
      }
    }
  }
}
