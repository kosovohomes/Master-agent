import { query } from "../lib/db";
import { emitEvent, listEvents, listNotifications, markNotificationSent, markNotificationFailed } from "../lib/tasks/events";
import { getTask } from "../lib/tasks/queue";
import { tick } from "../lib/tasks/engine";
import { setBuiltinEmailSender, registerBuiltins } from "../lib/tasks/executors";

/**
 * Event bus + notifications v1 suite (Phase 3):
 *  - emitEvent persists an append-only event row
 *  - notification fanout rules (task.failed / task.escalated / publish.*)
 *  - suppression when no target is configured (still observable)
 *  - delivery rides the queue as send_notification tasks; injected sender
 *  - terminal delivery failure marks the notification failed (no cascade)
 *  - loop guard: failed notification delivery emits NO further events
 */
let failures = 0;
function check(name: string, cond: boolean, detail = "") {
  console.log(`${cond ? "PASS" : "FAIL"} ${name}${detail ? " :: " + detail : ""}`);
  if (!cond) failures++;
}

const createdTaskIds: number[] = [];
const createdEventIds: number[] = [];
const createdNotificationIds: number[] = [];
const savedEmailTarget = process.env.EMAIL_TARGET;

try {
  registerBuiltins();

  // ---------- suppression: no target configured ----------
  delete process.env.EMAIL_TARGET;
  await query("DELETE FROM system_settings WHERE key = 'ops_email'").catch(() => undefined);
  const sup = await emitEvent(null, "publish.succeeded", { draftId: 1, channel: "x" });
  createdEventIds.push(sup.eventId);
  sup.notifications.forEach((n) => { if (n.notificationId) createdNotificationIds.push(n.notificationId); });
  check("event row persisted", sup.eventId > 0);
  check("publish.succeeded fans out one notification", sup.notifications.length === 1);
  const supRow = (await query<{ status: string; target: string | null }>("SELECT status, target FROM notifications WHERE id = $1", [sup.notifications[0].notificationId!]))[0];
  check("no target → suppressed (observable intent)", supRow.status === "suppressed" && supRow.target === null);
  check("suppression spawns NO delivery task", sup.notifications[0].taskId === null);

  // ---------- fanout with target ----------
  process.env.EMAIL_TARGET = "events-suite@test.dev";
  const emitted = await emitEvent(null, "task.failed", { taskId: 4242, kind: "noop_probe", error: "boom" });
  createdEventIds.push(emitted.eventId);
  emitted.notifications.forEach((n) => { if (n.notificationId) createdNotificationIds.push(n.notificationId); });
  check("task.failed fans out one notification + delivery task", emitted.notifications.length === 1 && emitted.notifications[0].taskId !== null);
  if (emitted.notifications[0].taskId) createdTaskIds.push(emitted.notifications[0].taskId);
  const pendRow = (await query<{ status: string; target: string | null; subject: string | null }>(
    "SELECT status, target, subject FROM notifications WHERE id = $1", [emitted.notifications[0].notificationId!]
  ))[0];
  check("pending notification carries target + subject", pendRow.status === "pending" && pendRow.target === "events-suite@test.dev" && (pendRow.subject ?? "").includes("4242"));

  // ---------- delivery through the queue ----------
  const sentTo: string[] = [];
  setBuiltinEmailSender(async (p) => { sentTo.push(`${p.target}:${p.subject}`); });
  registerBuiltins();
  const tr = await tick({ workerId: "events-suite", batch: 10 });
  check("tick delivered the notification task", tr.succeeded >= 1);
  const sentRow = (await query<{ status: string; attempts: number }>("SELECT status, attempts FROM notifications WHERE id = $1", [emitted.notifications[0].notificationId!]))[0];
  check("notification marked sent with attempt", sentRow.status === "sent" && sentRow.attempts === 1, JSON.stringify(sentRow));
  check("delivery used the injected sender", sentTo.some((s) => s.startsWith("events-suite@test.dev:")));

  // ---------- terminal delivery failure → notification failed, NO event cascade ----------
  setBuiltinEmailSender(async () => { throw new Error("smtp down"); });
  registerBuiltins();
  const doomed = await emitEvent(null, "task.escalated", { taskId: 5151, kind: "noop_probe", reason: "needs human" });
  createdEventIds.push(doomed.eventId);
  doomed.notifications.forEach((n) => { if (n.notificationId) createdNotificationIds.push(n.notificationId); });
  if (doomed.notifications[0].taskId) createdTaskIds.push(doomed.notifications[0].taskId);
  // maxAttempts 1 → first failure is terminal
  await query("UPDATE tasks SET max_attempts = 1 WHERE id = $1", [doomed.notifications[0].taskId!]);
  await tick({ workerId: "events-doom", batch: 10 });
  const deadRow = (await query<{ status: string; last_error: string | null }>("SELECT status, last_error FROM notifications WHERE id = $1", [doomed.notifications[0].notificationId!]))[0];
  check("terminal delivery failure marks notification failed", deadRow.status === "failed" && (deadRow.last_error ?? "").includes("smtp down"), JSON.stringify(deadRow));
  const cascade = await query<{ n: number }>(
    `SELECT count(*)::int AS n FROM events WHERE name = 'task.failed'
       AND payload->>'kind' = 'send_notification'`
  );
  check("loop guard: no task.failed event about send_notification", cascade[0].n === 0, `n=${cascade[0].n}`);

  // ---------- list views ----------
  const evs = await listEvents(10);
  check("listEvents returns recent events", evs.some((e) => e.id === emitted.eventId));
  const nots = await listNotifications(10);
  check("listNotifications returns recent notifications", nots.some((n) => n.id === emitted.notifications[0].notificationId));

  // ---------- mark helpers ----------
  const m = (await query<{ id: number }>(
    `INSERT INTO notifications (channel, target, subject, status) VALUES ('email', 'm@test.dev', 'm', 'pending') RETURNING id`
  ))[0];
  createdNotificationIds.push(m.id);
  await markNotificationSent(m.id);
  check("markNotificationSent works", (await query<{ status: string }>("SELECT status FROM notifications WHERE id = $1", [m.id]))[0].status === "sent");
  await markNotificationFailed(m.id, "late failure");
  check("markNotificationFailed keeps row observable", (await query<{ status: string; last_error: string | null }>("SELECT status, last_error FROM notifications WHERE id = $1", [m.id]))[0].status === "failed");
} finally {
  process.env.EMAIL_TARGET = savedEmailTarget;
  try {
    if (createdTaskIds.length) {
      await query("DELETE FROM task_steps WHERE task_id = ANY($1)", [createdTaskIds]);
      await query("DELETE FROM tasks WHERE id = ANY($1)", [createdTaskIds]);
    }
    await query("DELETE FROM task_steps WHERE task_id IN (SELECT id FROM tasks WHERE kind = 'send_notification' AND created_by = 'event-bus')");
    await query("DELETE FROM tasks WHERE kind = 'send_notification' AND created_by = 'event-bus'");
    if (createdNotificationIds.length) await query("DELETE FROM notifications WHERE id = ANY($1)", [createdNotificationIds]);
    if (createdEventIds.length) await query("DELETE FROM events WHERE id = ANY($1)", [createdEventIds]);
    await query("DELETE FROM notifications WHERE target = 'events-suite@test.dev' OR target = 'm@test.dev'");
    await query("DELETE FROM notifications WHERE subject LIKE 'Task #4242%' OR subject LIKE 'Task #5151%'");
    await query("DELETE FROM events WHERE payload->>'taskId' IN ('4242','5151')");
  } catch (e) {
    console.error("cleanup error", e);
  }
}

if (failures > 0) { console.error(`${failures} FAIL`); process.exit(1); }
console.log("EVENTS SUITE PASS");
