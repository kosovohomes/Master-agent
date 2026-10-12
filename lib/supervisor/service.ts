/**
 * Supervisor service (Phase 15, roadmap P14) — plan lifecycle.
 *
 * createPlan      §57 input validation → supervisor_plans row + supervisor_run
 *                 task (the planning leg). Budget and permission CEILINGS are
 *                 enforced here and again at every later stage (fail-closed).
 * validatePlanOutput  the bounded-plan law: ≤6 steps, known workers, strictly
 *                 earlier dependencies (acyclic by construction), permission
 *                 envelope per step. The LLM planner's output never skips it.
 * planSpend       aggregate LLM spend across the plan's own task + every
 *                 delegated child (llm_requests is the source of truth).
 * settle/cancel   deterministic transitions (also used by the monitor).
 */
import { query } from "../db";
import { spawnTask, cancelTask, getTask } from "../tasks/queue";
import { writeAudit } from "../audit";
import {
  MAX_OBJECTIVE, MAX_PLAN_STEPS, MAX_STEP_OBJECTIVE,
  DELEGABLE_WORKERS, WORKER_PERMISSION, envelopeGrants, maxPlanBudgetUsd,
  type PlanOutput, type SupervisorPlanRow, type SupervisorHandoffRow,
} from "./types";

export class SupervisorPlanError extends Error {
  code: string;
  constructor(code: string, message?: string) {
    super(message ?? code);
    this.code = code;
    this.name = "SupervisorPlanError";
  }
}

export interface CreatePlanInput {
  objective: string;
  businessUnitId: number;
  constraints?: Record<string, unknown> | null;
  budgetUsd?: number | null;
  deadline?: string | null;
}

export interface PlanActor {
  userId: number | null;
  /** Snapshot of the requester's permission keys; `*` for ops-level trust. */
  permissions: string[];
  via: "session" | "legacy-bearer";
}

export interface CreatePlanResult {
  planId: number;
  taskId: number;
  budgetUsd: number;
}

export async function createPlan(input: CreatePlanInput, actor: PlanActor): Promise<CreatePlanResult> {
  const objective = String(input.objective ?? "").trim();
  if (objective.length === 0) throw new SupervisorPlanError("INVALID_OBJECTIVE", "objective is required");
  if (objective.length > MAX_OBJECTIVE) throw new SupervisorPlanError("INVALID_OBJECTIVE", `objective exceeds ${MAX_OBJECTIVE} chars`);

  if (!Number.isInteger(input.businessUnitId)) throw new SupervisorPlanError("INVALID_BU", "businessUnitId is required");
  const bu = await query<{ id: number; legacy_tenant_id: number | null }>(
    "SELECT id, legacy_tenant_id FROM business_units WHERE id = $1",
    [input.businessUnitId]
  );
  if (bu.length === 0) throw new SupervisorPlanError("BU_NOT_FOUND", `business unit ${input.businessUnitId} not found`);
  // Delegation targets legacy-tenant surfaces (drafts, agent_runs): a BU
  // without a provisioned 1:1 tenant identity cannot host delegated work.
  if (bu[0].legacy_tenant_id == null) throw new SupervisorPlanError("BU_NO_TENANT", "business unit has no tenant identity (onboarding provisioned BUs only)");

  // Budget ceiling: request may lower the ceiling, never raise it.
  const cap = maxPlanBudgetUsd();
  let budget = cap;
  if (input.budgetUsd != null) {
    const b = Number(input.budgetUsd);
    if (!Number.isFinite(b) || b < 0) throw new SupervisorPlanError("INVALID_BUDGET", "budgetUsd must be a non-negative number");
    if (b > cap) throw new SupervisorPlanError("BUDGET_CEILING", `requested budget $${b} exceeds the hard ceiling $${cap}`);
    budget = b;
  }

  let deadline: Date | null = null;
  if (input.deadline != null && input.deadline !== "") {
    const d = new Date(input.deadline);
    if (Number.isNaN(d.getTime())) throw new SupervisorPlanError("INVALID_DEADLINE", "deadline is not a valid date");
    if (d.getTime() <= Date.now()) throw new SupervisorPlanError("INVALID_DEADLINE", "deadline must be in the future");
    deadline = d;
  }

  const constraints =
    input.constraints && typeof input.constraints === "object" && !Array.isArray(input.constraints)
      ? input.constraints
      : {};

  const inserted = await query<{ id: number }>(
    `INSERT INTO supervisor_plans
       (business_unit_id, tenant_id, objective, constraints, status, budget_usd, deadline, permissions, created_by_user_id)
     VALUES ($1, $2, $3, $4::jsonb, 'planning', $5, $6, $7::jsonb, $8)
     RETURNING id`,
    [
      input.businessUnitId,
      bu[0].legacy_tenant_id,
      objective,
      JSON.stringify(constraints),
      budget.toFixed(4),
      deadline,
      JSON.stringify(actor.permissions),
      actor.userId,
    ]
  );
  const planId = inserted[0].id;

  // The planning leg itself is budget-capped by the plan ceiling (per-task
  // checkBudgets enforcement rides attribution.taskId).
  const spawn = await spawnTask({
    businessUnitId: input.businessUnitId,
    tenantId: bu[0].legacy_tenant_id,
    kind: "supervisor_run",
    payload: { planId },
    budgetUsd: budget,
    createdBy: actor.userId != null ? `user:${actor.userId}` : "ops:bearer",
  });
  await query("UPDATE supervisor_plans SET task_id = $2, updated_at = now() WHERE id = $1", [planId, spawn.taskId]);

  return { planId, taskId: spawn.taskId, budgetUsd: budget };
}

