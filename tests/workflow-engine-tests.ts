import assert from "node:assert";
import { query } from "../lib/db";
import { spawnTask, getTask, listTaskSteps } from "../lib/tasks/queue";
import { tick, triggerWorkflow, getWorkflowBySlug, settleWorkflowRun } from "../lib/tasks/engine";
import { registerTaskHandler, getTaskHandler } from "../lib/tasks/handlers";
import {
  makePublishingSweepHandler, setBuiltinDispatchLlm, setBuiltinEmailSender,
  publicationKey, registerBuiltins,
} from "../lib/tasks/executors";
import { createDraft, approveDraft, scheduleDraft } from "../lib/agents/approval";
import type { LLMClient } from "../lib/llm";

/**
 * Workflow engine suite (Phase 3 acceptance):
 *  - scheduled_publishing_sweep seeded as Workflow #1
 *  - triggerWorkflow → workflow_runs row + task spawn (+ idempotent re-trigger)
 *  - settleWorkflowRun finalization
 *  - FORCED DUPLICATE SWEEP: two concurrent sweeps → ZERO duplicate posts (§88)
 *  - dispatch wrapped as the first task executor; classifier FALLBACK →
 *    ESCALATED (C-16) with no draft, allowFallback preserves legacy behavior
 *  - send_notification delivery through the queue with an injected sender
 */
let failures = 0;
function check(name: string, cond: boolean, detail = "") {
  console.log(`${cond ? "PASS" : "FAIL"} ${name}${detail ? " :: " + detail : ""}`);
  if (!cond) failures++;
}

const createdTenantIds: number[] = [];
const createdTaskIds: number[] = [];
const createdChannelIds: number[] = [];
const createdDraftIds: number[] = [];

function trackTask(id: number) { createdTaskIds.push(id); return id; }

async function mkTenant(name: string): Promise<number> {
  const rows = await query<{ id: number }>(
    "INSERT INTO tenants (slug, name) VALUES ($1, $2) RETURNING id",
    [`wf-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`, name]
  );
  createdTenantIds.push(rows[0].id);
  return rows[0].id;
}

async function mkChannel(tenantId: number, kind = "x"): Promise<number> {
  const rows = await query<{ id: number }>(
    `INSERT INTO channels (tenant_id, kind, token_encrypted, status)
     VALUES ($1, $2, 'plain-test-token', 'healthy') RETURNING id`,
    [tenantId, kind]
  );
  createdChannelIds.push(rows[0].id);
  return rows[0].id;
}

