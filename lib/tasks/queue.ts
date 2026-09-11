/**
 * Phase 3 (§11 P3) — durable job queue.
 *
 * Guarantees (§140 "jobs must not disappear"):
 *  - Spawn is idempotent when an idempotency key is provided (unique index
 *    on (COALESCE(business_unit_id,0), idempotency_key)) — duplicate spawns,
 *    including concurrent ones, collapse into a single task row.
 *  - Claims run inside a transaction with FOR UPDATE SKIP LOCKED: concurrent
 *    workers can never claim the same task.
 *  - Failure retries under exponential backoff (5s · 4^attempt, capped) while
 *    attempts < max_attempts; only exhausted tasks reach the terminal
 *    `failed` state.
 *  - Visibility timeout: tasks stuck in claimed/running past the window are
 *    requeued by recoverStuckTasks() (the worker heartbeat is the liveness
 *    signal). Attempts were already incremented at claim time, so a task that
 *    repeatedly crashes its worker still converges to `failed`.
 *  - Cancellation is cooperative: queued tasks flip straight to `cancelled`;
 *    running tasks observe cancel_requested between steps via cancelled().
 */
import { query, transaction } from "../db";
import { classifyError } from "../agents/core";
import type { SpawnTaskParams, SpawnTaskResult, TaskRow, TaskStepRow, TaskStatus } from "./types";

/** Visibility timeout: inflight tasks with no heartbeat past this are requeued. */
export const VISIBILITY_TIMEOUT_SEC = 300;

/** Backoff base for retry N (attempt 1 → 20s, 2 → 80s, 3 → 320s … capped 1h). */
export function backoffDelaySec(attempt: number): number {
  return Math.min(20 * Math.pow(4, Math.max(0, attempt - 1)), 3600);
}

export async function spawnTask(p: SpawnTaskParams): Promise<SpawnTaskResult> {
  const rows = await query<{ id: number; xmin_created: boolean }>(
    `INSERT INTO tasks (
       business_unit_id, tenant_id, kind, payload, priority, max_attempts,
       idempotency_key, created_by, workflow_run_id, next_run_at
     )
     VALUES ($1, $2, $3, $4::jsonb, $5, $6, $7, $8, $9, COALESCE($10, now()))
     ON CONFLICT (COALESCE(business_unit_id, 0), idempotency_key)
       WHERE idempotency_key IS NOT NULL
       DO NOTHING
     RETURNING id, (xmax = 0) AS xmin_created`,
    [
      p.businessUnitId ?? null,
      p.tenantId ?? null,
      p.kind,
      JSON.stringify(p.payload ?? {}),
      p.priority ?? 100,
      p.maxAttempts ?? 3,
      p.idempotencyKey ?? null,
      p.createdBy ?? "system",
      p.workflowRunId ?? null,
      p.runAt ?? null,
    ]
  );
  if (rows.length === 0) {
    // Conflict: the idempotent twin already exists — return it.
    const existing = await query<{ id: number }>(
      `SELECT id FROM tasks
       WHERE idempotency_key = $1
         AND COALESCE(business_unit_id, 0) = COALESCE($2, 0)
       LIMIT 1`,
      [p.idempotencyKey ?? "", p.businessUnitId ?? null]
    );
    if (existing.length === 0) throw new Error("spawnTask: conflict but no existing row");
    return { taskId: existing[0].id, created: false };
  }
  return { taskId: rows[0].id, created: true };
}

/**
 * Claim the next due task. FOR UPDATE SKIP LOCKED: two concurrent workers
 * evaluating the same queue see disjoint tasks. Returns null when nothing
 * is due. The claim transaction increments attempts — a worker that dies
 * before completing still consumed one attempt, which is what makes the
 * visibility-timeout recovery converge instead of loop forever.
 */
