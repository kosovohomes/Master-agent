# Phase 8 Implementation Report — Content Workforce

**Phase:** 8 (owner-named sequence) = roadmap **P7 — Content workforce** (Phase 0.5 §461–462, audit §901, §60–§61 lifecycle, §5.1 state map, §72 approval immutability)
**Baseline:** `origin/main @ 0bc9e4f` (Phase 7 complete) → **final: `origin/main @ 5301394`**
**Status:** COMPLETE — CI green (40 suites), Vercel production READY @ 5301394, migrations 032–034 applied, live acceptance **35/35 PASS** on `https://masteragent-nine.vercel.app`

---

## 1. Executive summary

The content workforce closes MVP use case #2 (**research → content**, §138): a research finding
or an operator brief becomes a **versioned, fact-checked, approval-gated content package**
end-to-end. Three registry agents — `content_strategy` → `content` → `fact_check` — execute as
one durable task (`content_run`) through the AI gateway (budgeted, ledgered, attributed). The
artifact is a `content_items` row carrying the §60 nine-state lifecycle; every text lands as an
immutable `content_versions` row (never-overwrite, §61). The approval center reaches v2:
pending requests ARE items in REVIEW, decisions are immutable INSERTs (§72), and the
edit-before-approve trail lives in `approval_actions`. Legacy drafts remain untouched and the
legacy publishing sweep still runs unchanged (rollback-safe cutover deferred).

## 2. Scope decisions (tech lead)

1. **Phase numbering**: owner's standing order names phases sequentially; Phase 8 = roadmap P7.
2. **No auto-publishing** (roadmap: "NOT yet"): APPROVED is the acceptance boundary.
   APPROVED → SCHEDULED/PUBLISHED transitions exist for the operator path only, audited.
3. **`drafts` kept as-is** (not made read-only): the legacy marketing → FSM → publishing
   sweep keeps running unchanged; the lineage backfill COPIES drafts into content_items.
   The roadmap's "drafts kept read-only until cutover verified" is implemented as "drafts
   untouched until cutover" — flipping legacy flows off is a later, explicitly-approved step.
4. **Pending queue = the lifecycle**: no mutable "pending" approvals rows. An item in REVIEW
   is the request; deciding INSERTs an immutable approvals row (§72) — no CHECK widening.
5. **`approvals.draft_id` relaxed to NULL** (pure constraint relaxation, legacy rows intact)
   so v2 decisions reference `content_item_id` — deliberately **without** ON DELETE CASCADE.
6. **Degraded-first**: with the OpenAI key unfunded, the chain parks items in RESEARCHING
   with the full material preserved (Phase 7 §144 pattern) and the task SUCCEEDS — the
   queue never error-loops, and reprocess resumes once the key is funded.
7. **Strategy step is not skippable in v1**: `skipStrategy` exists in the payload contract
   but the chain always runs all three steps; a brief-only plan mode is deferred.

## 3. Architecture: the content chain

```
content_run (durable task, lib/content/tasks.ts)
  ├─ flag gate (content OFF → fail-closed SKIP, not an error)
  ├─ prepare  — mode: contentItemId (run/reprocess) | researchItemId (lineage) | brief
  │             item created at IDEA → RESEARCHING; brief + sources preserved on the row
  ├─ chain    (lib/content/chain.ts — pure, fake-LLM testable)
  │    ├─ content_strategy  (versioned prompt, CONTENT_PLAN_SCHEMA, temp 0.3)
  │    ├─ content           (versioned prompt, CONTENT_DRAFT_SCHEMA,  temp 0.7)
  │    └─ fact_check        (versioned prompt, FACT_CHECK_SCHEMA,     temp 0)
  ├─ persist  — RESEARCHING → DRAFT (version appended) → FACT_CHECK → REVIEW
  │             risk = factCheck.status (fail→high, warnings→medium, pass→low)
  │             submitForReview records risk + requested_action + submit trail row
  └─ on LLM failure — degraded: item parks in RESEARCHING with unprocessed_reason,
                       brief preserved; task result {degraded:true}; reprocess ready
```

Every LLM call rides the gateway with per-task attribution (BU + task, `purpose="content"`)
— budgets, hard-stops and the llm_requests ledger cover the chain like every other leg.

## 4. Data model (migrations 032–034, strictly additive)