export type PlanValidation =
  | { ok: true; plan: PlanOutput }
  | { ok: false; reason: string };

/**
 * The bounded-plan law. Anything the planner returns must pass here before
 * it can delegate a single task — enum, count, dependency and permission
 * ceilings are all load-bearing.
 */
export function validatePlanOutput(raw: unknown, envelope: string[]): PlanValidation {
  if (raw == null || typeof raw !== "object" || Array.isArray(raw)) {
    return { ok: false, reason: "plan is not an object" };
  }
  const stepsRaw = (raw as { steps?: unknown }).steps;
  if (!Array.isArray(stepsRaw) || stepsRaw.length === 0) {
    return { ok: false, reason: "plan has no steps" };
  }
  if (stepsRaw.length > MAX_PLAN_STEPS) {
    return { ok: false, reason: `plan exceeds ${MAX_PLAN_STEPS} steps` };
  }
  const steps = [];
  for (let i = 0; i < stepsRaw.length; i++) {
    const s = stepsRaw[i] as Record<string, unknown>;
    const agent = typeof s.agent === "string" ? s.agent : "";
    if (!(DELEGABLE_WORKERS as readonly string[]).includes(agent)) {
      return { ok: false, reason: `step ${i}: agent "${agent}" is not a delegable worker` };
    }
    const objective = typeof s.objective === "string" ? s.objective.trim().slice(0, MAX_STEP_OBJECTIVE) : "";
    if (objective.length === 0) return { ok: false, reason: `step ${i}: empty objective` };
    const depsRaw = Array.isArray(s.dependsOn) ? s.dependsOn : [];
    const dependsOn: number[] = [];
    for (const d of depsRaw) {
      const n = Number(d);
      // Strictly-earlier rule → the graph can never contain a cycle.
      if (!Number.isInteger(n) || n < 0 || n >= i) {
        return { ok: false, reason: `step ${i}: dependency ${String(d)} does not reference an earlier step` };
      }
      if (!dependsOn.includes(n)) dependsOn.push(n);
    }
    const permission = WORKER_PERMISSION[agent];
    if (permission && !envelopeGrants(envelope, permission)) {
      return { ok: false, reason: `step ${i}: delegation to "${agent}" exceeds the requester's permission envelope (missing ${permission})` };
    }
    steps.push({ agent, objective, dependsOn });
  }
  const notes = typeof (raw as { notes?: unknown }).notes === "string"
    ? (raw as { notes: string }).notes.slice(0, 1000)
    : null;
  return { ok: true, plan: { steps, notes } };
}

/**
 * Aggregate LLM spend across the plan's own supervisor_run task and every
 * delegated child task. llm_requests is the source of truth (SEC-L9); a
 * plan whose spend reaches budget_usd may not delegate further, and every
 * child's own lifetime ceiling (tasks.budget_usd = remaining plan budget at
 * spawn) stops in-flight legs mid-plan.
 */
export async function planSpend(planId: number): Promise<number> {
  const rows = await query<{ spent: string }>(
    `SELECT COALESCE(SUM(l.cost_usd), 0)::text AS spent
     FROM llm_requests l
     WHERE l.task_id = ANY($1::bigint[])`,
    [
      (
        await query<{ task_id: number | null }>(
          `SELECT task_id FROM supervisor_handoffs WHERE plan_id = $1 AND task_id IS NOT NULL
           UNION SELECT task_id FROM supervisor_plans WHERE id = $1 AND task_id IS NOT NULL`,
          [planId]
        )
      ).map((r) => r.task_id as number),
    ]
  );
  return Number(rows[0]?.spent ?? 0);
}

export async function getPlan(planId: number): Promise<SupervisorPlanRow | null> {
  const rows = await query<SupervisorPlanRow>(
    `SELECT id, business_unit_id, tenant_id, objective, constraints, status, budget_usd,
            deadline, permissions, plan, generated_by, degraded, task_id, final_result,
            error, error_class, prompt_version_id, prompt_hash, created_by_user_id,
            metadata, created_at, updated_at
     FROM supervisor_plans WHERE id = $1`,
    [planId]
  );
  return rows[0] ?? null;
}

