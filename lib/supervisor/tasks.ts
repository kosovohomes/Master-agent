/**
 * Supervisor task handlers (Phase 15, roadmap P14).
 *
 * supervisor_run — the PLANNING leg (§57 input → §57 output). Loads the plan,
 *    generates the task graph via the bounded LLM planner (structured output,
 *    gateway-attributed purpose="supervisor"), validates it against the
 *    bounded-plan law (count/enum/dependency/permission ceilings), activates
 *    the plan and spawns the first delegation wave. Degraded mode: any
 *    planner failure falls back to the deterministic floor — the demoted
 *    router acting as a CLASSIFIER for a single-step plan; a classifier
 *    FALLBACK objective escalates instead of silently doing the wrong work
 *    (the same honesty rule the agent_dispatch executor enforces, C-16).
 *
 * supervisor_delegate — one DELEGATED step. Gates (plan active, budget
 *    ceiling re-measured, agent runnable), then executes the PLANNED agent
 *    via dispatch({forceAgent}) — the keyword router is never consulted for
 *    delegation (it is a classifier, not an orchestrator). Registry layers
 *    (status × per-BU × kill-switch) still apply to every child.
 *
 * Every delegation is logged as a supervisor_handoff row (§23 "every handoff
 * must be logged") by the monitor's wave spawner; this handler only executes
 * and settles.
 */
import type { LLMClient } from "../ai/types";
import type { GatewayClient } from "../ai/gateway";
import { completeJSON } from "../ai/structured";
import { query } from "../db";
import { dispatch, getTenantConfig } from "../agents/dispatch";
import { routeAgent } from "../agents/core";
import { getAgentBySlug, currentVersion, promptHash, checkRunnable } from "../agents/registry";
import { TaskEscalatedError } from "../tasks/executors";
import { registerTaskHandler } from "../tasks/handlers";
import type { TaskHandler } from "../tasks/types";
import { isFlagEnabled } from "../settings";
import { getPlan, planSpend, validatePlanOutput } from "./service";
import { advanceSupervisorPlan } from "./monitor";
import { PLAN_SCHEMA, type PlanOutput, type SupervisorPlanRow } from "./types";

function plannerUserPrompt(plan: SupervisorPlanRow): string {
  const constraints = Object.keys(plan.constraints ?? {}).length
    ? `\nConstraints: ${JSON.stringify(plan.constraints).slice(0, 1000)}`
    : "";
  const budget = plan.budget_usd != null ? `\nBudget ceiling: $${plan.budget_usd}` : "";
  const deadline = plan.deadline ? `\nDeadline: ${plan.deadline.toISOString()}` : "";
  return `Stated objective: ${plan.objective}${constraints}${budget}${deadline}\n\nDecompose this into the smallest correct task graph. Remember: worker agents produce drafts, analyses and recommendations — nothing that publishes or sends directly; humans approve those artifacts.`;
}

/** Only used if the registry version row is missing (should not happen post-migration-051). */
const SUPERVISOR_PLANNER_FALLBACK_PROMPT =
  "You are the Supervisor Agent. Decompose the stated objective into at most 6 worker steps. Output strict JSON per the schema.";

async function attributedLlm(llm: LLMClient, plan: SupervisorPlanRow, taskId: number): Promise<LLMClient> {
  const gateway = llm as LLMClient & Partial<GatewayClient>;
  if (typeof gateway.withAttribution !== "function") return llm;
  const agent = await getAgentBySlug("supervisor");
  return gateway.withAttribution({
    businessUnitId: plan.business_unit_id,
    agentId: agent?.id ?? null,
    agentSlug: "supervisor",
    taskId,
    purpose: "supervisor",
  });
}

interface LoadedPlan { plan: SupervisorPlanRow; alreadyActivated: boolean }

