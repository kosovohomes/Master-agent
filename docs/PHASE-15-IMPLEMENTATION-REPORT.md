# PHASE 15 — IMPLEMENTATION REPORT
## Supervisor (roadmap P14) — bounded planner/delegator above task creation

**Date:** 2026-10-13 · **Scope:** PHASE-0.5-Final-Architecture-Reconciliation.md roadmap P14 + Master Arch §57 (Supervisor Contract), §23 (Agent Handoff), audit row 21, contradiction resolution C-5.

---

## 1. Executive summary

The Supervisor inserts itself ABOVE task creation: a stated goal becomes a plan (task graph, ≤6 steps, worker agents only), the graph is delegated as durable tasks, progress is monitored deterministically, and failures or ceilings escalate to a human (§57: plan → task graphs → delegate → monitor → escalate). Every handoff is logged (§23). The keyword router is now PERMANENTLY demoted to a classifier: it survives only as the degraded planning floor and the legacy manual-run classifier — it never orchestrates. Hard budget ceilings ($5/plan system cap, enforced per-task AND in aggregate) and a permission envelope (snapshot of the requester's permission keys, checked per step) bound everything the supervisor may do. Approval-respecting by construction: delegated work produces drafts and analyses that park pending human approval — no supervisor path can publish, schedule, or send (the P15 line on autonomous HIGH-risk actions is untouched). C-5 completes: the LLM planner arrives, joined to the deterministic subset (scheduler + classifier + escalation) that served as the MVP supervisor.

Acceptance criterion from the roadmap — "stated goal → delegated, logged, approval-respecting tasks" — is demonstrated locally (48-check suite) and LIVE on production (a real goal, planned via the degraded floor under the provider outage, delegated, handoff-logged, escalated on child failure, paged ops, fully audited).

## 2. Data model (migrations 050–052, ledger 53)

- **050 `supervisor_workforce`** — `supervisor_plans` (§57 inputs as columns: objective, business_unit_id, tenant_id, constraints, budget_usd, deadline, permissions envelope snapshot; §57 outputs: plan JSONB graph, status FSM planning→active→completed|failed|escalated|cancelled, final_result, error_class; provenance: generated_by deterministic|llm, degraded, prompt_version_id, prompt_hash) + `supervisor_handoffs` (§23: one row per delegation — from_agent, to_agent, step_index, objective, status, child task ref; UNIQUE (plan_id, step_index) makes delegation idempotent).
- **051 `supervisor_agent`** — the `supervisor` placeholder row (disabled since registry seed, migration 012, agent_kind='supervisor') is ACTIVATED (M_038/M_044 pattern): status flip + NEW version row carrying the bounded planner prompt (17 workers enumerated, dependency law, no side-effectful actions, strict-JSON output schema `supervisor_plan_v1`).
- **052 `supervisor_flag_permissions`** — `supervisor` flag (kill switch for NEW planning; in-flight plans keep settling deterministically) + `supervisor.manage` permission (owner/administrator).

## 3. Mechanics (`lib/supervisor/`)

- **`service.ts`** — createPlan (§57 input validation: objective bounds, BU with provisioned tenant identity, budget ≤ hard ceiling `SUPERVISOR_MAX_PLAN_BUDGET_USD` default $5, future deadline; envelope snapshot; spawns the budget-capped `supervisor_run` task); validatePlanOutput (the bounded-plan law: ≤6 steps, worker enum, strictly-earlier dependencies → acyclic by construction, permission envelope per step); planSpend (aggregate LLM spend across the plan task + every child from `llm_requests`); cancelPlan (idempotent operator stop).
- **`tasks.ts`** — `supervisor_run` (planning leg: registry-governed via checkRunnable, flag-drilled, gateway-attributed purpose="supervisor" with the registry version prompt; completeJSON structured plan → the bounded-plan law; ANY planner failure degrades to the deterministic floor — the classifier as a single-step plan; a classifier FALLBACK objective or an envelope-violating floor ESCALATES instead of silently doing the wrong work, C-16) and `supervisor_delegate` (gate: plan active + budget re-measured + worker runnable → executes the PLANNED agent via `dispatch({forceAgent, trigger:"supervisor"})` — the router is never consulted for delegation; registry layers still apply per child).
- **`monitor.ts`** — the deterministic machinery behind delegate→monitor→escalate: syncs handoff statuses from the queue, propagates terminal child failures (dependents blocked, plan escalated, ops paged once), enforces deadline and budget ceilings (budget exhaustion blocks remaining steps + escalates), spawns the next dependency wave with per-child ceilings = remaining plan budget, closes completed plans with §57 final_result. Runs from the cron sweep route and settle-on-touch plan reads; every write is idempotent/concurrency-safe.
- **Support edits** — `dispatch()` gains `opts.forceAgent`/`opts.trigger` (additive; router bypass with full registry governance, run records carry trigger="supervisor"); `spawnTask` gains `budgetUsd` (per-task lifetime ceiling, SEC-L9 enforcement unchanged); two events (`supervisor.plan_completed` silent, `supervisor.plan_escalated` pages ops); sweep route runs the monitor pass + in-request tick for freshly spawned children.

## 4. Surfaces

- **API** — `POST/GET /api/admin/supervisor/plans` (supervisor.manage, 5/min rate limit, flag drill 423, envelope snapshot, audited), `GET /api/admin/supervisor/plans/[id]` (settle-on-touch detail: plan + §23 handoffs + child tasks + measured spend; scope-checked 404s), `POST /api/admin/supervisor/plans/[id]/cancel` (audited operator stop).
- **UI** — `/supervisor` screen (goal form with budget/deadline, plan list with status/planner/budget, plan detail with task graph, §23 handoff log table, delegated-task table, spend-vs-ceiling, degraded badge, cancel) + nav entry gated `supervisor.manage | audit.read`.

## 5. Verification (all real; local unless noted)

- **Local battery: ALL 57 SUITES PASS — 1624 checks** (pristine local PG 17.11 + pgvector 0.8.0, ledger 53) + `tsc --noEmit` clean + `next build` clean (77/77 routes incl. supervisor surfaces).
- **New suite `tests/supervisor-tests.ts` (48 checks)**: §57 input validation (6 refusals incl. budget ceiling + tenant identity), the bounded-plan law (9 checks: over-ceiling step count, unknown worker, customer_service exclusion, forward/self dependencies, envelope violation + wildcard), planner happy path (llm graph + prompt attribution + wave-1-only delegation), §23 handoff logging, wave advancement to completed with final_result, approval-respecting (both delegated drafts land PENDING), deterministic floor on planner outage, FALLBACK objective escalation (no silent wrong work) with ops notification, permission ceiling (planner + floor both rejected; legal floor survives over-reaching plan), budget ceiling ($0 plan blocks at spawn; drained envelope refuses at the child gate), kill switches (supervisor + worker), flag drill (OFF refuses new planning; in-flight still settles), deadline ceiling, operator cancel (idempotent, steps blocked), router demotion (delegation reaches a router-unreachable worker — seo — with trigger=supervisor).
- **Test-infrastructure repairs surfaced by real testing:** task-queue cancel/recovery probes were claim-order-racy (tied `next_run_at`) — priority-pinned; supervisor suite simulates engine terminal writes (`completeTask`/`markEscalated`) the way `engine.runOne` does, and exits only after cleanup (a `process.exit` inside main previously leaked open plans that starved the monitor's batch).
- **CI: run #57 SUCCESS on 0c8487b** (ephemeral pg: migrations + 57 suites + tsc + build).
- **Production:** migrations 050–052 applied (ledger 53, legacy 11/11); fail-closed sweep PASS (all four supervisor API endpoints 401 unauthenticated; /supervisor 307 → login). **Live acceptance PASS (0 failures)** with the owner session: goal → plan #5 activated via the degraded deterministic floor (real provider outage — the degradation path proven for real), §23 handoff logged, delegated child failed on the provider outage → plan escalated → ops paged; `supervisor.plan` audit rows present; sweep monitor pass settled all in-flight plans (`plansConsidered:3, escalated:3`).

## 6. Rollback

`supervisor` flag OFF → new goal creation refuses (423) at the route and the task level; in-flight plans settle deterministically (machinery, not LLM). `disable_agent:supervisor` kill switch escalates planning at the registry layer. Per-agent kill switches govern every delegated child. Migrations are additive (new tables only; no existing table altered except additive `spawnTask` parameter use); schema rollback = drop the two new tables.

## 7. Known limitations & outstanding

- Delegation executes steps in dependency waves; the monitor advances on cron sweeps / settle-on-touch reads — sub-cadence latency is bounded by the sweep schedule (documented §63 cadence knob applies).
- Concurrent sibling children share the remaining plan ceiling (bounded overlap; the aggregate is re-measured before every further wave) — documented in `monitor.ts`.
- Envelope map mirrors the current 17-worker workforce; new workers must be added to `DELEGABLE_WORKERS` + `WORKER_PERMISSION` (and the planner prompt) — registry-first, code second, as everywhere.
- Production LLM provider still unfunded (standing owner input): every LLM leg degrades to deterministic floors across the platform (now including planning). No new blocker introduced by this phase.
- Autonomy levels (0–5 per agent/BU), the policy engine, and risk classes remain P15 scope; the supervisor today delegates under the approval law only.

## 8. Deviations from Phase 0.5

None. Scope = roadmap P14 exactly (planner/delegator, §23 logging, router demotion, hard ceilings, acceptance criterion). P15/P16 items (autonomy levels, policy engine, goals) deliberately excluded. One pre-existing flake fixed (task-queue probe race — test-only, semantics preserved, disclosed in §5).

## 9. Status

Code complete · CI green (run #57) · deployed (Vercel GitHub integration) · production migrated (ledger 53) · live acceptance PASS. Owner-side inputs unchanged: real Gemini API key (`scripts/activate_gemini.py` ready), fresh Vercel token (SAML scope), staging activation per docs/STAGING.md, branch protection, credential rotation.
