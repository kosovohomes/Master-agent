/**
 * Phase 15 (roadmap P14) — Supervisor against real Postgres: §57 contract
 * inputs validated at creation (objective/BU/tenant-identity/budget
 * ceiling/deadline), the bounded-plan law (≤6 steps, worker enum, strictly
 * earlier dependencies, permission envelope per step), the LLM planner with
 * the deterministic classifier floor (degraded single-step; FALLBACK
 * objective escalates — no silent wrong work), wave-by-wave delegation of a
 * dependency-ordered task graph, §23 handoff logging (every delegation
 * logged, statuses synced from the queue), hard budget ceiling (plan refuse
 * + delegate-gate + blocked remaining steps), permission ceiling (floor
 * rejected when even the classifier's route exceeds the envelope), kill
 * switches (supervisor + worker), flag drill (planning refuses while
 * in-flight settling continues), deadline ceiling, operator cancel, and the
 * approval-respecting invariant (delegated work lands as PENDING drafts;
 * nothing publishes/schedules/sends; the router is never consulted for
 * delegation — forced agents carry trigger="supervisor").
 */
import { query } from "../lib/db";
import { spawnTask, getTask, completeTask, markEscalated } from "../lib/tasks/queue";
import { getTaskHandler } from "../lib/tasks/handlers";
import type { TaskHandlerInput, TaskRow } from "../lib/tasks/types";
import type { LLMClient, ChatMessage } from "../lib/ai/types";
import { createPlan, validatePlanOutput, planSpend, cancelPlan, getPlan, SupervisorPlanError } from "../lib/supervisor/service";
import { advanceSupervisorPlans, settleSupervisorPlan } from "../lib/supervisor/monitor";
import { registerSupervisorHandlers, setSupervisorLlm } from "../lib/supervisor/tasks";
import { MAX_PLAN_STEPS, DELEGABLE_WORKERS } from "../lib/supervisor/types";
import { routeAgent } from "../lib/agents/core";
import { setBuiltinDispatchLlm, TaskEscalatedError } from "../lib/tasks/executors";

let failures = 0;
function check(name: string, cond: boolean, detail = "") {
  console.log(`${cond ? "PASS" : "FAIL"} ${name}${detail ? " :: " + detail : ""}`);
  if (!cond) failures++;
}

async function expectSupervisorError(name: string, p: () => Promise<unknown>, code: string) {
  try {
    await p();
    check(name, false, `expected ${code}, no error`);
  } catch (e) {
    const ok = e instanceof SupervisorPlanError && e.code === code;
    check(name, ok, ok ? "" : `expected ${code}, got ${e instanceof Error ? e.message : String(e)}`);
  }
}

async function expectEscalation(name: string, run: () => Promise<unknown>, messagePart: string) {
  try {
    await run();
    check(name, false, `expected escalation containing "${messagePart}", no error`);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    check(name, msg.includes(messagePart), msg.slice(0, 220));
  }
}

const stamp = Date.now();
let tenantA = 0;
let buA = 0;
let buNoTenant = 0;
const createdTasks: number[] = [];
const createdPlans: number[] = [];
const createdDrafts: number[] = [];
const createdTenants: number[] = [];
const createdBus: number[] = [];

async function trackTask(id: number) {
  createdTasks.push(id);
}

function stepRecorder(): Omit<TaskHandlerInput, "task"> {
  return {
    step: async (_name: string, fn: () => Promise<Record<string, unknown> | void>) => (await fn()) ?? {},
    cancelled: async () => false,
  };
}

/**
 * Run a handler the way the ENGINE would: terminal writes on outcome
 * (succeeded/escalated). Handlers only compute — the queue is the sole
 * status writer — so without this the monitor would never see settlement.
 * Escalations still rethrow so assertions can inspect the reason.
 */