export async function claimNextTask(workerId: string): Promise<TaskRow | null> {
  return transaction(async (q) => {
    const rows = await q<TaskRow>(
      `SELECT * FROM tasks
       WHERE status = 'queued' AND next_run_at <= now()
       ORDER BY priority ASC, next_run_at ASC
       FOR UPDATE SKIP LOCKED
       LIMIT 1`
    );
    if (rows.length === 0) return null;
    const claimed = await q<TaskRow>(
      `UPDATE tasks
       SET status = 'claimed', claimed_at = now(), claimed_by = $2,
           heartbeat_at = now(), started_at = COALESCE(started_at, now()),
           updated_at = now(), attempts = attempts + 1
       WHERE id = $1
       RETURNING *`,
      [rows[0].id, workerId]
    );
    return claimed[0];
  });
}

export async function markRunning(taskId: number): Promise<void> {
  await query("UPDATE tasks SET status = 'running', heartbeat_at = now(), updated_at = now() WHERE id = $1", [taskId]);
}

export async function heartbeat(taskId: number): Promise<void> {
  await query("UPDATE tasks SET heartbeat_at = now() WHERE id = $1 AND status IN ('claimed','running')", [taskId]);
}

export async function completeTask(taskId: number, result: Record<string, unknown> | void): Promise<void> {
  await query(
    `UPDATE tasks SET status = 'succeeded', result = $2::jsonb, finished_at = now(), updated_at = now(),
       error = NULL, error_class = NULL
     WHERE id = $1`,
    [taskId, JSON.stringify(result ?? {})]
  );
}

export type FailOutcome = "retry" | "terminal";

/**
 * Record a failure. Retries requeue with backoff; exhausted attempts become
 * terminal `failed`. Returns the outcome so the caller can emit events.
 */
export async function failTask(taskId: number, err: unknown): Promise<{ outcome: FailOutcome; nextAttemptAt: Date | null }> {
  const rows = await query<TaskRow>("SELECT * FROM tasks WHERE id = $1", [taskId]);
  if (rows.length === 0) throw new Error(`failTask: task not found ${taskId}`);
  const t = rows[0];
  const message = (err instanceof Error ? err.message : String(err)).slice(0, 2000);
  const errorClass = classifyError(err);

  if (t.attempts < t.max_attempts) {
    const delay = backoffDelaySec(t.attempts);
    const nextAttemptAt = new Date(Date.now() + delay * 1000);
    await query(
      `UPDATE tasks SET status = 'queued', error = $2, error_class = $3,
         next_run_at = $4, claimed_at = NULL, claimed_by = NULL, updated_at = now()
       WHERE id = $1`,
      [taskId, message, errorClass, nextAttemptAt]
    );
    return { outcome: "retry", nextAttemptAt };
  }
  await query(
    `UPDATE tasks SET status = 'failed', error = $2, error_class = $3,
       finished_at = now(), updated_at = now()
     WHERE id = $1`,
    [taskId, message, errorClass]
  );
  return { outcome: "terminal", nextAttemptAt: null };
}

export type CancelOutcome = "cancelled" | "cancel_requested" | "not_found" | "terminal";

/**
 * Cooperative cancellation. Queued tasks cancel outright; inflight tasks get
 * cancel_requested (honoured between steps by the handler); tasks already in
 * a terminal state report not cancellable.
 */
export async function cancelTask(taskId: number, actor: string): Promise<{ outcome: CancelOutcome }> {
  const rows = await query<TaskRow>("SELECT status FROM tasks WHERE id = $1", [taskId]);
  if (rows.length === 0) return { outcome: "not_found" };
  const status = rows[0].status as TaskStatus;
  if (["succeeded", "failed", "cancelled", "escalated"].includes(status)) {
    return { outcome: "terminal" };
  }
  if (status === "claimed" || status === "running" || status === "waiting_approval") {
    await query("UPDATE tasks SET cancel_requested = true, updated_at = now() WHERE id = $1", [taskId]);
    return { outcome: "cancel_requested" };
  }
  await query(
    `UPDATE tasks SET status = 'cancelled', finished_at = now(), updated_at = now(),
       error = $2
     WHERE id = $1 AND status = 'queued'`,
    [taskId, `cancelled by ${actor}`]
  );
  return { outcome: "cancelled" };
}