- **032 content_workforce**:
  - `content_items`: BU/website/research lineage FKs, `type` CHECK, §60 `lifecycle` CHECK
    (9 states), `brief` JSONB, `current_version_id` (FK added after content_versions),
    `unprocessed_reason`, `task_id`, reviewed stamps; index (bu, lifecycle, updated_at).
  - `content_versions`: immutable rows, `UNIQUE (content_item_id, version)`, metadata JSONB
    (plan + factCheck), prompt attribution, change_note.
  - `approvals` v2 columns: `content_item_id` (NO cascade, §72), `risk_level` CHECK,
    `requested_action`, `decision_reason`, `task_id`; `draft_id` DROP NOT NULL (relaxation).
  - `approval_actions`: the edit-before-approve trail — action CHECK (submit/approve/
    reject/request_changes/edit/assign/escalate), diff JSONB, actor identity, note.
  - **Drafts lineage backfill (§5.1 state map)**: each draft whose tenant has a BU mapping
    → content_item + version 1; state map pending→DRAFT, approved→APPROVED,
    scheduled→SCHEDULED, posted→PUBLISHED, failed→PUBLISHED (failure traceable in
    content_publications + brief.legacy_status), rejected→REVIEW. Unmapped tenants stay
    OUT (never silently global). Idempotent re-runs (brief.legacy_draft_id guard).
- **033 content_workforce_agents**: activates `content_strategy` / `content` / `fact_check`
  (seeded disabled at P2) + versioned v1 prompts in agent_versions (agents are data, §6.4).
- **034 content_flag_permissions**: `content` flag (platform kill switch) + `content.manage`
  permission (owner + administrator).

## 5. Storage + transactional FSM (`lib/content/service.ts`)

- The ONLY writer of content rows. `appendVersion()` locks the item row, computes
  `COALESCE(max(version),0)+1`, inserts the immutable version and moves
  `current_version_id` inside ONE transaction; the UNIQUE constraint is the backstop.
- `transitionItem()` = Phase 1 SEC-C7 pattern: FOR UPDATE read → LIFECYCLE_FLOW legality →
  write in one transaction. Concurrent double-decision: exactly one wins (tested).
- `submitForReview()` is idempotent (already-REVIEW items just get risk/action recorded).
- `decideItem()`: decision required in REVIEW; approve→APPROVED, request_changes→DRAFT
  (rework), reject→ARCHIVED. Writes the immutable approvals row, the approval_actions row,
  and emits `content.approved` / `content.rejected` (reject pages ops).
- `addManualVersion()` appends a human version + 'edit' trail row (edit-before-approve).
- Leaving RESEARCHING clears `unprocessed_reason` (reprocess success is observable).

## 6. API surface (fail-closed, RBAC, audited)

| Route | Perms | Behavior |
|---|---|---|
| `GET /api/admin/content` | content.manage ∨ audit.read | items (filterable), REVIEW queue, stats, flag |
| `POST /api/admin/content` | content.manage | `{mode:"item"}` create (IDEA/DRAFT) · `{mode:"run"}` spawn chain — **flag OFF → 409 CONTENT_DISABLED** (fixed during acceptance) |
| `GET /api/admin/content/[id]` | content.manage ∨ audit.read | item + versions + decisions + trail |
| `PATCH /api/admin/content/[id]` | content.manage | explicit lifecycle transition; illegal → 409 |
| `POST .../versions` | content.manage | manual edit → new immutable version + edit trail |
| `POST .../run` | content.manage | run/reprocess now; 409 flag OFF; 409 terminal states |
| `POST .../decide` | content.manage | approve/reject/request_changes; reason required except approve; 409 NOT_IN_REVIEW |

Audit actions: `content.item.create`, `content.run.spawn`, `content.item.transition`,
`content.version.create`, `content.review.{approve,reject,request_changes}`. No secrets.

## 7. Command Center screens

- **/content** (nav: content.manage ∨ audit.read): 9-state stat tiles; create & run form
  (brief | research-item id); items list with lifecycle/risk/lineage badges + degraded
  markers; item drawer = versions (never-overwrite history), fact-check verdict banner,
  decision panel (approve / request changes / reject with reason), decision + trail log,
  operator transitions (APPROVED → SCHEDULED/PUBLISHED).
- **/approvals** gained the v2 section on top: content items in REVIEW with risk badges and
  the three decision buttons; the legacy drafts queue below is untouched.

## 8. Security review

