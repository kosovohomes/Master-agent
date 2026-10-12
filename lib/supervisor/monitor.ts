/**
 * Supervisor monitor (Phase 15, roadmap P14) — the deterministic machinery
 * behind "delegate → monitor → escalate". NO LLM inside: the monitor syncs
 * handoff states from the task queue, spawns the next dependency wave when
 * predecessors succeed, and closes plans that hit terminal states, budget
 * ceilings, deadlines or operator cancellation.
 *
 * Called from (a) the cron sweep route and (b) plan reads (self-healing
 * detail view) — the same settle-on-touch pattern the workflow engine and
 * the analytics digests use. Safe to run concurrently: every write is
 * idempotent (UNIQUE (plan_id, step_index) handoffs, spawn idempotency keys,
 * guarded terminal transitions).
 */
import { query } from "../db";
import { spawnTask } from "../tasks/queue";
import { emitEvent } from "../tasks/events";
import { planSpend, getPlan, blockRemainingSteps, closePlan } from "./service";
import type { SupervisorPlanRow, SupervisorHandoffRow } from "./types";

export interface AdvanceResult {
  plansConsidered: number;
  spawned: number;
  completed: number;
  escalated: number;
  failed: number;
}

const TASK_TO_HANDOFF: Record<string, "succeeded" | "failed" | "escalated" | "cancelled"> = {
  succeeded: "succeeded",
  failed: "failed",
  escalated: "escalated",
  cancelled: "cancelled",
};

/** Sync handoff statuses from their child tasks (delegated → terminal). */
async function syncHandoffs(planId: number): Promise<void> {
  await query(
    `UPDATE supervisor_handoffs h
     SET status = CASE t.status
           WHEN 'succeeded' THEN 'succeeded'
           WHEN 'failed' THEN 'failed'
           WHEN 'escalated' THEN 'escalated'
           WHEN 'cancelled' THEN 'cancelled'
           ELSE h.status END,
         settled_at = now()
     FROM tasks t
     WHERE h.task_id = t.id
       AND h.plan_id = $1
       AND h.status = 'delegated'
       AND t.status IN ('succeeded','failed','escalated','cancelled')`,
    [planId]
  );
}

/** Emit-once wrapper: the caller passes a transition that already happened. */
async function emitPlanEvent(
  plan: SupervisorPlanRow,
  name: "supervisor.plan_completed" | "supervisor.plan_escalated",
  payload: Record<string, unknown>
): Promise<void> {
  await emitEvent(plan.business_unit_id, name, { planId: plan.id, objective: plan.objective.slice(0, 200), ...payload }).catch(() => undefined);
}

/** Close + block + emit for an ACTIVE plan going terminal (fires once). */
async function terminatePlan(
  plan: SupervisorPlanRow,
  status: "completed" | "failed" | "escalated",
  patch: { error?: string | null; errorClass?: string | null; finalResult?: Record<string, unknown> | null }
): Promise<boolean> {
  if (status !== "completed") await blockRemainingSteps(plan.id);
  const closed = await closePlan(plan.id, status, patch);
  if (!closed) return false;
  if (status === "completed") {
    await emitPlanEvent(plan, "supervisor.plan_completed", {});
  } else {
    await emitPlanEvent(plan, "supervisor.plan_escalated", {
      status,
      reason: (patch.error ?? "terminal failure").slice(0, 300),
    });
  }
  return true;
}

/**
 * Advance a single plan. Returns the number of tasks spawned this pass.
 */