async function runHandler(kind: string, taskId: number): Promise<Record<string, unknown>> {
  const handler = getTaskHandler(kind);
  if (!handler) throw new Error(`handler missing: ${kind}`);
  const task = (await query<TaskRow>("SELECT * FROM tasks WHERE id = $1", [taskId]))[0];
  try {
    const result = await handler({ task, ...stepRecorder() });
    await completeTask(taskId, (result ?? {}) as Record<string, unknown>);
    return result as Record<string, unknown>;
  } catch (e) {
    if (e instanceof TaskEscalatedError) {
      await markEscalated(taskId, e.message, { reason: e.message });
    }
    throw e;
  }
}

/**
 * Stub LLM. Planning calls carry the supervisor registry prompt as a system
 * message (completeJSON prepends its schema hint first, so route on ALL
 * system content). Delegation calls are plain `complete` (bound/generic
 * executors) — answer in raw text so the draft lands pending approval.
 */
function supervisorStub(planResponse: unknown, opts: { broken?: boolean; raw?: string } = {}): LLMClient {
  return {
    async complete(messages: ChatMessage[]) {
      if (opts.broken) throw new Error("gateway down");
      const sys = messages.map((m) => (m.role === "system" ? m.content : "")).join("\n");
      if (sys.includes("Supervisor Agent")) return JSON.stringify(planResponse);
      return opts.raw ?? `Stubbed worker output ${stamp}`;
    },
    async completeWithUsage(messages: ChatMessage[]) {
      if (opts.broken) throw new Error("gateway down");
      const sys = messages.map((m) => (m.role === "system" ? m.content : "")).join("\n");
      if (sys.includes("Supervisor Agent")) {
        return { content: JSON.stringify(planResponse), usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 } };
      }
      return { content: opts.raw ?? `Stubbed worker output ${stamp}`, usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 } };
    },
    async embed() { throw new Error("no embeds in supervisor tests"); },
    async embedWithUsage() { throw new Error("no embeds in supervisor tests"); },
  } as LLMClient;
}

async function setFlag(enabled: boolean): Promise<void> {
  await query(
    `INSERT INTO feature_flags (key, enabled, description) VALUES ('supervisor', $1, 'test')
     ON CONFLICT (key) DO UPDATE SET enabled = $1`,
    [enabled]
  );
}

async function setAgentFlag(slug: string, enabled: boolean): Promise<void> {
  const key = `disable_agent:${slug}`;
  await query(
    `INSERT INTO feature_flags (key, enabled, description) VALUES ($1, $2, 'test')
     ON CONFLICT (key) DO UPDATE SET enabled = $2`,
    [key, enabled]
  );
}

/** Create a plan straight through the service (route-level auth is M0-covered). */
async function makePlan(p: {
  objective: string;
  buId?: number;
  budgetUsd?: number | null;
  deadline?: string | null;
  envelope?: string[];
  constraints?: Record<string, unknown>;
}): Promise<{ planId: number; taskId: number }> {
  const r = await createPlan(
    {
      objective: p.objective,
      businessUnitId: p.buId ?? buA,
      constraints: p.constraints ?? null,
      budgetUsd: p.budgetUsd ?? null,
      deadline: p.deadline ?? null,
    },
    { userId: null, permissions: p.envelope ?? ["*"], via: "legacy-bearer" }
  );
  createdPlans.push(r.planId);
  await trackTask(r.taskId);
  return r;
}

