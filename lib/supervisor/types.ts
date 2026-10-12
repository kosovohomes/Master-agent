/**
 * Supervisor (Phase 15, roadmap P14 — §57 Supervisor Contract, §23 Agent
 * Handoff). The supervisor inserts itself ABOVE task creation: a stated goal
 * becomes a PLAN (task graph), the graph is delegated as durable tasks,
 * progress is monitored deterministically, and failures escalate to a human.
 *
 * The keyword router is PERMANENTLY demoted to a classifier step (C-16): it
 * survives only as (a) the deterministic planning FLOOR when the LLM planner
 * is unavailable and (b) the legacy manual-run classifier. It never
 * orchestrates.
 *
 * §57 contract mapping:
 *   input  → objective, business_unit, constraints, budget, deadline,
 *            permissions (all columns on supervisor_plans)
 *   output → plan, tasks (delegated children), assigned_agents (handoffs),
 *            required_approvals (structural: worker agents produce drafts
 *            and analyses that park pending human approval — no supervisor
 *            path may publish, schedule or send), status, final_result
 */

export type SupervisorPlanStatus =
  | "planning"
  | "active"
  | "completed"
  | "failed"
  | "escalated"
  | "cancelled";

export type HandoffStatus =
  | "delegated"
  | "succeeded"
  | "failed"
  | "escalated"
  | "cancelled"
  | "blocked";

export interface PlanStep {
  agent: string;
  objective: string;
  /** Indexes of EARLIER steps that must succeed first (strictly < own index → acyclic by construction). */
  dependsOn: number[];
}

export interface PlanOutput {
  steps: PlanStep[];
  notes?: string | null;
}

/* ---------------- bounds (hard ceilings) ---------------- */

export const MAX_PLAN_STEPS = 6;
export const MAX_OBJECTIVE = 500;
export const MAX_STEP_OBJECTIVE = 300;

/**
 * Hard system ceiling on a plan's LLM budget. A plan may request less, never
 * more; an omitted budget defaults to the ceiling. Override with
 * SUPERVISOR_MAX_PLAN_BUDGET_USD (still a ceiling, not an invitation).
 */
export function maxPlanBudgetUsd(): number {
  const raw = Number(process.env.SUPERVISOR_MAX_PLAN_BUDGET_USD);
  return Number.isFinite(raw) && raw > 0 ? raw : 5;
}

/* ---------------- worker catalog + permission envelope ---------------- */

/**
 * Worker agents the planner may delegate to (active workforce slugs as of
 * P14; customer_service is excluded — the chat path is public-surface, not a
 * delegable worker). The list mirrors the registry; the planner prompt
 * (migration 051) mirrors this list. A plan naming any other agent is
 * rejected at validation.
 */
export const DELEGABLE_WORKERS: readonly string[] = [
  "research", "intelligence", "legal_intelligence", "competitor",
  "content_strategy", "content", "fact_check",
  "seo", "social_media", "marketing",
  "lead", "sales", "customer_inquiry", "customer_support",
  "analytics", "strategy", "reporting",
] as const;

/**
 * Permission ceiling per worker: a plan may only delegate work its requester
 * could have triggered directly. The envelope is snapshotted onto the plan
 * at creation time (`supervisor_plans.permissions`), so later role changes
 * never retroactively widen an in-flight plan. `*` = ops-level trust
 * (legacy bearer admission carries no user; it is owner-class by definition).
 */
export const WORKER_PERMISSION: Readonly<Record<string, string>> = {
  research: "research.manage",
  intelligence: "research.manage",
  legal_intelligence: "research.manage",
  competitor: "research.manage",
  content_strategy: "content.manage",
  content: "content.manage",
  fact_check: "content.manage",
  seo: "seo.manage",
  social_media: "social.manage",
  marketing: "marketing.manage",
  lead: "sales.manage",
  sales: "sales.manage",
  customer_inquiry: "sales.manage",
  customer_support: "sales.manage",
  analytics: "analytics.manage",
  strategy: "analytics.manage",
  reporting: "analytics.manage",
};

export function envelopeGrants(envelope: string[], permission: string): boolean {
  return envelope.includes("*") || envelope.includes(permission);
}

/* ---------------- planner output schema (completeJSON) ---------------- */

/**
 * Structural schema for the planner's JSON. Length/count clamps and the
 * dependency/permission laws are enforced in code (validatePlanOutput) —
 * the dependency-free validator has no array-length support and the laws
 * are semantic, not structural.
 */
export const PLAN_SCHEMA: Record<string, unknown> = {
  type: "object",
  required: ["steps"],
  properties: {
    steps: {
      type: "array",
      items: {
        type: "object",
        required: ["agent", "objective"],
        properties: {
          agent: { type: "string", enum: [...DELEGABLE_WORKERS] },
          objective: { type: "string" },
          dependsOn: { type: "array", items: { type: "number" } },
        },
      },
    },
    notes: { type: ["string", "null"] },
  },
};

/* ---------------- rows ---------------- */

export interface SupervisorPlanRow {
  id: number;
  business_unit_id: number;
  tenant_id: number | null;
  objective: string;
  constraints: Record<string, unknown>;
  status: SupervisorPlanStatus;
  budget_usd: string | null;
  deadline: Date | null;
  permissions: string[];
  plan: PlanOutput | null;
  generated_by: "deterministic" | "llm" | null;
  degraded: boolean;
  task_id: number | null;
  final_result: Record<string, unknown> | null;
  error: string | null;
  error_class: string | null;
  prompt_version_id: number | null;
  prompt_hash: string | null;
  created_by_user_id: number | null;
  metadata: Record<string, unknown>;
  created_at: Date;
  updated_at: Date;
}

export interface SupervisorHandoffRow {
  id: number;
  plan_id: number;
  task_id: number | null;
  step_index: number;
  from_agent: string;
  to_agent: string;
  objective: string;
  status: HandoffStatus;
  detail: Record<string, unknown> | null;
  created_at: Date;
  settled_at: Date | null;
}
