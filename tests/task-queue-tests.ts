import assert from "node:assert";
import { query } from "../lib/db";
import {
  spawnTask, claimNextTask, completeTask, failTask, cancelTask, isCancelled,
  recoverStuckTasks, markEscalated, markWaitingApproval, recordStep, listTaskSteps,
  getTask, backoffDelaySec,
} from "../lib/tasks/queue";
import { tick } from "../lib/tasks/engine";
import { registerTaskHandler } from "../lib/tasks/handlers";
import { ensureRegisteredForApi } from "../lib/tasks/bootstrap";
import { registerBuiltins } from "../lib/tasks/executors";

/**
 * Task queue suite (Phase 3 — §140 "jobs must not disappear"):
 *  - spawn (defaults + idempotency, incl. concurrent duplicate spawns)
 *  - claim exclusivity (FOR UPDATE SKIP LOCKED) + attempt accounting
 *  - retry/backoff and terminal failure
 *  - cancellation (queued outright, inflight cooperative)
 *  - visibility-timeout recovery (crashed worker requeue)
 *  - step records + escalation / waiting_approval states
 *  - engine tick end-to-end on a registered handler
 */
let failures = 0;
function check(name: string, cond: boolean, detail = "") {
  console.log(`${cond ? "PASS" : "FAIL"} ${name}${detail ? " :: " + detail : ""}`);
  if (!cond) failures++;
}

ensureRegisteredForApi(); // registers builtins (agent_dispatch etc.)
registerBuiltins();       // idempotent double-registration is safe

const createdTenantIds: number[] = [];
const createdTaskIds: number[] = [];
const createdEventIds: number[] = [];
const createdNotificationIds: number[] = [];

function trackTask(id: number) { createdTaskIds.push(id); return id; }

async function mkTenant(name: string): Promise<number> {
  const rows = await query<{ id: number }>(
    "INSERT INTO tenants (slug, name) VALUES ($1, $2) RETURNING id",
    [`tq-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`, name]
  );
  createdTenantIds.push(rows[0].id);
  return rows[0].id;
}

