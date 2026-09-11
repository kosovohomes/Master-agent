# PHASE 3 — IMPLEMENTATION REPORT

**Project:** AgentOS → Multi-Website AI Workforce & AI Command Center (`kosovohomes/Master-agent`, branch `main`)
**Implemented:** Phase 3 — Task + Workflow Engine, jobs, events, notifications, publications, exactly per §11 P3 / §312 / §126 / §205 of `docs/PHASE-0.5-Final-Architecture-Reconciliation.md`
**Commits:** `0d334f4` (Phase 3 foundation), `3c7e596` (CI round-1 fixes), `338e3b6` (CI round-2 fix), + lazy-settle / API-flex hardening commit
**Date:** 2026-09-12
**Status:** CI green (25 suites) · deployed to production · migrations 016–019 applied · acceptance criteria verified live

---

## 1. Executive summary

Phase 3 gave AgentOS background execution without a browser. The platform now has a durable job queue in Postgres — tasks are rows, never memory — with a claim protocol (`FOR UPDATE SKIP LOCKED`) that makes concurrent workers safe by construction, exponential backoff on failure, a visibility-timeout recovery sweep that guarantees the Phase 0.5 invariant "jobs must not disappear" (§140), cooperative cancellation, and ordered step records for every unit of work. The existing dispatch machinery became the FIRST task executor unchanged (wrap, don't rewrite), and the legacy publishing sweep became Workflow #1: the daily Vercel cron now triggers a workflow run whose task does the publishing through a new idempotent publication ledger (`content_publications`), where a pending claim row is inserted BEFORE the external side effect — two concurrent sweeps produce exactly one publish call per draft, proven both in CI (forced duplicate-sweep race) and by construction (UNIQUE idempotency key). The router was promoted to an explicit classifier (C-16): a topic that matches no worker no longer silently runs marketing inside the engine — the task escalates to `escalated` with a human notification, verified live on production. An event bus + notifications v1 closes the loop: terminal task failures, escalations and publish failures emit events that fan out to ops email through the queue itself, suppressed (but observable) when no target is configured. The outbox table is no longer written (write-stop, §205); it survives as archive with zero destructive change. Everything ships with an Operations screen in the Command Center and a machine worker endpoint so any external scheduler can drive the queue more often than Vercel's daily cron floor.

## 2. What was implemented

1. **Migrations 016–019** (versioned, ledgered, additive, idempotent): `tasks`/`task_steps` (016), `workflows`/`workflow_runs` + `scheduled_publishing_sweep` seed (017), `events`/`notifications` (018), `content_publications` (019). Ledger now at 20 entries; the 11 legacy tables verified intact post-migration on production.
2. **Durable queue** (`lib/tasks/queue.ts`): idempotent spawn (unique `(COALESCE(bu,0), idempotency_key)` — concurrent duplicate spawns collapse into one row), exclusive claims (attempts pre-incremented inside the claim transaction so crashed workers still converge), retry/backoff (20s · 4ⁿ capped 1h), terminal failure with error taxonomy, cooperative cancellation (queued → outright; inflight → `cancel_requested` observed between steps), visibility-timeout recovery (300s stale heartbeat → requeue), escalation and waiting-approval states, step records.
3. **Engine** (`lib/tasks/engine.ts`): `tick()` = recover stuck → claim batch (1–50) → run via handler registry; workflow definitions, `triggerWorkflow` (run row + task spawn, idempotency-keyed), `settleWorkflowRun` finalization; built-in handler registration.
4. **Built-in handlers** (`lib/tasks/executors.ts`):
   - `agent_dispatch` — wraps Phase 2 `dispatch()` unchanged as the first task executor; steps `classify → execute → record`; links `agent_runs.id` back to the task row.
   - `publishing_sweep` — Workflow #1 body; idempotency claim before side effect; channel health honoring; draft-only channels never auto-post (legacy invariant preserved); publish failures emit `publish.failed` events.
   - `send_notification` — delivers a notifications row via the existing email publisher; emits no events (loop guard).
5. **Classifier promotion (C-16)** (`lib/agents/core.ts`): `routeAgent` now returns `fallback: boolean` on every route. The manual API keeps the legacy permissive default; the task engine escalates on fallback — the silent-marketing-default audit finding is retired.
6. **Event bus + notifications v1** (`lib/tasks/events.ts`): append-only `events`; rule-based fanout for `task.failed`, `task.escalated`, `publish.failed`, `publish.succeeded`, `workflow.run_failed`; suppression without target (intent stays visible); delivery rides the queue; notification rows marked failed on terminal delivery failure; no notification-about-notifications cascade.
7. **Outbox write-stop** (`lib/agents/approval.ts`): `markPosted`/`markFailed` now write `content_publications` (UPSERT on the per-draft idempotency key) — zero new outbox rows; archive retained; drop deferred to Phase 4 as planned.
8. **Cron route transformed** (`app/api/agents/sweep/route.ts`): same secret gate, same GET alias, same `disable_publishing` emergency flag; now triggers Workflow #1 (daily-idempotent spawn key `sweep:YYYY-MM-DD`), then runs an engine tick, then settles the run. Rollback hatch: feature flag `legacy_sweep_direct` restores the exact pre-engine path with zero code change (§140 soak requirement).
9. **Machine worker endpoint** (`/api/agents/engine/tick`): cron-secret gated, audited, batched — the §63 sub-daily cadence decision: Vercel cron stays the guaranteed daily floor; any external scheduler can drive the queue every few minutes.
10. **Operations APIs + screen**: `/api/admin/tasks` (GET list + POST spawn), `/api/admin/tasks/[id]` (GET detail+steps, POST cancel), `/api/admin/workflows` (GET defs+runs, POST manual trigger), `/api/admin/events` (GET events+notifications); `/operations` Command Center screen with nav entry. Reads gate on `audit.read`, mutations on `ops.run`; every mutation audited.
11. **Tests**: 3 new suites (task-queue, workflow-engine, events) — 25 total in CI; outbox assertions across approval/publishers suites migrated to `content_publications` (including a new negative assertion that the outbox is NOT written); classifier fallback contract assertions added to the routing suite.

## 3. What was intentionally NOT implemented (Phase 4+ scope)

LLM budget enforcement and the AI Gateway (Phase 4 — the daily cap remains the interim control); tool loops and tools with side effects; supervisor/planner (Phase 14); content_items/versions and the 9-state content lifecycle (Phase 7 — `waiting_approval` is wired in the task machine but no producer sets it yet); event-triggered workflow automation beyond the fanout rules (trigger kind `event` exists in schema, no UI wiring); webhook and goal trigger kinds (explicitly reserved); outbox table drop (Phase 4); tenant_config table retirement reader-flip (the BU-fold readers were already flipped in Phase 2; the table itself stays untouched per additive-first). No destructive schema operations of any kind.

## 4. New files

- `lib/tasks/types.ts` — task/step row types, 8-state machine, spawn/tick contracts.
- `lib/tasks/queue.ts` — durable queue: spawn (idempotent), claim (SKIP LOCKED), complete/fail (backoff), cancel (cooperative), recovery, escalation, steps, listing.
- `lib/tasks/handlers.ts` — handler registry (cycle-free module).
- `lib/tasks/executors.ts` — the three built-in handlers + test seams (`setBuiltinDispatchLlm`, `setBuiltinEmailSender`).
- `lib/tasks/engine.ts` — tick loop, workflow triggering, run settlement.
- `lib/tasks/events.ts` — event bus, notification fanout rules, delivery marking, list views.
- `lib/tasks/bootstrap.ts` — serverless cold-start registration.
- `app/api/admin/tasks/route.ts`, `app/api/admin/tasks/[id]/route.ts` — task ops APIs.
- `app/api/admin/workflows/route.ts` — workflow defs/runs + manual trigger.
- `app/api/admin/events/route.ts` — event/notification read view.
- `app/api/agents/engine/tick/route.ts` — machine worker endpoint.
- `app/(dashboard)/operations/page.tsx` — Operations screen.
- `tests/task-queue-tests.ts`, `tests/workflow-engine-tests.ts`, `tests/events-tests.ts`.

## 5. Modified files

- `lib/migrations/definitions.ts` — migrations 016–019 + header ledger docs.
- `lib/agents/core.ts` — classifier promotion (fallback flag on PlanRoute).
- `lib/agents/types.ts` — `PlanRoute.fallback`.
- `lib/agents/approval.ts` — outbox write-stop (publications ledger UPSERT).
- `app/api/agents/sweep/route.ts` — Workflow #1 trigger + tick + settle; rollback flag.
- `app/(dashboard)/layout.tsx` — Operations nav entry.
- `tests/run-all.ts` — 3 new suites.
- `tests/agents-routing-tests.ts` — fallback contract assertions.
- `tests/approval-tests.ts`, `tests/publishers-tests.ts` — publication-ledger assertions + engine-mode sweep response acceptance.

## 6. Status machine (final)

```
queued ──claim──▶ claimed ──markRunning──▶ running ──▶ succeeded
   ▲                  │                      │    ├──▶ failed (attempts exhausted)
   │                  │                      │    ├──▶ escalated (classifier fallback / handler)
   │  recover ────────┘                      │    └──▶ cancelled (cancel_requested honoured)
   │  (stale heartbeat)                      └──▶ waiting_approval (P7 producers arrive later)
   │
   └── retry (attempts < max) ◀── failure with backoff 20s·4ⁿ (cap 1h)
queued ──▶ cancelled (operator, before claim)
```

## 7. Idempotency & the zero-duplicate-posts guarantee (§88)

The publication path is: (1) `INSERT INTO content_publications … idempotency_key = 'draft:<id>' … ON CONFLICT DO NOTHING RETURNING id`; (2) if no row returns, another worker already claimed → skip (counted as `duplicates_prevented`); (3) only the claim winner performs the external POST; (4) `markPosted` UPSERTs the same row to `published` with the external id. Because the UNIQUE constraint is enforced by Postgres, the guarantee holds under any number of concurrent sweeps, workers, and even a manual + cron trigger racing. CI proves it: two engine ticks race two sweep tasks over one scheduled draft → exactly one publish call, winner `posted=1`, loser `duplicates_prevented=1`, one `published` publication row, draft posted once.

## 8. "Jobs must not disappear" mechanics (§140)

Tasks survive worker death because the claim transaction pre-increments attempts and stamps a heartbeat; `recoverStuckTasks()` (top of every tick) requeues anything inflight with a heartbeat older than 300s. A worker that crashes mid-run consumes one attempt — a task that repeatedly kills its workers converges to terminal `failed` instead of looping forever. Tested: stuck task requeued, healthy inflight untouched, dead worker's attempt accounted.

## 9. Classifier promotion (C-16) — behavior change note

`routeAgent` returns `fallback: true` only for the legacy default-marketing miss. Caller semantics: (a) `POST /api/agents/run` — unchanged UX, fallback routes still run marketing (documented decision; the manual operator explicitly asked for a run); (b) engine tasks — fallback escalates with a reason string, emits `task.escalated`, and creates no draft; (c) explicit `allowFallback: true` on a spawned task restores legacy behavior for controlled programmatic use. Verified live on production: unmatched topic → task escalated, zero LLM calls, zero drafts.

## 10. Cron & cadence (roadmap §63 decision)

- Vercel cron `30 3 * * *` → `/api/agents/sweep` remains the guaranteed daily floor and is now Workflow #1's trigger.
- `/api/agents/engine/tick` (cron secret) is the sub-daily worker: retries leaving backoff, event-spawned notification tasks, manual dispatch work. Recommend an external scheduler every 5–15 minutes (cron-job.org / GitHub Actions / uptime pinger). Claims are SKIP LOCKED — overlapping schedulers are safe.
- Rollback: `legacy_sweep_direct` flag on → next cron hit runs the exact legacy sweep (flag flips in Settings without deploy).

## 11. Operations surface (owner-facing)

The new **Operations** screen shows: workflow definitions with Run-now buttons; recent workflow runs; the task queue (status badges, attempts, errors, cancel buttons); the event feed; and notification delivery state. The same data is API-first via `/api/admin/{tasks,tasks/[id],workflows,events}` for anything the UI grows into later. Permissions: reads ride `audit.read`, actions ride `ops.run` (owner + administrator by seed).

## 12. Live production acceptance (executed 2026-09-11/12 UTC)

| Check | Result |
|---|---|
| Migrations 016–019 via `POST /api/admin/migrate` | applied ×4, ledger 20, legacy tables 11/11 intact |
| `scheduled_publishing_sweep` seeded + enabled | confirmed via `/api/admin/workflows` |
| Engine tick with cron secret / 401 without | 200 / 401 |
| Classifier escalation (unmatched topic via task) | task `escalated` with reason; `classify` step recorded failed; **no draft, no LLM call** |
| Event bus | `task.escalated` event persisted; notification fanned out to owner email target |
| Manual workflow trigger (Run-now) | run row + task spawned; task `succeeded` (`due:0`); steps recorded |
| Widget regression (`/api/v1/widget/config?tenant=acme-homes`) | 200 |
| Operations screen + owner session | 200, login intact |
| CI (ephemeral pgvector Postgres) | 25 suites green incl. forced duplicate-sweep race |

## 13. Live-discovered operational items

1. **Resend testing-mode 403** (observed live, handled correctly by the engine): notification delivery to `wakeelypro@gmail.com` fails with `You can only send testing emails to your own email address (hamad@kafeely.com). To send emails to other recipients, please verify a domain at resend.com/domains.` The task retries with backoff, terminal-fails after 3 attempts, and the notification row shows `failed` with the provider message — observable, no cascade. **Owner action (pick one):** verify a sending domain at resend.com/domains and set `EMAIL_FROM` to it; or set `EMAIL_TARGET=hamad@kafeely.com` (and `EMAIL_FROM` accordingly) while in testing mode.
2. **OpenAI quota blocker (carried from Phase 2, unchanged):** LLM paths return 429 `insufficient_quota`. The task engine makes this non-fatal by design — a failed dispatch task retries and terminal-fails with full attribution instead of disappearing. **Owner action:** add credits to the OpenAI account to unlock agent generation end-to-end.

## 14. CI rounds (transparency)

Round 1: two suites failed — (a) publishers-tests asserted the legacy sweep response shape (engine mode returns `{mode:'engine', workflow, tick}`); (b) task-queue claim-ordering: the raced idempotency task won claims intended for later probe tasks (older `next_run_at` tie-break) → retire it after the race + claim probe at priority 1. Round 2: one check — after a retried failure, backoff pushed `next_run_at` 20s out, so the second claim never reached the task; the test now advances the clock (forces due) the way wall-clock would. Round 3: green. No engine-code defects were found by CI in either round — both were test-harness issues, and the engine executed end-to-end on the ephemeral database on the first push (migration → trigger → tick → publish).

## 15. Security review (delta)

- New endpoints behind existing guards: machine endpoints (sweep, tick) cron-secret gated (`safeEqual`); admin endpoints session+RBAC gated; every mutation audited (`tasks.spawn`, `tasks.cancel`, `workflows.trigger`, `engine.tick` denials included).
- Rate limits unchanged on public paths; the engine adds no public surface (cron-secret machine endpoints are not browser-facing).
- No secrets in notifications (subjects + payload metadata only); task payloads may carry user topics — visible only to `audit.read` holders, consistent with drafts visibility.
- `disable_publishing` and `stop_all_agents` flags both still honored (sweep flag in the new path as before); new `legacy_sweep_direct` is an ops rollback, not a security surface.
- Audit-path immutability: `content_publications` carries no `ON DELETE CASCADE` from drafts/tenants (C-20 direction); outbox archive untouched.

## 16. Performance & cost notes

Queue operations are single-row indexed updates; a tick of batch N is N claims + N handler executions with one recovery UPDATE. The daily cron tick adds negligible DB load. Publication ledger grows one row per draft attempt (idempotent, no growth on retries). Notification tasks are priority 50 (above routine work) and capped at 3 attempts. No new external calls beyond the existing publishers (email delivery rides Resend as before).

## 17. Rollback plan

Per-capability, flag-driven, zero code: `legacy_sweep_direct` → cron behaves exactly as pre-Phase 3; `disable_publishing` → halts scheduled publishing; per-task `cancel` + `max_attempts` control live work; migrations 016–019 are additive tables that can simply stop being read (no destructive rollback required); handlers are registered in one function (`registerBuiltins`) — disabling a kind is a registry row removal in code, not a schema change.

## 18. Roadmap compliance checklist (P3 bullets)

- [x] tasks/steps/status machine incl. WAITING_APPROVAL/ESCALATED
- [x] workflows + triggers (schedule/event/manual; webhook+goal reserved in schema CHECK)
- [x] job queue with claims (FOR UPDATE SKIP LOCKED), attempts/backoff
- [x] event bus + notifications v1
- [x] sweep → Workflow #1 (seeded, triggered by existing cron)
- [x] dispatch → task executor (wraps, unchanged)
- [x] content_publications with idempotency
- [x] outbox write-stop (archive kept)
- [x] Test: forced duplicate-sweep produces zero duplicate posts
- [x] Test: retry/backoff · cancellation · event delivery
- [x] Acceptance: scheduled task executes with browser closed (engine tick + cron path)
- [x] Acceptance: concurrency test proves idempotency (§88)
- [x] Rollback: cron sweep retained behind flag until engine soaks
- [x] NOT implemented (correctly): LLM budget enforcement, tool loops, supervisor

## 19. Where this leaves the roadmap

Phases 0–3 complete: security gate, identity/RBAC, BU/websites, ops+CI+Command Center (P1); agents-as-data registry with attribution (P2); durable background execution with workflow/event/publication machinery (P3). The platform now has everything the workforce phases assume: P4 (AI Gateway & cost control) is next and is the last infrastructure phase — it needs a funded OpenAI account to be verifiable end-to-end (owner action from §13.2). After P4: P5 knowledge v2, then the research (P6) and content (P7) workforces that turn this engine into visible product value.

## 20. Artifact summary

- 26 files changed in the Phase 3 foundation commit (+2,563/−40), plus hardening commits.
- 20-entry migration ledger on production; 11 legacy tables intact.
- 25 test suites in CI; build passes with 34 routes (was 30).
- New owner-visible surface: `/operations` screen; zero changes to the public widget contract.
