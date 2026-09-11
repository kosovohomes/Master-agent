/**
 * Phase 3 (§11 P3) — task engine types.
 *
 * Tasks are the unit of background execution (§135 P3): "background
 * execution without the browser" and "jobs must not disappear" (§140).
 * A task is a durable row; the queue in queue.ts is the only writer of
 * status transitions, and every transition respects the machine below.
 *
 * The machine deliberately includes the human-in-the-loop states that the
 * content workforce phases (P7) build on:
 *   queued → claimed → running → succeeded | failed
 *   failed → queued            (retry under backoff while attempts remain)
 *   queued → cancelled         (operator cancellation before claim)
 *   running → cancelled        (honoured via cancel_requested between steps)
 *   running → waiting_approval (P7: task parks pending a human decision)
 *   running → escalated        (P3: classifier FALLBACK with no safe route)
 */

export type TaskStatus =
  | "queued"
  | "claimed"
  | "running"
  | "succeeded"
  | "failed"
  | "cancelled"
  | "waiting_approval"
  | "escalated";

export type TaskStepStatus = "pending" | "running" | "done" | "failed" | "skipped";

export interface TaskRow {
  id: number;
  business_unit_id: number | null;
  tenant_id: number | null;
  kind: string;
  status: TaskStatus;
  priority: number;
  payload: Record<string, unknown>;
  result: Record<string, unknown> | null;
  error: string | null;
  error_class: string | null;
  run_id: number | null;
  workflow_run_id: number | null;
  attempts: number;
  max_attempts: number;
  next_run_at: Date;
  claimed_at: Date | null;
  claimed_by: string | null;
  heartbeat_at: Date | null;
  started_at: Date | null;
  finished_at: Date | null;
  cancel_requested: boolean;
  created_by: string;
  idempotency_key: string | null;
  created_at: Date;
  updated_at: Date;
}

export interface TaskStepRow {
  id: number;
  task_id: number;
  seq: number;
  name: string;
  status: TaskStepStatus;
  output: Record<string, unknown> | null;
  error: string | null;
  started_at: Date | null;
  finished_at: Date | null;
}

export interface SpawnTaskParams {
  businessUnitId?: number | null;
  tenantId?: number | null;
  kind: string;
  payload?: Record<string, unknown>;
  /** Lower runs sooner (priority ordering ASC). */
  priority?: number;
  maxAttempts?: number;
  /** Unique per BU — duplicate spawns become no-ops returning the existing task. */
  idempotencyKey?: string | null;
  createdBy?: string;
  workflowRunId?: number | null;
  /** Delay before the task becomes claimable (scheduled work). */
  runAt?: Date;
}

export interface SpawnTaskResult {
  taskId: number;
  /** false when an identical idempotency key already spawned this task. */
  created: boolean;
}

export interface TaskHandlerInput {
  task: TaskRow;
  /** Record an ordered step (classify / execute / record …) for observability. */
  step: (name: string, fn: () => Promise<Record<string, unknown> | void>) => Promise<Record<string, unknown> | void>;
  /** Request cancellation check between phases of long work. */
  cancelled: () => Promise<boolean>;
}

export type TaskHandler = (input: TaskHandlerInput) => Promise<Record<string, unknown> | void>;

export interface TickResult {
  claimed: number;
  succeeded: number;
  failed: number;
  retried: number;
  cancelled: number;
  escalated: number;
}