export function makeSupervisorRunHandler(deps: { llm: LLMClient }): TaskHandler {
  return async ({ task, step }) => {
    const planId = Number((task.payload as { planId?: number }).planId);

    const loaded = (await step("load", async () => {
      if (!Number.isInteger(planId)) throw new Error("supervisor_run: missing planId");
      const row = await getPlan(planId);
      if (!row) throw new Error(`supervisor_run: plan ${planId} not found`);
      // Idempotent re-run (retries after partial completion): the plan is
      // already activated → nothing left to do here.
      if (row.status !== "planning") return { plan: row, alreadyActivated: true };
      // The supervisor itself is registry-governed: kill-switch / disabled /
      // BU-disabled refuses planning (fail-closed, surfaces as escalation).
      const runnable = await checkRunnable("supervisor", row.business_unit_id);
      if (!runnable.ok) throw new TaskEscalatedError(`supervisor not runnable: ${runnable.code}`);
      // Flag drill (the `supervisor` flag gates NEW planning; the route
      // already refuses 423 — this catches tasks spawned just before the
      // flag flipped, and the in-flight monitor keeps settling regardless).
      if (!(await isFlagEnabled("supervisor", false))) {
        throw new TaskEscalatedError("supervisor flag is OFF — planning refused");
      }
      return { plan: row, alreadyActivated: false };
    })) as unknown as LoadedPlan;

    if (loaded.alreadyActivated) {
      return { planId, alreadyActivated: true, status: loaded.plan.status };
    }

    const generated = (await step("plan", async () => {
      const row = loaded.plan;
      const envelope = Array.isArray(row.permissions) ? row.permissions : [];
      // The registry version IS the planner prompt (migration 051): the
      // planning call carries it as the system message so prompt_version_id /
      // prompt_hash attribute the actual instructions that planned the graph.
      const supervisorAgent = await getAgentBySlug("supervisor");
      const version = supervisorAgent ? await currentVersion(supervisorAgent.id) : null;
      const plannerSystem = version?.systemPrompt ?? SUPERVISOR_PLANNER_FALLBACK_PROMPT;
      let planOut: PlanOutput | null = null;
      let generatedBy: "llm" | "deterministic" = "deterministic";
      let degraded = true;
      let plannerError: string | null = null;

      try {
        const llm = await attributedLlm(deps.llm, row, task.id);
        const res = await completeJSON<unknown>(
          llm,
          [
            { role: "system", content: plannerSystem },
            { role: "user", content: plannerUserPrompt(row) },
          ],
          PLAN_SCHEMA,
          { temperature: 0 }
        );
        const check = validatePlanOutput(res.value, envelope);
        if (check.ok) {
          planOut = check.plan;
          generatedBy = "llm";
          degraded = false;
        } else {
          plannerError = `plan validation: ${check.reason}`;
        }
      } catch (e) {
        plannerError = e instanceof Error ? e.message : String(e);
      }

      if (!planOut) {
        // Deterministic floor: the demoted router classifies the objective
        // into ONE worker step. A FALLBACK objective escalates — no silent
        // wrong work (C-16), and a floor that violates the permission
        // envelope escalates too (the ceiling is load-bearing).
        const route = routeAgent({ topic: row.objective, channel: "" });
        if (route.fallback) {
          throw new TaskEscalatedError(
            `planning failed (${plannerError ?? "unavailable"}) and the objective matched no worker agent — human routing required`
          );
        }
        const floor = [{ agent: route.agent, objective: row.objective.slice(0, 300), dependsOn: [] as number[] }];
        const check = validatePlanOutput({ steps: floor }, envelope);
        if (!check.ok) throw new TaskEscalatedError(`deterministic floor rejected: ${check.reason}`);
        planOut = check.plan;
        generatedBy = "deterministic";
        degraded = true;
      }

      const activated = await query(
        `UPDATE supervisor_plans
         SET plan = $2::jsonb, generated_by = $3, degraded = $4,
             prompt_version_id = $5, prompt_hash = $6,
             status = 'active', updated_at = now()
         WHERE id = $1 AND status = 'planning'
         RETURNING id`,
        [row.id, JSON.stringify(planOut), generatedBy, degraded, version?.id ?? null, promptHash(version?.systemPrompt ?? SUPERVISOR_PLANNER_FALLBACK_PROMPT)]
      );
      if (activated.length === 0) throw new Error(`supervisor_run: plan ${row.id} was activated concurrently`);
      return { steps: planOut.steps.length, generatedBy, degraded };
    })) as unknown as { steps: number; generatedBy: string; degraded: boolean };

    const delegated = (await step("delegate", async () => {
      const r = await advanceSupervisorPlan(planId);
      return { spawned: r.spawned };
    })) as unknown as { spawned: number };

    return { planId, steps: generated.steps, generatedBy: generated.generatedBy, degraded: generated.degraded, spawned: delegated.spawned };
  };
}