async function main() {
  // ---------------- fixtures ----------------
  const [t] = await query<{ id: number }>(
    `INSERT INTO tenants (slug, name) VALUES ($1, $2) RETURNING id`,
    [`sup-test-${stamp}`, "Supervisor Tenant"]
  );
  tenantA = t.id;
  createdTenants.push(tenantA);
  const [bu] = await query<{ id: number }>(
    `INSERT INTO business_units (slug, name, legacy_tenant_id) VALUES ($1, $2, $3) RETURNING id`,
    [`sup-test-${stamp}`, "Supervisor BU", tenantA]
  );
  buA = bu.id;
  createdBus.push(buA);
  const [bu2] = await query<{ id: number }>(
    `INSERT INTO business_units (slug, name) VALUES ($1, $2) RETURNING id`,
    [`sup-notenant-${stamp}`, "Supervisor BU No Tenant"]
  );
  buNoTenant = bu2.id;
  createdBus.push(buNoTenant);

  await setFlag(true);
  registerSupervisorHandlers(supervisorStub({ steps: [] })); // replaced per-scenario
  setBuiltinDispatchLlm(supervisorStub({}, { raw: `Stubbed worker output ${stamp}` }));

  /* ---------------- §57 input validation (createPlan) ---------------- */
  await expectSupervisorError("create: empty objective refused", () =>
    createPlan({ objective: "   ", businessUnitId: buA }, { userId: null, permissions: ["*"], via: "legacy-bearer" })
  , "INVALID_OBJECTIVE");
  await expectSupervisorError("create: oversized objective refused", () =>
    createPlan({ objective: "x".repeat(501), businessUnitId: buA }, { userId: null, permissions: ["*"], via: "legacy-bearer" })
  , "INVALID_OBJECTIVE");
  await expectSupervisorError("create: unknown BU refused", () =>
    createPlan({ objective: "research the market", businessUnitId: 999999 }, { userId: null, permissions: ["*"], via: "legacy-bearer" })
  , "BU_NOT_FOUND");
  await expectSupervisorError("create: BU without tenant identity refused", () =>
    createPlan({ objective: "research the market", businessUnitId: buNoTenant }, { userId: null, permissions: ["*"], via: "legacy-bearer" })
  , "BU_NO_TENANT");
  await expectSupervisorError("create: budget over the hard ceiling refused", () =>
    createPlan({ objective: "research the market", businessUnitId: buA, budgetUsd: 999 }, { userId: null, permissions: ["*"], via: "legacy-bearer" })
  , "BUDGET_CEILING");
  await expectSupervisorError("create: past deadline refused", () =>
    createPlan({ objective: "research the market", businessUnitId: buA, deadline: "2000-01-01T00:00:00Z" }, { userId: null, permissions: ["*"], via: "legacy-bearer" })
  , "INVALID_DEADLINE");

  {
    const r = await makePlan({ objective: "research AI legal developments this week", budgetUsd: 1, constraints: { tone: "legal" } });
    const plan = (await getPlan(r.planId))!;
    check("create: §57 inputs stored (objective/bu/constraints/budget/permissions)", plan.status === "planning" && plan.business_unit_id === buA && plan.tenant_id === tenantA && plan.constraints.tone === "legal" && Number(plan.budget_usd) === 1);
    check("create: envelope snapshotted", Array.isArray(plan.permissions) && plan.permissions.includes("*"));
    const task = (await getTask(r.taskId))!;
    check("create: supervisor_run task queued with plan payload + budget ceiling", task.kind === "supervisor_run" && task.status === "queued" && (task.payload as { planId?: number }).planId === r.planId && Number(task.budget_usd) === 1);
    check("create: deadline defaults null", plan.deadline === null);
  }

  /* ---------------- bounded-plan law (validatePlanOutput) ---------------- */
  const OK = ["*"];
  check("validate: single research step passes", validatePlanOutput({ steps: [{ agent: "research", objective: "gather intel", dependsOn: [] }] }, OK).ok === true);
  check("validate: over-ceiling step count refused", validatePlanOutput({ steps: Array.from({ length: MAX_PLAN_STEPS + 1 }, (_, i) => ({ agent: "research", objective: `s${i}`, dependsOn: [] })) }, OK).ok === false);
  check("validate: unknown worker refused", validatePlanOutput({ steps: [{ agent: "supervisor", objective: "self-delegate", dependsOn: [] }] }, OK).ok === false);
  check("validate: customer_service not delegable", !(DELEGABLE_WORKERS as readonly string[]).includes("customer_service") && validatePlanOutput({ steps: [{ agent: "customer_service", objective: "chat", dependsOn: [] }] }, OK).ok === false);
  check("validate: forward dependency refused (acyclicity)", validatePlanOutput({ steps: [{ agent: "research", objective: "a", dependsOn: [1] }, { agent: "content", objective: "b", dependsOn: [] }] }, OK).ok === false);
  check("validate: self dependency refused", validatePlanOutput({ steps: [{ agent: "research", objective: "a", dependsOn: [0] }] }, OK).ok === false);
  check("validate: back dependency accepted", validatePlanOutput({ steps: [{ agent: "research", objective: "a", dependsOn: [] }, { agent: "content", objective: "b", dependsOn: [0] }] }, OK).ok === true);
  check("validate: envelope violation refused", validatePlanOutput({ steps: [{ agent: "content", objective: "draft it", dependsOn: [] }] }, ["research.manage"]).ok === false);
  check("validate: envelope wildcard grants", validatePlanOutput({ steps: [{ agent: "content", objective: "draft it", dependsOn: [] }] }, ["*"]).ok === true);
  check("validate: empty plan refused", validatePlanOutput({ steps: [] }, OK).ok === false);

  /* ---------------- planner happy path + wave delegation ---------------- */
  setSupervisorLlm(supervisorStub({
    steps: [
      { agent: "research", objective: "gather this week's AI legal developments", dependsOn: [] },
      { agent: "content", objective: "draft the summary blog post", dependsOn: [0] },
    ],
    notes: "chain research into content",
  }));
  setBuiltinDispatchLlm(supervisorStub({}, { raw: `Weekly legal roundup ${stamp}` }));
  {
    const r = await makePlan({ objective: "research AI legal developments and draft a summary post" });
    const runRes = await runHandler("supervisor_run", r.taskId);
    const plan = (await getPlan(r.planId))!;
    check("planner: plan active with llm-generated graph", plan.status === "active" && plan.generated_by === "llm" && plan.degraded === false, JSON.stringify({ status: plan.status, by: plan.generated_by }));
    check("planner: graph stored (2 steps, dependency chain)", plan.plan?.steps.length === 2 && plan.plan.steps[1].dependsOn[0] === 0);
    check("planner: prompt attribution stamped", plan.prompt_version_id != null && plan.prompt_hash != null);
    check("planner: notes carried", plan.plan?.notes === "chain research into content");
    check("planner: run result reports steps + spawned", runRes.steps === 2 && runRes.spawned === 1);
    const handoffs = await query<{ step_index: number; from_agent: string; to_agent: string; status: string; task_id: number | null }>(
      "SELECT step_index, from_agent, to_agent, status, task_id FROM supervisor_handoffs WHERE plan_id = $1 ORDER BY step_index", [r.planId]
    );
    check("§23: wave 1 handoff logged (supervisor → research)", handoffs.length === 1 && handoffs[0].from_agent === "supervisor" && handoffs[0].to_agent === "research" && handoffs[0].status === "delegated" && handoffs[0].task_id != null, JSON.stringify(handoffs) + " planId=" + r.planId);
    const child = (await getTask(handoffs[0].task_id!))!;
    check("delegation: child is supervisor_delegate, queued, budget-capped at the plan ceiling", child.kind === "supervisor_delegate" && child.status === "queued" && Number(child.budget_usd) === 5, "child=" + JSON.stringify(child));
    check("delegation: wave-2 step NOT delegated before its dependency", !(await query("SELECT id FROM supervisor_handoffs WHERE plan_id = $1 AND step_index = 1", [r.planId])).length);

    // Run the child (research step) → success → monitor advances the wave.
    await trackTask(child.id);
    await runHandler("supervisor_delegate", child.id);
    const adv1 = await advanceSupervisorPlans();
    const h0 = (await query<{ status: string }>("SELECT status FROM supervisor_handoffs WHERE plan_id = $1 AND step_index = 0", [r.planId]))[0];
    check("monitor: succeeded child settles its handoff", h0?.status === "succeeded", "h0=" + JSON.stringify(h0));
    const h1 = (await query<{ status: string; task_id: number | null }>("SELECT status, task_id FROM supervisor_handoffs WHERE plan_id = $1 AND step_index = 1", [r.planId]))[0];
    check("monitor: dependency satisfied → wave 2 delegated", h1.status === "delegated" && h1.task_id != null);
    await trackTask(h1.task_id!);
    await runHandler("supervisor_delegate", h1.task_id!);
    const adv2 = await advanceSupervisorPlans();
    const done = (await getPlan(r.planId))!;
    check("monitor: all steps succeeded → plan completed", done.status === "completed", JSON.stringify(adv1) + " " + JSON.stringify(adv2));
    const fr = done.final_result as { steps?: { agent: string; status: string }[] };
    check("§57 output: final_result carries step outcomes", fr?.steps?.length === 2 && fr.steps.every((s) => s.status === "succeeded"));
    const ev = await query<{ id: number }>("SELECT id FROM events WHERE name = 'supervisor.plan_completed' AND payload->>'planId' = $1", [String(r.planId)]);
    check("events: plan_completed emitted (silent policy)", ev.length === 1);

    // Approval-respecting: delegated content produced a PENDING draft —
    // nothing scheduled/published anywhere in the supervisor path.
    const drafts = await query<{ id: number; status: string; agent: string }>(
      "SELECT id, status, agent FROM drafts WHERE tenant_id = $1 AND agent IN ('research','content') ORDER BY id DESC LIMIT 2", [tenantA]
    );
    createdDrafts.push(...drafts.map((d) => d.id));
    check("approval-respecting: worker output is a PENDING draft", drafts.length === 2 && drafts.every((d) => d.status === "pending"));
    const runRows = await query<{ agent: string; trigger: string }>(
      "SELECT agent, trigger FROM agent_runs WHERE tenant_id = $1 AND trigger = 'supervisor' ORDER BY id DESC LIMIT 2", [tenantA]
    );
    check("attribution: delegated runs carry trigger=supervisor", runRows.length === 2 && runRows.every((r2) => r2.trigger === "supervisor"));
  }

  /* ---------------- deterministic floor (LLM outage) ---------------- */
  setSupervisorLlm(supervisorStub({}, { broken: true }));
  setBuiltinDispatchLlm(supervisorStub({}, { broken: true, raw: "x" }));
  {
    const r = await makePlan({ objective: "research the market for legal AI tools" });
    await runHandler("supervisor_run", r.taskId);
    const plan = (await getPlan(r.planId))!;
    check("floor: planner outage degrades to the classifier floor", plan.status === "active" && plan.generated_by === "deterministic" && plan.degraded === true);
    check("floor: single-step plan routes to the classified worker", plan.plan?.steps.length === 1 && plan.plan.steps[0].agent === "research");
  }

  /* ---------------- fallback objective escalates (C-16 honesty) ---------------- */
  {
    const r = await makePlan({ objective: "zzz unclassifiable gibberish objective qqq" });
    await expectEscalation("floor: classifier FALLBACK objective escalates, never silently routes", () => runHandler("supervisor_run", r.taskId), "matched no worker agent");
    const adv = await advanceSupervisorPlans();
    const plan = (await getPlan(r.planId))!;
    check("floor: escalated planning closes the plan as escalated", plan.status === "escalated", JSON.stringify(adv));
    const ev = await query<{ id: number }>("SELECT id FROM events WHERE name = 'supervisor.plan_escalated' AND payload->>'planId' = $1", [String(r.planId)]);
    check("events: plan_escalated emitted (pages ops)", ev.length === 1);
    const notif = await query<{ status: string }>(
      "SELECT n.status FROM notifications n JOIN events e ON n.event_id = e.id WHERE e.name = 'supervisor.plan_escalated' AND e.payload->>'planId' = $1", [String(r.planId)]
    );
    check("events: escalation notification materialized (suppressed without ops target)", notif.length === 1 && ["suppressed", "pending", "sent"].includes(notif[0].status));
  }

  /* ---------------- permission ceiling ---------------- */
  {
    // Envelope without research.manage: the LLM plan (research step) is
    // rejected AND the classifier floor (research) is rejected too — the
    // plan escalates instead of laundering permissions.
    const r = await makePlan({
      objective: "research the competitive landscape",
      envelope: ["sales.manage"],
    });
    await expectEscalation("permission ceiling: plan exceeding the envelope escalates (planner + floor both rejected)", () => runHandler("supervisor_run", r.taskId), "deterministic floor rejected");
    await advanceSupervisorPlans();
    const plan = (await getPlan(r.planId))!;
    check("permission ceiling: plan closed escalated", plan.status === "escalated");
  }
  {
    // Envelope grants research but not content: LLM plan (content) rejected
    // → the research floor is legal → degraded single-step plan activates.
    setSupervisorLlm(supervisorStub({ steps: [{ agent: "content", objective: "draft it", dependsOn: [] }] }));
    const r = await makePlan({ objective: "research the market", envelope: ["research.manage", "agents.run"] });
    await runHandler("supervisor_run", r.taskId);
    const plan = (await getPlan(r.planId))!;
    check("permission ceiling: legal floor survives an over-reaching LLM plan", plan.status === "active" && plan.degraded === true && plan.plan?.steps[0].agent === "research");
  }

  /* ---------------- budget ceiling ---------------- */
  {
    // $0 plan: wave spawn refuses + remaining steps block + plan escalates.
    const r = await makePlan({ objective: "research the market", budgetUsd: 0 });
    await runHandler("supervisor_run", r.taskId);
    const plan = (await getPlan(r.planId))!;
    check("budget: $0 plan escalates at the wave spawn", plan.status === "escalated" && plan.error_class === "budget_exhausted", `${plan.status}/${plan.error_class}`);
    const blocked = await query<{ status: string }>("SELECT status FROM supervisor_handoffs WHERE plan_id = $1", [r.planId]);
    check("budget: never-delegated steps land blocked", blocked.length === 1 && blocked[0].status === "blocked");
  }
  {
    // Delegate-gate: plan budget drained AFTER spawn → the child refuses to
    // execute and escalates instead of spending through the envelope.
    setSupervisorLlm(supervisorStub({ steps: [{ agent: "research", objective: "gather", dependsOn: [] }] }));
    const r = await makePlan({ objective: "research the market", budgetUsd: 1 });
    await runHandler("supervisor_run", r.taskId);
    const h = (await query<{ task_id: number | null }>("SELECT task_id FROM supervisor_handoffs WHERE plan_id = $1 AND step_index = 0", [r.planId]))[0];
    await query("UPDATE supervisor_plans SET budget_usd = '0' WHERE id = $1", [r.planId]);
    await expectEscalation("budget: child gate refuses when the plan envelope is drained", () => runHandler("supervisor_delegate", h.task_id!), "budget exhausted");
    await advanceSupervisorPlans();
    const plan = (await getPlan(r.planId))!;
    check("budget: drained-envelope escalation propagates to the plan", plan.status === "escalated");
  }

  /* ---------------- kill switches ---------------- */
  {
    await setAgentFlag("supervisor", true);
    const r = await makePlan({ objective: "research the market" });
    await expectEscalation("kill switch: disable_agent:supervisor refuses planning", () => runHandler("supervisor_run", r.taskId), "AGENT_KILL_SWITCH");
    await setAgentFlag("supervisor", false);

    setSupervisorLlm(supervisorStub({ steps: [{ agent: "research", objective: "gather", dependsOn: [] }] }));
    setBuiltinDispatchLlm(supervisorStub({}, { raw: "stub" }));
    const r2 = await makePlan({ objective: "research the market" });
    await runHandler("supervisor_run", r2.taskId);
    const h = (await query<{ task_id: number | null }>("SELECT task_id FROM supervisor_handoffs WHERE plan_id = $1 AND step_index = 0", [r2.planId]))[0];
    await setAgentFlag("research", true);
    await expectEscalation("kill switch: worker kill-switch escalates the delegation", () => runHandler("supervisor_delegate", h.task_id!), "not runnable");
    await setAgentFlag("research", false);
    await advanceSupervisorPlans();
    const plan = (await getPlan(r2.planId))!;
    check("kill switch: worker escalation closes the plan escalated", plan.status === "escalated");
  }

  /* ---------------- flag drill ---------------- */
  {
    await setFlag(false);
    const r = await makePlan({ objective: "research the market" }); // route-level 423 covered by M0 pattern; service still spawns
    await expectEscalation("flag drill: OFF refuses planning at the task level", () => runHandler("supervisor_run", r.taskId), "supervisor flag is OFF");
    await setFlag(true);
    // In-flight machinery keeps settling deterministically: the escalated
    // planning task still closes its plan via the monitor.
    await advanceSupervisorPlans();
    const plan = (await getPlan(r.planId))!;
    check("flag drill: in-flight plan still settles (escalated, not stuck)", plan.status === "escalated");
  }

  /* ---------------- deadline ceiling ---------------- */
  {
    const r = await makePlan({ objective: "research the market", deadline: new Date(Date.now() - 1000).toISOString() }).catch(() => null);
    // Route-level validation refuses past deadlines — craft the row directly.
    check("deadline: createPlan refuses past deadlines", r === null);
    const r2 = await makePlan({ objective: "research the market", budgetUsd: 1 });
    await query("UPDATE supervisor_plans SET deadline = now() - interval '1 minute' WHERE id = $1", [r2.planId]);
    const plan0 = (await getPlan(r2.planId))!;
    void plan0;
    // The planning leg runs fine (deadline is a monitor-side ceiling).
    setSupervisorLlm(supervisorStub({ steps: [{ agent: "research", objective: "gather", dependsOn: [] }] }));
    await runHandler("supervisor_run", r2.taskId);
    const plan = (await getPlan(r2.planId))!;
    check("deadline: overdue plan monitored to failed", plan.status === "failed" && plan.error_class === "deadline_exceeded", `${plan.status}/${plan.error_class}`);
  }

  /* ---------------- operator cancel ---------------- */
  {
    setSupervisorLlm(supervisorStub({
      steps: [
        { agent: "research", objective: "gather", dependsOn: [] },
        { agent: "marketing", objective: "draft promo", dependsOn: [0] },
      ],
    }));
    setBuiltinDispatchLlm(supervisorStub({}, { raw: "stub" }));
    const r = await makePlan({ objective: "research the market" });
    await runHandler("supervisor_run", r.taskId);
    const h0 = (await query<{ task_id: number | null }>("SELECT task_id FROM supervisor_handoffs WHERE plan_id = $1 AND step_index = 0", [r.planId]))[0];
    const cancelled = await cancelPlan(r.planId, "test-operator");
    check("cancel: open plan cancels with its inflight child", cancelled?.ok === true && cancelled.cancelled >= 1);
    const child = (await getTask(h0.task_id!))!;
    check("cancel: delegated child task cancelled", child.status === "cancelled");
    const plan = (await getPlan(r.planId))!;
    check("cancel: plan closed cancelled; wave 2 blocked", plan.status === "cancelled");
    const h1 = (await query<{ status: string }>("SELECT status FROM supervisor_handoffs WHERE plan_id = $1 AND step_index = 1", [r.planId]))[0];
    check("cancel: never-delegated step blocked", h1?.status === "blocked");
    const again = await cancelPlan(r.planId, "test-operator");
    check("cancel: idempotent (terminal plan is a noop)", again?.ok === false);
  }

  /* ---------------- §23 spend measurement + router demotion ---------------- */
  {
    const r = await makePlan({ objective: "research the market", budgetUsd: 5 });
    const spent0 = await planSpend(r.planId);
    check("§57 budget: planSpend starts at zero (stub writes no ledger)", spent0 === 0);
    // Router demotion: delegation to an agent the keyword router would never
    // pick for this topic — forced routing must win.
    check("demotion: router is a classifier (fallback flag semantics intact)", routeAgent({ topic: "post about our services", channel: "x" }).fallback === true);
    setSupervisorLlm(supervisorStub({ steps: [{ agent: "seo", objective: "run keyword gap analysis on the market", dependsOn: [] }] }));
    setBuiltinDispatchLlm(supervisorStub({}, { raw: `SEO gap output ${stamp}` }));
    const r2 = await makePlan({ objective: "research the market" });
    await runHandler("supervisor_run", r2.taskId);
    const h = (await query<{ task_id: number | null; to_agent: string }>("SELECT task_id, to_agent FROM supervisor_handoffs WHERE plan_id = $1 AND step_index = 0", [r2.planId]))[0];
    check("demotion: plan names a router-unreachable worker", h.to_agent === "seo");
    await runHandler("supervisor_delegate", h.task_id!);
    // route_reason lives on the dispatch result, not the ledger; the ledger
    // proves the forced agent + supervisor trigger (the router's default for
    // this topic would have been marketing).
    const runRow = await query<{ agent: string; trigger: string }>(
      "SELECT agent, trigger FROM agent_runs WHERE tenant_id = $1 ORDER BY id DESC LIMIT 1", [tenantA]
    );
    check("demotion: forced agent executed despite the classifier's default", runRow[0]?.agent === "seo" && runRow[0]?.trigger === "supervisor", JSON.stringify(runRow[0]));
  }

  console.log(failures === 0 ? "SUPERVISOR SUITE PASS" : `SUPERVISOR SUITE FAIL (${failures})`);
  return failures;
}