async function advancePlan(plan: SupervisorPlanRow): Promise<{ spawned: number; closed: number }> {
  // Orphan sweep: a planning plan whose supervisor_run task died without
  // activating (crashed, retried into terminal, cancelled) must not linger.
  if (plan.status === "planning") {
    if (plan.task_id != null) {
      const t = await query<{ status: string }>("SELECT status FROM tasks WHERE id = $1", [plan.task_id]);
      const ts = t[0]?.status;
      if (ts === "failed") {
        return { spawned: 0, closed: (await terminatePlan(plan, "failed", { error: "planning task failed", errorClass: "plan_task_failed" })) ? 1 : 0 };
      }
      if (ts === "escalated") {
        return { spawned: 0, closed: (await terminatePlan(plan, "escalated", { error: "planning task escalated", errorClass: "plan_task_escalated" })) ? 1 : 0 };
      }
      if (ts === "cancelled") {
        return { spawned: 0, closed: (await terminatePlan(plan, "failed", { error: "planning task cancelled", errorClass: "plan_task_cancelled" })) ? 1 : 0 };
      }
    }
    return { spawned: 0, closed: 0 }; // planning leg still queued/running
  }

  await syncHandoffs(plan.id);
  const handoffs = await query<SupervisorHandoffRow>(
    "SELECT * FROM supervisor_handoffs WHERE plan_id = $1 ORDER BY step_index ASC",
    [plan.id]
  );
  const byStep = new Map<number, SupervisorHandoffRow>();
  for (const h of handoffs) byStep.set(h.step_index, h);
  const steps = plan.plan?.steps ?? [];
  if (steps.length === 0) {
    return { spawned: 0, closed: (await terminatePlan(plan, "failed", { error: "plan has no steps", errorClass: "empty_plan" })) ? 1 : 0 };
  }

  // 1) Terminal child propagation: any failed/escalated handoff blocks the
  //    rest and escalates the plan (a human decides what happens next).
  const terminalBad = handoffs.find((h) => h.status === "failed" || h.status === "escalated");
  if (terminalBad) {
    return {
      spawned: 0,
      closed: (await terminatePlan(plan, "escalated", {
        error: `step ${terminalBad.step_index} (${terminalBad.to_agent}) ${terminalBad.status}`,
        errorClass: terminalBad.status === "escalated" ? "step_escalated" : "step_failed",
      })) ? 1 : 0,
    };
  }

  // 2) Deadline ceiling (§57 input honoured): an overdue active plan fails
  //    closed instead of delegating further work past its promise.
  if (plan.deadline != null && plan.deadline.getTime() <= Date.now()) {
    return {
      spawned: 0,
      closed: (await terminatePlan(plan, "failed", { error: "deadline exceeded", errorClass: "deadline_exceeded" })) ? 1 : 0,
    };
  }

  // 3) Completion: every step delegated AND succeeded.
  if (steps.every((_, i) => byStep.get(i)?.status === "succeeded")) {
    const finalResult = {
      steps: steps.map((s, i) => ({
        agent: s.agent,
        objective: s.objective,
        status: byStep.get(i)?.status ?? "delegated",
        taskId: byStep.get(i)?.task_id ?? null,
      })),
      notes: plan.plan?.notes ?? null,
    };
    return {
      spawned: 0,
      closed: (await terminatePlan(plan, "completed", { finalResult })) ? 1 : 0,
    };
  }

  // 4) Budget ceiling on further delegation (§57 hard budget): spend is
  //    measured across the planning leg + every child (llm_requests truth).
  const budget = plan.budget_usd != null ? Number(plan.budget_usd) : null;
  let remaining: number | null = null;
  if (budget != null) {
    const spent = await planSpend(plan.id);
    remaining = Math.max(0, budget - spent);
  }

  // 5) Spawn the next dependency wave: steps with no handoff whose
  //    dependencies all succeeded.
  let spawned = 0;
  for (let i = 0; i < steps.length; i++) {
    if (byStep.has(i)) continue;
    const step = steps[i];
    const depsOk = step.dependsOn.every((d) => byStep.get(d)?.status === "succeeded");
    if (!depsOk) continue;
    if (remaining != null && remaining <= 0) {
      await blockRemainingSteps(plan.id);
      const closed = await terminatePlan(plan, "escalated", {
        error: "plan budget exhausted before all steps were delegated",
        errorClass: "budget_exhausted",
      });
      return { spawned, closed: closed ? 1 : 0 };
    }
    const childBudget = remaining != null ? Number(remaining.toFixed(4)) : null;
    const spawn = await spawnTask({
      businessUnitId: plan.business_unit_id,
      tenantId: plan.tenant_id,
      kind: "supervisor_delegate",
      payload: {
        planId: plan.id,
        stepIndex: i,
        agent: step.agent,
        objective: step.objective,
        allowFallback: false,
      },
      // Per-child lifetime ceiling = the plan's remaining budget: the child's
      // LLM legs attribute to this task id, so checkBudgets stops the child
      // exactly where the plan's envelope ends.
      budgetUsd: childBudget,
      idempotencyKey: `supervisor-plan:${plan.id}:step:${i}`,
      createdBy: "supervisor",
    });
    const ins = await query<{ id: number }>(
      `INSERT INTO supervisor_handoffs (plan_id, task_id, step_index, from_agent, to_agent, objective, status)
       VALUES ($1, $2, $3, 'supervisor', $4, $5, 'delegated')
       ON CONFLICT (plan_id, step_index) DO NOTHING
       RETURNING id`,
      [plan.id, spawn.taskId, i, step.agent, step.objective]
    );
    if (ins.length > 0) {
      spawned++;
      // Sibling children in the same wave share the same remaining ceiling
      // (bounded overlap: the AGGREGATE is re-measured via planSpend before
      // every further wave, and each child's own lifetime ceiling stops its
      // legs exactly where the plan envelope ends).
    }
  }
  return { spawned, closed: 0 };
}