try {
  // ---------- backoff curve ----------
  check("backoff: attempt 1 = 20s", backoffDelaySec(1) === 20);
  check("backoff: attempt 2 = 80s (4x)", backoffDelaySec(2) === 80);
  check("backoff: attempt 3 = 320s", backoffDelaySec(3) === 320);
  check("backoff: capped at 1h", backoffDelaySec(9) === 3600);

  // ---------- spawn defaults ----------
  const tenantA = await mkTenant("TQ A");
  const spawned = await spawnTask({ tenantId: tenantA, kind: "noop_probe", payload: { x: 1 }, createdBy: "suite" });
  trackTask(spawned.taskId);
  check("spawn creates queued task", spawned.created === true);
  const t1 = (await getTask(spawned.taskId))!;
  check("spawn defaults: queued / attempts 0 / max 3 / priority 100",
    t1.status === "queued" && t1.attempts === 0 && t1.max_attempts === 3 && t1.priority === 100, JSON.stringify({ s: t1.status, a: t1.attempts }));
  check("spawn payload round-trips", (t1.payload as { x: number }).x === 1);

  // ---------- idempotency: sequential ----------
  const again = await spawnTask({ tenantId: tenantA, kind: "noop_probe", payload: { x: 1 }, idempotencyKey: "tq-dedupe-1" });
  const again2 = await spawnTask({ tenantId: tenantA, kind: "noop_probe", payload: { x: 1 }, idempotencyKey: "tq-dedupe-1" });
  trackTask(again.taskId);
  check("idempotent spawn: second returns existing (created=false)", again.created === true && again2.created === false, JSON.stringify(again2));
  check("idempotent spawn: same taskId", again.taskId === again2.taskId);

  // ---------- idempotency: concurrent duplicate spawns (§88) ----------
  const key = `tq-conc-${Date.now()}`;
  const races = await Promise.all(
    Array.from({ length: 5 }, () =>
      spawnTask({ tenantId: tenantA, kind: "noop_probe", idempotencyKey: key })
    )
  );
  races.filter((r) => r.created).forEach((r) => trackTask(r.taskId));
  check("5 concurrent spawns with same key → exactly 1 created", races.filter((r) => r.created).length === 1, JSON.stringify(races));
  check("all concurrent spawns agree on the taskId", new Set(races.map((r) => r.taskId)).size === 1);
  // retire the raced task so it cannot win claims intended for later tasks
  await cancelTask(races.find((r) => r.created)!.taskId, "suite");

  // ---------- claim mechanics ----------
  // priority 1: beats any older same-priority stragglers in the shared CI DB
  const due = await spawnTask({ tenantId: tenantA, kind: "noop_probe", createdBy: "suite-claim", priority: 1 });
  trackTask(due.taskId);
  const worker1 = `w1-${Date.now()}`;
  const claimed = await claimNextTask(worker1);
  assert(claimed !== null);
  check("claim returns the due task", claimed!.id === due.taskId);
  check("claim increments attempts + stamps worker", claimed!.attempts === 1 && claimed!.claimed_by === worker1 && claimed!.status === "claimed");
  // a second claim must NOT return the same task (SKIP LOCKED / status flip)
  const claimed2 = await claimNextTask("w2");
  check("claimed task is not claimable again", claimed2 === null || claimed2.id !== due.taskId);
  if (claimed2) trackTask(claimed2.id);

  // not-yet-due task is invisible to claims
  const future = await spawnTask({ tenantId: tenantA, kind: "noop_probe", runAt: new Date(Date.now() + 60 * 60 * 1000) });
  trackTask(future.taskId);
  const claimFuture = await claimNextTask("w3");
  check("future-scheduled task not claimable", claimFuture === null || claimFuture.id !== future.taskId);

  // ---------- retry / backoff / terminal ----------
  // priority 1: claim identity matters here — beat any older same-priority
  // stragglers left by other suites on a shared persistent DB.
  const flaky = await spawnTask({ tenantId: tenantA, kind: "noop_probe", maxAttempts: 2, priority: 1 });
  trackTask(flaky.taskId);
  await claimNextTask("w4"); // attempts → 1
  const fail1 = await failTask(flaky.taskId, new Error("boom 1"));
  check("failure under max attempts → retry", fail1.outcome === "retry" && fail1.nextAttemptAt !== null);
  const tFlaky1 = (await getTask(flaky.taskId))!;
  check("retry state: queued with error recorded", tFlaky1.status === "queued" && tFlaky1.error === "boom 1" && tFlaky1.attempts === 1);
  // backoff pushed next_run_at into the future (20s) — force it due again,
  // the way wall-clock time would between real engine ticks
  await query("UPDATE tasks SET next_run_at = now() WHERE id = $1", [flaky.taskId]);
  await claimNextTask("w5"); // attempts → 2
  const fail2 = await failTask(flaky.taskId, new Error("boom 2"));
  check("failure at max attempts → terminal failed", fail2.outcome === "terminal");
  const tFlaky2 = (await getTask(flaky.taskId))!;
  check("terminal state: failed + finished_at", tFlaky2.status === "failed" && tFlaky2.finished_at !== null);

  // ---------- cancellation ----------
  const cq = await spawnTask({ tenantId: tenantA, kind: "noop_probe" });
  trackTask(cq.taskId);
  check("cancel queued → cancelled outright", (await cancelTask(cq.taskId, "suite")).outcome === "cancelled");
  check("cancelled task is terminal for further cancels", (await cancelTask(cq.taskId, "suite")).outcome === "terminal");

  const cr = await spawnTask({ tenantId: tenantA, kind: "noop_probe" });
  trackTask(cr.taskId);
  await claimNextTask("w6");
  const cancelInflight = await cancelTask(cr.taskId, "suite");
  check("cancel inflight → cancel_requested (cooperative)", cancelInflight.outcome === "cancel_requested");
  check("cooperative cancel observable via isCancelled", await isCancelled(cr.taskId) === true);

  check("cancel unknown task → not_found", (await cancelTask(999999999, "suite")).outcome === "not_found");

  // ---------- visibility-timeout recovery ----------
  const stuck = await spawnTask({ tenantId: tenantA, kind: "noop_probe" });
  trackTask(stuck.taskId);
  await claimNextTask("w7");
  await query("UPDATE tasks SET heartbeat_at = now() - interval '10 minutes' WHERE id = $1", [stuck.taskId]);
  const healthy = await spawnTask({ tenantId: tenantA, kind: "noop_probe" });
  trackTask(healthy.taskId);
  await claimNextTask("w8");
  const recovered = await recoverStuckTasks();
  const tStuck = (await getTask(stuck.taskId))!;
  const tHealthy = (await getTask(healthy.taskId))!;
  check("stuck inflight task requeued by recovery", recovered >= 1 && tStuck.status === "queued");
  check("healthy inflight task NOT touched by recovery", tHealthy.status === "claimed");
  // attempts were consumed by the dead worker — a repeat crash converges to failed (no infinite loop)
  check("dead worker consumed an attempt (convergence guarantee)", tStuck.attempts === 1, `attempts=${tStuck.attempts}`);

  // ---------- steps + special states ----------
  const stepped = await spawnTask({ tenantId: tenantA, kind: "noop_probe" });
  trackTask(stepped.taskId);
  await recordStep(stepped.taskId, 0, "classify", "done", { agent: "research" });
  await recordStep(stepped.taskId, 1, "execute", "failed", null, "no llm");
  await recordStep(stepped.taskId, 2, "record", "skipped");
  const steps = await listTaskSteps(stepped.taskId);
  check("steps recorded in order with statuses", steps.length === 3 && steps[0].name === "classify" && steps[0].status === "done" && steps[1].status === "failed" && steps[2].status === "skipped");
  check("step output round-trips", (steps[0].output as { agent: string }).agent === "research");

  await markEscalated(stepped.taskId, "needs a human");
  check("markEscalated sets escalated + finished_at", (await getTask(stepped.taskId))!.status === "escalated");
  await markWaitingApproval(stepped.taskId, { note: "p7 readiness" });
  check("waiting_approval state settable", (await getTask(stepped.taskId))!.status === "waiting_approval");

  // ---------- engine tick end-to-end ----------
  let handlerRuns = 0;
  registerTaskHandler("tq_test_ok", async ({ task, step, cancelled }) => {
    handlerRuns++;
    await step("work", async () => ({ n: task.id }));
    if (await cancelled()) return;
    return { ok: true };
  });
  const tickTask = await spawnTask({ tenantId: tenantA, kind: "tq_test_ok" });
  trackTask(tickTask.taskId);
  const tr = await tick({ workerId: "suite", batch: 50 });
  check("tick claims and completes the test task", tr.claimed >= 1 && tr.succeeded >= 1);
  check("handler actually ran", handlerRuns >= 1);
  const tTick = (await getTask(tickTask.taskId))!;
  check("tick marks task succeeded with result", tTick.status === "succeeded" && (tTick.result as { ok?: boolean }).ok === true);

  // ---------- engine: failing handler → retry state with backoff ----------
  registerTaskHandler("tq_test_fail", async () => { throw new Error("deliberate failure"); });
  const failTask1 = await spawnTask({ tenantId: tenantA, kind: "tq_test_fail", maxAttempts: 3 });
  trackTask(failTask1.taskId);
  await tick({ workerId: "suite-fail", batch: 50 });
  const tFail = (await getTask(failTask1.taskId))!;
  check("failing task requeued with backoff by tick", tFail.status === "queued" && tFail.attempts === 1 && tFail.next_run_at > new Date(Date.now() + 5000), JSON.stringify({ s: tFail.status, a: tFail.attempts }));

  // ---------- unknown kind → terminal failure via tick ----------
  const unknown = await spawnTask({ tenantId: tenantA, kind: "no_such_kind_v1", maxAttempts: 1 });
  trackTask(unknown.taskId);
  await tick({ workerId: "suite-unknown", batch: 50 });
  const tUnknown = (await getTask(unknown.taskId))!;
  check("unknown kind fails terminally with clear error", tUnknown.status === "failed" && (tUnknown.error ?? "").includes("no task handler"));

  // ---------- completeTask result round-trip ----------
  const ct = await spawnTask({ tenantId: tenantA, kind: "noop_probe" });
  trackTask(ct.taskId);
  await completeTask(ct.taskId, { alpha: 42 });
  check("completeTask stores JSONB result", ((await getTask(ct.taskId))!.result as { alpha: number }).alpha === 42);
} finally {
  try {
    if (createdTaskIds.length) {
      await query("DELETE FROM task_steps WHERE task_id = ANY($1)", [createdTaskIds]);
      await query("DELETE FROM tasks WHERE id = ANY($1)", [createdTaskIds]);
    }
    if (createdNotificationIds.length) await query("DELETE FROM notifications WHERE id = ANY($1)", [createdNotificationIds]);
    if (createdEventIds.length) await query("DELETE FROM events WHERE id = ANY($1)", [createdEventIds]);
    // cascade cleanup: drafts/channels via tenants; tasks not FK'd → explicit above
    await query("DELETE FROM tasks WHERE tenant_id = ANY($1)", [createdTenantIds.length ? createdTenantIds : [0]]);
    await query("DELETE FROM content_publications WHERE tenant_id = ANY($1)", [createdTenantIds.length ? createdTenantIds : [0]]);
    await query("DELETE FROM tenants WHERE id = ANY($1)", [createdTenantIds.length ? createdTenantIds : [0]]);
  } catch (e) {
    console.error("cleanup error", e);
  }
}

if (failures > 0) { console.error(`${failures} FAIL`); process.exit(1); }
console.log("TASK QUEUE SUITE PASS");