main()
  .catch((e) => {
    console.error("SUPERVISOR SUITE CRASH:", e);
    return 999;
  })
  .then(async (code) => {
    // Cleanup (best-effort; FK order: handoffs/plans cascade, tasks, drafts, runs, agents, bu, tenants)
    try {
      if (createdPlans.length) await query("DELETE FROM supervisor_plans WHERE id = ANY($1::bigint[])", [createdPlans]);
      if (createdTasks.length) await query("DELETE FROM tasks WHERE id = ANY($1::bigint[])", [createdTasks]);
      if (createdDrafts.length) await query("DELETE FROM drafts WHERE id = ANY($1::bigint[])", [createdDrafts]);
      await query("DELETE FROM agent_runs WHERE tenant_id = $1", [tenantA]);
      await query("DELETE FROM llm_requests WHERE business_unit_id = ANY($1::bigint[])", [createdBus]);
      if (createdBus.length) await query("DELETE FROM business_units WHERE id = ANY($1::bigint[])", [createdBus]);
      if (createdTenants.length) await query("DELETE FROM tenants WHERE id = ANY($1::bigint[])", [createdTenants]);
      await query("DELETE FROM notifications WHERE subject LIKE 'Supervisor plan%' OR event_id IN (SELECT id FROM events WHERE name LIKE 'supervisor.%')");
      await query("DELETE FROM events WHERE name LIKE 'supervisor.%'");
      await setFlag(true);
      await setAgentFlag("supervisor", false);
      await setAgentFlag("research", false);
    } catch (e) {
      console.error("cleanup failed:", e instanceof Error ? e.message : String(e));
    }
    // Exit ONLY after cleanup completed — process.exit inside main would
    // skip the finally continuation and leak open plans into the shared DB.
    process.exitCode = code > 0 ? 1 : 0;
  });