export async function isCancelled(taskId: number): Promise<boolean> {
  const rows = await query<{ cancel_requested: boolean }>(
    "SELECT cancel_requested FROM tasks WHERE id = $1",
    [taskId]
  );
  return rows.length > 0 && rows[0].cancel_requested;
}

/**
 * Requeue tasks whose worker died mid-flight (heartbeat older than the
 * visibility timeout). Called at the top of every engine tick — this is the
 * mechanism behind "jobs must not disappear": a crashed serverless instance
 * leaves the row, and the next tick resumes it.
 */
export async function recoverStuckTasks(): Promise<number> {
  const rows = await query<{ id: number }>(
    `UPDATE tasks SET status = 'queued', claimed_at = NULL, claimed_by = NULL,
       next_run_at = now(), updated_at = now()
     WHERE status IN ('claimed', 'running')
       AND heartbeat_at < now() - ($1 || ' seconds')::interval
     RETURNING id`,
    [String(VISIBILITY_TIMEOUT_SEC)]
  );
  return rows.length;
}

export async function markEscalated(taskId: number, reason: string, result?: Record<string, unknown>): Promise<void> {
  await query(
    `UPDATE tasks SET status = 'escalated', error = $2, result = $3::jsonb,
       finished_at = now(), updated_at = now()
     WHERE id = $1`,
    [taskId, reason.slice(0, 2000), JSON.stringify(result ?? {})]
  );
}

export async function markWaitingApproval(taskId: number, result?: Record<string, unknown>): Promise<void> {
  await query(
    `UPDATE tasks SET status = 'waiting_approval', result = $2::jsonb, updated_at = now()
     WHERE id = $1`,
    [taskId, JSON.stringify(result ?? {})]
  );
}

/** Ordered step records for observability (classify → execute → record …). */
export async function recordStep(
  taskId: number,
  seq: number,
  name: string,
  status: "running" | "done" | "failed" | "skipped",
  output?: Record<string, unknown> | null,
  error?: string | null
): Promise<void> {
  await query(
    `INSERT INTO task_steps (task_id, seq, name, status, output, error, started_at, finished_at)
     VALUES ($1, $2, $3, $4, $5::jsonb, $6, now(), now())`,
    [taskId, seq, name, status, JSON.stringify(output ?? {}), error ?? null]
  );
}

export async function getTask(taskId: number): Promise<TaskRow | null> {
  const rows = await query<TaskRow>("SELECT * FROM tasks WHERE id = $1", [taskId]);
  return rows[0] ?? null;
}

export async function listTaskSteps(taskId: number): Promise<TaskStepRow[]> {
  return query<TaskStepRow>("SELECT * FROM task_steps WHERE task_id = $1 ORDER BY seq", [taskId]);
}

export interface ListTasksFilter {
  status?: TaskStatus | TaskStatus[];
  businessUnitId?: number | null;
  limit?: number;
}

export async function listTasks(filter: ListTasksFilter = {}): Promise<TaskRow[]> {
  const params: unknown[] = [];
  const where: string[] = [];
  if (filter.status) {
    const statuses = Array.isArray(filter.status) ? filter.status : [filter.status];
    params.push(statuses);
    where.push(`status = ANY($${params.length}::text[])`);
  }
  if (filter.businessUnitId != null) {
    params.push(filter.businessUnitId);
    where.push(`business_unit_id = $${params.length}`);
  }
  params.push(Math.min(filter.limit ?? 50, 200));
  const sql = `SELECT * FROM tasks ${where.length ? "WHERE " + where.join(" AND ") : ""}
     ORDER BY id DESC LIMIT $${params.length}`;
  return query<TaskRow>(sql, params);
}