/** Advance every open plan (monitor pass). Deterministic; concurrency-safe. */
export async function advanceSupervisorPlans(limit = 20): Promise<AdvanceResult> {
  const result: AdvanceResult = { plansConsidered: 0, spawned: 0, completed: 0, escalated: 0, failed: 0 };
  const open = await query<SupervisorPlanRow>(
    `SELECT id, business_unit_id, tenant_id, objective, constraints, status, budget_usd,
            deadline, permissions, plan, generated_by, degraded, task_id, final_result,
            error, error_class, prompt_version_id, prompt_hash, created_by_user_id,
            metadata, created_at, updated_at
     FROM supervisor_plans WHERE status IN ('planning','active') ORDER BY id ASC LIMIT $1`,
    [Math.min(limit, 100)]
  );
  for (const plan of open) {
    result.plansConsidered++;
    try {
      const r = await advancePlan(plan);
      result.spawned += r.spawned;
      if (r.closed > 0) {
        const after = await getPlan(plan.id);
        if (after?.status === "completed") result.completed++;
        else if (after?.status === "escalated") result.escalated++;
        else if (after?.status === "failed") result.failed++;
      }
    } catch {
      // A monitor failure on one plan must never stall the others; the next
      // pass retries (all writes idempotent).
    }
  }
  return result;
}

/**
 * Advance ONE plan (used by the planning leg right after activation and by
 * the detail read path — settle-on-touch). Returns spawn/closure counts.
 */
export async function advanceSupervisorPlan(planId: number): Promise<{ spawned: number; closed: number }> {
  const plan = await getPlan(planId);
  if (!plan) return { spawned: 0, closed: 0 };
  if (plan.status !== "planning" && plan.status !== "active") return { spawned: 0, closed: 0 };
  try {
    return await advancePlan(plan);
  } catch {
    // The next monitor pass retries (all writes idempotent).
    return { spawned: 0, closed: 0 };
  }
}

/**
 * Advance one plan for the read path. Returns the fresh plan row.
 */
export async function settleSupervisorPlan(planId: number): Promise<SupervisorPlanRow | null> {
  const plan = await getPlan(planId);
  if (!plan) return null;
  if (plan.status === "planning" || plan.status === "active") {
    await advanceSupervisorPlan(planId);
    return getPlan(planId);
  }
  return plan;
}