try {
  // ---------- Workflow #1 seeded ----------
  const sweepWf = await getWorkflowBySlug("scheduled_publishing_sweep");
  check("scheduled_publishing_sweep workflow seeded + enabled", sweepWf !== null && sweepWf!.enabled === true && sweepWf!.trigger_kind === "schedule");
  check("workflow #1 bound to publishing_sweep task", sweepWf!.task_kind === "publishing_sweep");

  // ---------- triggerWorkflow ----------
  const dayKey = `wf-test-${Date.now()}`;
  const trig = await triggerWorkflow("scheduled_publishing_sweep", {
    triggerRef: `test:${dayKey}`, idempotencyKey: key(dayKey), createdBy: "suite",
  });
  assert(trig !== null);
  trackTask(trig!.taskId);
  check("trigger creates run + task", trig!.taskCreated === true && trig!.workflowRunId > 0);
  const runRow = (await query<{ task_id: number; trigger_ref: string; status: string }>(
    "SELECT task_id, trigger_ref, status FROM workflow_runs WHERE id = $1", [trig!.workflowRunId]
  ))[0];
  check("run row links task + trigger ref", runRow.task_id === trig!.taskId && runRow.trigger_ref === `test:${dayKey}`);

  const retrig = await triggerWorkflow("scheduled_publishing_sweep", {
    triggerRef: `test:${dayKey}`, idempotencyKey: key(dayKey), createdBy: "suite",
  });
  assert(retrig !== null);
  check("re-trigger with same key dedupes the task", retrig!.taskCreated === false && retrig!.taskId === trig!.taskId);

  // Drain the triggered (empty) sweep now so it cannot contend with the
  // dedicated duplicate-sweep tasks below.
  await tick({ workerId: "wf-drain", batch: 5 });
  check("triggered sweep drained (no drafts yet)", (await getTask(trig!.taskId))!.status === "succeeded");

  check("unknown workflow trigger → null", (await triggerWorkflow("no_such_workflow")) === null);

  // ---------- settleWorkflowRun ----------
  await query("UPDATE tasks SET status = 'succeeded', finished_at = now() WHERE id = $1", [trig!.taskId]);
  await settleWorkflowRun(trig!.workflowRunId);
  const settled = (await query<{ status: string; finished_at: Date | null }>(
    "SELECT status, finished_at FROM workflow_runs WHERE id = $1", [trig!.workflowRunId]
  ))[0];
  check("settleWorkflowRun finalizes succeeded run", settled.status === "succeeded" && settled.finished_at !== null);

  // ================================================================
  // FORCED DUPLICATE SWEEP → ZERO DUPLICATE POSTS (§88 core acceptance)
  // Two sweeps run CONCURRENTLY against the same scheduled draft. The
  // content_publications idempotency claim guarantees exactly one publish.
  // ================================================================
  const tenant = await mkTenant("WF Duplicate Sweep");
  await mkChannel(tenant);
  const { draftId } = await createDraft({ tenantId: tenant, agent: "marketing", channel: "x", content: `dup sweep ${Date.now()}` });
  createdDraftIds.push(draftId);
  await approveDraft(draftId);
  await scheduleDraft(draftId);

  const publishCalls: string[] = [];
  let inFlight = 0;
  let maxConcurrent = 0;
  const sweepHandler = makePublishingSweepHandler({
    async publish(p) {
      inFlight++;
      maxConcurrent = Math.max(maxConcurrent, inFlight);
      await new Promise((r) => setTimeout(r, 60)); // widen the race window
      publishCalls.push(publishCallKey(p));
      inFlight--;
      return { externalId: `ext-${publishCalls.length}` };
    },
  });
  registerTaskHandler("publishing_sweep", sweepHandler);
  check("sweep handler registered under its kind", getTaskHandler("publishing_sweep") === sweepHandler);

  const s1 = await spawnTask({ tenantId: tenant, kind: "publishing_sweep", createdBy: "suite" });
  const s2 = await spawnTask({ tenantId: tenant, kind: "publishing_sweep", createdBy: "suite" });
  trackTask(s1.taskId); trackTask(s2.taskId);

  // Two engine ticks race: each claims one sweep task, both handlers run
  // concurrently over the same due draft.
  const [tickA, tickB] = await Promise.all([
    tick({ workerId: "dup-a", batch: 5 }),
    tick({ workerId: "dup-b", batch: 5 }),
  ]);
  check("both sweep tasks were claimed", tickA.claimed + tickB.claimed >= 2);

  check("ZERO duplicate posts: exactly 1 publish call for the draft", publishCalls.length === 1, `calls=${JSON.stringify(publishCalls)}`);
  const pub = (await query<{ status: string; external_id: string }>(
    "SELECT status, external_id FROM content_publications WHERE idempotency_key = $1", [publicationKey(draftId)]
  ))[0];
  check("publication row finalized published", pub.status === "published" && !!pub.external_id);
  const draftRow = (await query<{ status: string }>("SELECT status FROM drafts WHERE id = $1", [draftId]))[0];
  check("draft marked posted exactly once", draftRow.status === "posted");
  const results = await query<{ result: Record<string, unknown>; status: string }>(
    "SELECT result, status FROM tasks WHERE id = ANY($1) ORDER BY id", [[s1.taskId, s2.taskId]]
  );
  const postedSum = results.reduce((acc, r) => acc + Number((r.result as { posted?: number })?.posted ?? 0), 0);
  const dupSum = results.reduce((acc, r) => acc + Number((r.result as { duplicates_prevented?: number })?.duplicates_prevented ?? 0), 0);
  check("winner posted=1, loser prevented=1", postedSum === 1 && dupSum >= 1, JSON.stringify(results.map((r) => r.result)));
  check("both sweeps succeeded (loser is a clean no-op)", results.every((r) => r.status === "succeeded"));

  // triple-check: re-running the sweep now finds nothing due
  const rerun = await spawnTask({ tenantId: tenant, kind: "publishing_sweep", createdBy: "suite" });
  trackTask(rerun.taskId);
  await tick({ workerId: "dup-rerun", batch: 5 });
  check("re-sweep after publication: no new publish calls", publishCalls.length === 1);

  // ================================================================
  // dispatch as the FIRST task executor + classifier escalation (C-16)
  // ================================================================
  const tenantB = await mkTenant("WF Dispatch");

  // (a) non-matching topic inside a task → ESCALATED, no draft, no run
  const esc = await spawnTask({
    tenantId: tenantB, kind: "agent_dispatch",
    payload: { tenantId: tenantB, topic: "hello there general", channel: "x" },
    createdBy: "suite",
  });
  trackTask(esc.taskId);
  await tick({ workerId: "wf-esc", batch: 5 });
  const tEsc = (await getTask(esc.taskId))!;
  check("classifier FALLBACK inside task → escalated", tEsc.status === "escalated", tEsc.error ?? "");
  check("escalation names the reason", (tEsc.error ?? "").includes("matched no worker agent"));
  const escSteps = await listTaskSteps(esc.taskId);
  check("classify step recorded as failed", escSteps.some((s) => s.name === "classify" && s.status === "failed"));
  const escDrafts = await query<{ n: string }>("SELECT count(*)::text AS n FROM drafts WHERE tenant_id = $1", [tenantB]);
  check("no silent marketing draft was created", escDrafts[0].n === "0");

  // (b) allowFallback: legacy permissive behavior via task (fake LLM)
  const fakeLlm: LLMClient = {
    async complete() { return "Subject: dispatch via task\nfake body from suite"; },
    async embed() { return [[0.1, 0.2]]; },
  };
  setBuiltinDispatchLlm(fakeLlm);
  const ok = await spawnTask({
    tenantId: tenantB, kind: "agent_dispatch",
    payload: { tenantId: tenantB, topic: "plain product update", channel: "x", allowFallback: true },
    createdBy: "suite",
  });
  trackTask(ok.taskId);
  await tick({ workerId: "wf-ok", batch: 5 });
  const tOk = (await getTask(ok.taskId))!;
  check("allowFallback task runs marketing and succeeds", tOk.status === "succeeded", JSON.stringify({ s: tOk.status, e: tOk.error }));
  const okDrafts = await query<{ id: number }>("SELECT id FROM drafts WHERE tenant_id = $1", [tenantB]);
  check("allowFallback produced a draft", okDrafts.length === 1);
  check("task linked to agent_runs via run_id", tOk.run_id !== null);
  const runLinked = await query<{ agent: string; trigger: string }>("SELECT agent, trigger FROM agent_runs WHERE id = $1", [tOk.run_id!]);
  check("run attribution present (agent + task trigger)", runLinked.length === 1 && runLinked[0].agent === "marketing");

  // (c) chat channel → customer_service recorded without LLM
  const chat = await spawnTask({
    tenantId: tenantB, kind: "agent_dispatch",
    payload: { tenantId: tenantB, topic: "anything", channel: "chat" },
    createdBy: "suite",
  });
  trackTask(chat.taskId);
  await tick({ workerId: "wf-chat", batch: 5 });
  const tChat = (await getTask(chat.taskId))!;
  check("chat-channel dispatch task succeeds (customer_service recorded)", tChat.status === "succeeded");

  // ================================================================
  // send_notification through the queue (injected sender)
  // ================================================================
  const sentTo: string[] = [];
  setBuiltinEmailSender(async (p) => { sentTo.push(p.target); });
  registerBuiltins(); // re-register so the injected sender is picked up

  const tenantC = await mkTenant("WF Notify");
  const notif = (await query<{ id: number }>(
    `INSERT INTO notifications (business_unit_id, channel, target, subject, body, status)
     VALUES (NULL, 'email', 'ops@suite.test', 'Suite subject', 'Suite body', 'pending') RETURNING id`
  ))[0];
  const notifTask = await spawnTask({ kind: "send_notification", payload: { notificationId: notif.id }, createdBy: "suite" });
  trackTask(notifTask.taskId);
  await tick({ workerId: "wf-notify", batch: 5 });
  const nRow = (await query<{ status: string; sent_at: Date | null }>("SELECT status, sent_at FROM notifications WHERE id = $1", [notif.id]))[0];
  check("notification delivered via queue", nRow.status === "sent" && nRow.sent_at !== null, JSON.stringify(nRow));
  check("injected sender got the target", sentTo.includes("ops@suite.test"));

  // idempotent redelivery: a second send task on a sent notification skips
  const notifTask2 = await spawnTask({ kind: "send_notification", payload: { notificationId: notif.id }, createdBy: "suite" });
  trackTask(notifTask2.taskId);
  await tick({ workerId: "wf-notify2", batch: 5 });
  check("redelivery skips non-pending notification (task succeeds)", (await getTask(notifTask2.taskId))!.status === "succeeded" && sentTo.length === 1);
} finally {
  // restore production builtins for any later process-local use
  try {
    registerBuiltins();
    if (createdTaskIds.length) {
      await query("DELETE FROM task_steps WHERE task_id = ANY($1)", [createdTaskIds]);
      await query("DELETE FROM tasks WHERE id = ANY($1)", [createdTaskIds]);
    }
    // event-spawned notification tasks (untracked ids) — ephemeral DB hygiene
    await query("DELETE FROM task_steps WHERE task_id IN (SELECT id FROM tasks WHERE kind = 'send_notification' AND created_by = 'event-bus')");
    await query("DELETE FROM tasks WHERE kind = 'send_notification' AND created_by = 'event-bus'");
    await query("DELETE FROM tasks WHERE tenant_id = ANY($1)", [createdTenantIds.length ? createdTenantIds : [0]]);
    await query("DELETE FROM workflow_runs WHERE business_unit_id IS NULL AND trigger_ref LIKE 'test:wf-test-%'");
    await query("DELETE FROM content_publications WHERE tenant_id = ANY($1)", [createdTenantIds.length ? createdTenantIds : [0]]);
    await query("DELETE FROM notifications WHERE target = 'ops@suite.test'");
    await query("DELETE FROM events WHERE payload->>'taskId' = ANY($1)", [createdTaskIds.length ? createdTaskIds.map(String) : ["0"]]);
    await query("DELETE FROM drafts WHERE id = ANY($1)", [createdDraftIds.length ? createdDraftIds : [0]]);
    await query("DELETE FROM channels WHERE id = ANY($1)", [createdChannelIds.length ? createdChannelIds : [0]]);
    await query("DELETE FROM tenants WHERE id = ANY($1)", [createdTenantIds.length ? createdTenantIds : [0]]);
  } catch (e) {
    console.error("cleanup error", e);
  }
}

function key(dayKey: string): string { return `wf-dedupe:${dayKey}`; }
function publishCallKey(p: { content: string }): string { return p.content.slice(0, 40); }

if (failures > 0) { console.error(`${failures} FAIL`); process.exit(1); }
console.log("WORKFLOW ENGINE SUITE PASS");