export function makeSupervisorDelegateHandler(deps: { llm: LLMClient }): TaskHandler {
  return async ({ task, step }) => {
    const payload = task.payload as {
      planId?: number; stepIndex?: number; agent?: string; objective?: string;
    };
    const planId = Number(payload.planId);
    const stepIndex = Number(payload.stepIndex);
    const agent = String(payload.agent ?? "");

    await step("gate", async () => {
      if (!Number.isInteger(planId) || !Number.isInteger(stepIndex) || agent.length === 0) {
        throw new Error("supervisor_delegate: malformed payload");
      }
      const plan = await getPlan(planId);
      if (!plan) throw new Error(`supervisor_delegate: plan ${planId} not found`);
      // A plan that went terminal between spawn and claim must not execute
      // (operator cancel, sibling failure, budget close).
      if (plan.status !== "active") {
        throw new TaskEscalatedError(`plan ${planId} is ${plan.status} — delegation refused`);
      }
      // Budget ceiling re-measured at execution time (§57 hard budget):
      // between spawn and claim an earlier sibling may have consumed the
      // envelope; this child then escalates instead of spending through it.
      if (plan.budget_usd != null) {
        const spent = await planSpend(planId);
        if (spent >= Number(plan.budget_usd)) {
          throw new TaskEscalatedError(`plan ${planId} budget exhausted ($${spent} >= $${plan.budget_usd})`);
        }
      }
      const runnable = await checkRunnable(agent, plan.business_unit_id);
      if (!runnable.ok) throw new TaskEscalatedError(`worker "${agent}" not runnable: ${runnable.code}`);
      return { agent, businessUnitId: plan.business_unit_id };
    });

    const result = (await step("execute", async () => {
      const plan = await getPlan(planId);
      if (!plan) throw new Error(`supervisor_delegate: plan ${planId} vanished`);
      if (plan.tenant_id == null) {
        throw new TaskEscalatedError("plan business unit has no tenant identity — cannot delegate");
      }
      const out = await dispatch(
        { llm: deps.llm, getConfig: getTenantConfig, attribution: { taskId: task.id } },
        {
          tenantId: plan.tenant_id,
          topic: String(payload.objective ?? ""),
          channel: "",
          context: plan.constraints && Object.keys(plan.constraints).length ? JSON.stringify(plan.constraints) : undefined,
        },
        // THE DEMOTION: delegation runs the PLANNED agent. The keyword
        // router is not consulted — it is a classifier (C-16), and the
        // supervisor's plan is the orchestration authority.
        { forceAgent: agent, trigger: "supervisor" }
      );
      return { runId: out.runId, agent: out.agent, draftId: out.draftId, routeReason: out.routeReason };
    })) as unknown as { runId: number; agent: string; draftId: number | null; routeReason: string };

    await step("record", async () => {
      if (result.runId != null) {
        await query("UPDATE tasks SET run_id = $2 WHERE id = $1", [task.id, result.runId]);
      }
      return { planId, stepIndex };
    });

    return { planId, stepIndex, agent: result.agent, runId: result.runId, draftId: result.draftId };
  };
}

let registered = false;

/** Production registration (called from lib/tasks/executors registerBuiltins). */
export function registerSupervisorHandlers(llm: LLMClient): void {
  registered = true;
  registerTaskHandler("supervisor_run", makeSupervisorRunHandler({ llm }));
  registerTaskHandler("supervisor_delegate", makeSupervisorDelegateHandler({ llm }));
}

/** Test seam: swap the LLM client and re-register both handlers. */
export function setSupervisorLlm(client: LLMClient): void {
  if (!registered) return; // not yet registered by the engine
  registerTaskHandler("supervisor_run", makeSupervisorRunHandler({ llm: client }));
  registerTaskHandler("supervisor_delegate", makeSupervisorDelegateHandler({ llm: client }));
}