- Fail-closed: flag OFF → run routes 409 + handler skips; unauthenticated → 401; RBAC
  server-side (owner/administrator hold content.manage); audits carry no secrets (verified).
- Approval immutability (§72): decisions are INSERT-only; no UPDATE path exists in code.
- The `content_item_id` FK has no cascade — decisions outlive items by design.
- Transactional FSM closes the double-approve window (SEC-C7 inheritance).
- All LLM legs ride the gateway: budget hard-stop + ledger + attribution apply (no bypass).

## 9. Test evidence (40 suites, ALL PASS)

New suites (3):
- `content-lifecycle-tests` (pure): 9-state table, forward paths, guard rails (no skips, no
  self-transitions, ARCHIVED terminal, archive reachable), §5.1 state map exact, risk
  mapping, schema required fields/enums.
- `content-service-tests` (DB): never-overwrite (v1 body unchanged after v2), UNIQUE
  backstop, illegal jumps, concurrent decision (exactly one wins), submit/approve/rework/
  reject flows, immutable rows, trail rows, manual edits, BU isolation, stats.
- `content-tasks-tests` (DB + fake LLM): flag-off skip; happy path (3 chain steps in prompt
  order, prompt attribution, version metadata carries plan+factCheck, risk low/medium);
  research lineage (item.research_item_id, brief context, unprocessed source rejected);
  degraded (parked + reason + brief preserved, task succeeds); reprocess (completes once
  "funded", reason cleared, re-parks on a broken provider).

Updated: `migrations-tests` (19 tables / 8 flags), `registry-tests` (Phase 8 trio activated,
9 placeholders left). Full suite verified against the staging Neon DB (`agentos_staging`,
ALLOW_PROD_TESTS=1 per STAGING.md Option B precedent) — ALL PASS; one shared-DB flake
re-run clean (task-queue), and a leftover-task hygiene fix was added to the suite itself.

## 10. Live acceptance (production) — VERIFIED

`scripts/phase8-live-acceptance.ts` @ `5301394`: **ALL PASS (35 checks)** —
owner login; unauth 401; item create → IDEA; manual version v1 + current pointer + edit
trail; lifecycle transitions incl. DRAFT→APPROVED 409; reject-without-reason 400;
approve → APPROVED + immutable approvals row (content_item_id set, draft_id NULL) + trail;
second decision 409; chain run via engine tick → **degraded mode proven end-to-end**
(task succeeded, item parked RESEARCHING with reason, reprocess spawned — nothing lost);
flag drill OFF→409 CONTENT_DISABLED / ON→restored; audit rows + no secrets; 6 screens 200;
cleanup archived all acceptance items.

## 11. Rollback map

- **Flag `content` OFF** → run routes 409, handler skips in-flight tasks. Zero deploys.
- Legacy flows untouched: drafts FSM, publishing sweep, approvals (legacy), widget —
  asserted by the existing suites; the content layer is strictly additive.
- Migrations are additive; dropping the phase = flag OFF (+ optionally inert tables).

## 12. Known limitations (recorded)

- Without a funded OpenAI key, the chain parks every item in RESEARCHING (material fully
  preserved; reprocess ready). The lifecycle/versioning/approval machinery is fully live.
- Manual items start IDEA; the strategy step always runs (brief-only plan mode deferred).
- `content_run` tasks created by the bare-brief API carry no schedule — recurring content
  pipelines ride a later phase (cadence on content schedules, P8/P9 territory).
- The risk level is stored on the item brief (display concern), not a separate column.

## 13. Deferred (recorded)

- Drafts cutover (retiring legacy drafts + marketing rewrite onto content_items) — needs a
  dedicated migration phase with owner sign-off (same class as the P4 tenants→VIEW deferral).
- Auto-publish wiring for content_items (P8/P9: connectors + social workforce).
- Intelligence-agent chaining consuming research_items automatically (P7 roadmap text) —
  the manual "Run from research finding" path ships now.
- Evaluation datasets beyond §109 — P15 metrics.

## 14. Next per roadmap

**P8 — SEO + publishing integration (roadmap §466 pulls social to P9; next per §462's
chain: seo agent P8, connectors consumption of approved content, scheduled publishing of
APPROVED items via the existing publisher adapters).** REQUIRES a funded OpenAI key for
live LLM verification of the content chain itself — every deterministic surface (lifecycle,
versioning, approvals, flag drill, audit) is already verified live.