export interface PlanDetail {
  plan: SupervisorPlanRow;
  handoffs: SupervisorHandoffRow[];
  spendUsd: number;
}

export async function getPlanDetail(planId: number): Promise<PlanDetail | null> {
  const plan = await getPlan(planId);
  if (!plan) return null;
  const handoffs = await query<SupervisorHandoffRow>(
    "SELECT * FROM supervisor_handoffs WHERE plan_id = $1 ORDER BY step_index ASC",
    [planId]
  );
  const spendUsd = await planSpend(planId);
  return { plan, handoffs, spendUsd };
}

export async function listPlans(businessUnitId: number | null, limit = 50): Promise<SupervisorPlanRow[]> {
  const params: unknown[] = [];
  let where = "";
  if (businessUnitId != null) {
    params.push(businessUnitId);
    where = `WHERE business_unit_id = $${params.length}`;
  }
  params.push(Math.min(limit, 200));
  return query<SupervisorPlanRow>(
    `SELECT id, business_unit_id, tenant_id, objective, constraints, status, budget_usd,
            deadline, permissions, plan, generated_by, degraded, task_id, final_result,
            error, error_class, prompt_version_id, prompt_hash, created_by_user_id,
            metadata, created_at, updated_at
     FROM supervisor_plans ${where} ORDER BY id DESC LIMIT $${params.length}`,
    params
  );
}

/**
 * Operator cancellation: stop the planning task (if still queued/inflight),
 * cancel every non-terminal child, block the never-delegated steps, close
 * the plan. Idempotent: an already-terminal plan is a no-op summary.
 */
export async function cancelPlan(planId: number, actor: string): Promise<{ ok: boolean; cancelled: number } | null> {
  const plan = await getPlan(planId);
  if (!plan) return null;
  if (!["planning", "active"].includes(plan.status)) return { ok: false, cancelled: 0 };

  let cancelled = 0;
  const targets = new Set<number>();
  if (plan.task_id != null) targets.add(plan.task_id);
  const handoffs = await query<{ task_id: number | null }>(
    "SELECT task_id FROM supervisor_handoffs WHERE plan_id = $1 AND task_id IS NOT NULL AND status = 'delegated'",
    [planId]
  );
  for (const h of handoffs) targets.add(h.task_id as number);
  for (const taskId of targets) {
    const t = await getTask(taskId);
    if (!t || ["succeeded", "failed", "cancelled", "escalated"].includes(t.status)) continue;
    const res = await cancelTask(taskId, actor);
    if (res.outcome === "cancelled" || res.outcome === "cancel_requested") cancelled++;
  }
  await blockRemainingSteps(planId);
  // Transition guard: only the first closer writes the terminal status.
  const closed = await query<{ id: number }>(
    "UPDATE supervisor_plans SET status = 'cancelled', error = $2, updated_at = now() WHERE id = $1 AND status IN ('planning','active') RETURNING id",
    [planId, `cancelled by ${actor}`]
  );
  return { ok: closed.length > 0, cancelled };
}

/** Mark every not-yet-delegated step of a plan as blocked (terminal propagation). */
export async function blockRemainingSteps(planId: number): Promise<number> {
  const plan = await getPlan(planId);
  if (!plan?.plan) return 0;
  const existing = await query<{ step_index: number }>(
    "SELECT step_index FROM supervisor_handoffs WHERE plan_id = $1",
    [planId]
  );
  const have = new Set(existing.map((r) => r.step_index));
  let blocked = 0;
  for (let i = 0; i < plan.plan.steps.length; i++) {
    if (have.has(i)) continue;
    const step = plan.plan.steps[i];
    const ins = await query<{ id: number }>(
      `INSERT INTO supervisor_handoffs (plan_id, step_index, from_agent, to_agent, objective, status, detail)
       VALUES ($1, $2, 'supervisor', $3, $4, 'blocked', $5::jsonb)
       ON CONFLICT (plan_id, step_index) DO NOTHING
       RETURNING id`,
      [planId, i, step.agent, step.objective, JSON.stringify({ reason: "plan terminal — step never delegated" })]
    );
    if (ins.length > 0) blocked++;
  }
  return blocked;
}

/** Guarded terminal transition — returns true exactly once per plan. */
export async function closePlan(
  planId: number,
  status: "completed" | "failed" | "escalated",
  patch: { error?: string | null; errorClass?: string | null; finalResult?: Record<string, unknown> | null } = {}
): Promise<boolean> {
  const rows = await query<{ id: number }>(
    `UPDATE supervisor_plans
     SET status = $2,
         error = COALESCE($3, error),
         error_class = COALESCE($4, error_class),
         final_result = COALESCE($5::jsonb, final_result),
         updated_at = now()
     WHERE id = $1 AND status IN ('planning','active')
     RETURNING id`,
    [planId, status, patch.error ?? null, patch.errorClass ?? null, patch.finalResult ? JSON.stringify(patch.finalResult) : null]
  );
  return rows.length > 0;
}
