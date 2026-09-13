/**
 * Phase 3 (§11 P3) — event bus + notifications v1.
 *
 * Events are append-only rows (the durable bus). emitEvent() fans out to
 * notifications per v1 rule set: terminal task failures, escalations and
 * publish failures notify ops email (EMAIL_TARGET or system setting
 * ops_email); suppression keeps notifications from ever blocking work —
 * with no target configured they materialize as `suppressed` rows so the
 * intent is still visible in the operations screen.
 *
 * Delivery rides the task queue itself: emitEvent spawns a
 * send_notification task per notification row. send_notification emits no
 * events (loop guard). Failure → normal queue retry/backoff, then the
 * notification row lands as `failed` (marked by the executor).
 */
import { query } from "../db";
import { spawnTask } from "./queue";

export type EventName =
  | "task.failed"
  | "task.escalated"
  | "publish.failed"
  | "publish.succeeded"
  | "workflow.run_failed"
  | "budget.hard_stop"
  | "knowledge.source.fetched"
  | "knowledge.source.failed"
  | "connector.content.sync"
  | "research.finding"
  | "research.escalated";

/** v1 notification policy: which events page ops, and what the subject says. */
const RULES: Record<EventName, { subject: (p: Record<string, unknown>) => string } | null> = {
  "task.failed": { subject: (p) => `Task #${p.taskId} failed permanently (${p.kind})` },
  "task.escalated": { subject: (p) => `Task #${p.taskId} escalated — needs a human (${p.kind})` },
  "publish.failed": { subject: (p) => `Publish failed for draft #${p.draftId} (${p.channel})` },
  "publish.succeeded": { subject: (p) => `Published draft #${p.draftId} to ${p.channel}` },
  "workflow.run_failed": { subject: (p) => `Workflow run failed (${p.workflow})` },
  "budget.hard_stop": {
    subject: (p) => `Budget hard-stop: ${p.scope} — spend $${p.spentUsd} hit limit $${p.limitUsd}`,
  },
  "knowledge.source.fetched": {
    subject: (p) => `Knowledge source #${p.sourceId} fetched: ${p.ingested} new, ${p.deduplicated} unchanged`,
  },
  "knowledge.source.failed": {
    subject: (p) => `Knowledge source #${p.sourceId} fetch failed`,
  },
  // Phase 6: connector content sync is routine traffic — observable on the
  // Operations screen but never page-worthy on its own (failures surface as
  // task.failed / knowledge.source.failed which DO notify).
  "connector.content.sync": null,
  // Phase 7: a clean finding is routine dashboard traffic; an ESCALATED one
  // (ambiguous / low confidence, §109) pages ops — a human must judge it.
  "research.finding": null,
  "research.escalated": {
    subject: (p) => `Research item #${p.itemId} escalated (${p.agentSlug}) — needs human review`,
  },
};

async function opsEmail(): Promise<string | null> {
  const setting = await query<{ value: unknown }>(
    `SELECT value FROM system_settings WHERE key = 'ops_email' LIMIT 1`
  ).catch(() => []);
  if (setting.length > 0 && typeof setting[0].value === "string" && setting[0].value.includes("@")) {
    return setting[0].value;
  }
  return process.env.EMAIL_TARGET ?? null;
}

export interface EmitEventResult {
  eventId: number;
  notifications: Array<{ notificationId: number | null; status: string; taskId: number | null }>;
}

export async function emitEvent(
  businessUnitId: number | null,
  name: EventName,
  payload: Record<string, unknown> = {}
): Promise<EmitEventResult> {
  const ev = await query<{ id: number }>(
    "INSERT INTO events (business_unit_id, name, payload) VALUES ($1, $2, $3::jsonb) RETURNING id",
    [businessUnitId, name, JSON.stringify(payload)]
  );
  const eventId = ev[0].id;

  const rule = RULES[name];
  if (!rule) return { eventId, notifications: [] };

  const target = await opsEmail();
  if (!target) {
    const sup = await query<{ id: number }>(
      `INSERT INTO notifications (business_unit_id, event_id, channel, status, subject, body)
       VALUES ($1, $2, 'email', 'suppressed', $3, $4) RETURNING id`,
      [businessUnitId, eventId, rule.subject(payload), JSON.stringify(payload).slice(0, 4000)]
    );
    return { eventId, notifications: [{ notificationId: sup[0].id, status: "suppressed", taskId: null }] };
  }

  const notif = await query<{ id: number }>(
    `INSERT INTO notifications (business_unit_id, event_id, channel, target, status, subject, body)
     VALUES ($1, $2, 'email', $3, 'pending', $4, $5) RETURNING id`,
    [businessUnitId, eventId, target, rule.subject(payload), JSON.stringify(payload).slice(0, 4000)]
  );
  const notificationId = notif[0].id;
  const spawn = await spawnTask({
    businessUnitId,
    kind: "send_notification",
    payload: { notificationId },
    priority: 50, // notifications outrank routine work
    maxAttempts: 3,
    idempotencyKey: `notify:${notificationId}`,
    createdBy: "event-bus",
  });
  return { eventId, notifications: [{ notificationId, status: "pending", taskId: spawn.taskId }] };
}

export async function markNotificationSent(notificationId: number): Promise<void> {
  await query(
    "UPDATE notifications SET status = 'sent', sent_at = now(), attempts = attempts + 1 WHERE id = $1",
    [notificationId]
  );
}

export async function markNotificationFailed(notificationId: number, error: string): Promise<void> {
  await query(
    "UPDATE notifications SET status = 'failed', last_error = $2, attempts = attempts + 1 WHERE id = $1",
    [notificationId, error.slice(0, 1000)]
  );
}

export interface EventRow {
  id: number;
  business_unit_id: number | null;
  name: string;
  payload: Record<string, unknown>;
  created_at: Date;
}

export async function listEvents(limit = 50): Promise<EventRow[]> {
  return query<EventRow>("SELECT * FROM events ORDER BY id DESC LIMIT $1", [Math.min(limit, 200)]);
}

export interface NotificationRow {
  id: number;
  business_unit_id: number | null;
  event_id: number | null;
  channel: string;
  target: string | null;
  subject: string | null;
  status: string;
  attempts: number;
  last_error: string | null;
  sent_at: Date | null;
  created_at: Date;
}

export async function listNotifications(limit = 50): Promise<NotificationRow[]> {
  return query<NotificationRow>("SELECT * FROM notifications ORDER BY id DESC LIMIT $1", [Math.min(limit, 200)]);
}
