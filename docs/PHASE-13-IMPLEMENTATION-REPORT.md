# Phase 13 Implementation Report — Analytics + Strategy Workforce

**Status: CODE COMPLETE — CI GREEN, DEPLOYED TO PRODUCTION. Production migration 046–048 + live acceptance PENDING owner ops credentials.**

- Roadmap: audit §20 Phase 12 (implementation numbering: Phase 13) — cross-BU dashboards, reporting agent (daily/weekly/monthly), recommendation engine
- Exit criterion: *owner-level cross-BU reporting with per-BU privacy respected (§99)* — enforced by construction + scope (below)
- Commit chain: `2c2bce6` (feat, 18 files +3312) → `f0fb24b`, `682cc37`, `23bb5d3` (CI-round fixes)
- CI: **GREEN on `23bb5d3`** — tsc + migrate + **54 suites** (new: `tests/analytics-tests.ts`) + build, on ephemeral pgvector
- Production: Vercel READY with new surfaces fail-closed (`/api/admin/analytics` 405-on-POST, reports 401, recommendations 401, `/analytics` 307→login); cron sweep verified safe pre-migration (`spawnDueReportRuns` is `.catch(() => null)`)

## 1. Data model (migrations 046–048)

| Migration | Content |
|---|---|
| `046 analytics_workforce` | `reports` (dedup: expression UNIQUE `COALESCE(business_unit_id,0), period_kind, period_key` — platform (bu NULL) scope dedups too), `report_schedules` (3 platform digests seeded: daily/weekly/monthly per §102–§103), `strategy_recommendations` (UNIQUE `COALESCE(bu,0), dedup_hash`; deliberately NOT named `recommendations` — SEO owns `seo_recommendations`) |
| `047 analytics_agents` | registry trio `analytics` / `strategy` / `reporting` activated (M_044 pattern: UPDATE + max+1 versioned prompts, outputSchemas `analytics_insights_v1` / `report_digest_v1` / `strategy_recommendations_v1`) |
| `048 analytics_flag_permissions` | `analytics` flag (OFF = scheduled runs skip, on-demand 423, reads unaffected) + `analytics.manage` → owner, administrator |

## 2. The §99 privacy law — enforced three ways

1. **By construction**: `lib/analytics/metrics.ts` returns COUNTS/SUMS only — no query in the aggregate layer projects a customer row; the per-BU breakdown is one numeric row per authorized BU.
2. **By scope**: every read model function takes the caller's `BuScope` (from `buScopeForUser`). `kind:"list"` callers see ONLY their own BUs — platform (bu NULL) reports/recommendations/schedules are invisible (`getReportForScope` → null, `listReports`/`listRecommendations`/`listSchedules` filtered; routes turn cross-scope existence into 404 — nothing leaks).
3. **By prompt discipline**: LLM legs receive the aggregate digest only (`payloadDigest`); provenance per leg stamps which ran (`insightsBy`/`narrativeBy`/`recommendationsBy` + prompt version/hash).

## 3. The pipeline (`processReport`)

collect (deterministic SQL) → **insights** (analytics agent; deterministic rules: spend-without-conversion, llm error-rate ≥20%, hot-open leads, escalation load, failed tasks, stuck content) → **digest** (reporting agent; floor = insight prose) → **recommendations** (strategy agent ≤5, kind/priority enums enforced by `completeJSON`; deterministic evidence-cited rules ALWAYS upsert) → `completeReport(status='ready')` + `analytics.report_ready` event.

Degradation contract: each leg fails independently (quota/budget/timeout/garbage) → its deterministic floor, report still lands `ready`, `degraded=true` only when ALL legs ran deterministic, `generated_by ∈ {deterministic, llm}`. `throw` → `failReport` + rethrow (task.failed pages ops).

## 4. Surfaces

- `GET /api/admin/analytics` — aggregate dashboard (metrics window, per-BU breakdown, reports, recommendations, schedules, summary, flag) — `analytics.manage | audit.read`
- `POST /api/admin/analytics/reports` — on-demand generation, inline pipeline, minute-bucket dedup (double-click returns same report), `423` flag drill, platform `403` for scope-limited, cross-scope BU `404` — `analytics.manage`
- `GET /api/admin/analytics/reports/[id]` — full record (§99 404 cross-scope)
- `POST /api/admin/analytics/recommendations/[id]` — `accept|dismiss`; row-locked FSM `open → accepted|dismissed` (both terminal, immutable review stamp) — `analytics.manage`, audited
- `/analytics` Command Center screen + nav entry (`analytics.manage | audit.read`)
- Cron sweep: due schedules → period-idempotent `report_run:<schedule>:<periodKey>` tasks, ticked in-request

## 5. Verification

- **Unit/CI (54 suites, `tests/analytics-tests.ts`)**: period math (ISO weeks, month bounds), exact per-BU fixture aggregates, report dedup, deterministic floor (ready + honest `degraded`), all-LLM legs (provenance llm, clamps: 600-char title → 200, 7 recs → 5), junk-strategy leg degrades ALONE (mixed provenance → `generated_by llm`), broken gateway → full floor, rec dedup + FSM terminal 409, §99 visibility matrix, platform payload PII scan, spawn idempotency, handler flag drill (OFF → `{skipped, reason}`, pending row stays pending)
- **CI rounds**: R1 `2c2bce6` failed → 3 real bugs (listRecommendations `LIMIT $3` without `$2` → PG 42P18; test stub routed on `messages[0]` but `completeJSON` prepends its own schema-hint system message; registry placeholder count 4→1) → R2 `f0fb24b` failed → 2 test bugs (exact llm-leg rec counting; BAD_STATE on the actually-ready report) → R3 carried a block-scoping tsc error → **R4 `23bb5d3` GREEN**
- **Production deploy**: live, fail-closed verified (above)
- **NOT YET on production**: migrations 046–048 (needs `POST /api/admin/migrate` with OPS_TOKEN/admin bearer) and the owner-session live acceptance drill (`scripts/phase13-live-acceptance.ts` pattern: owner login → aggregate-only assertions → on-demand report → dedup → flag drill → FSM → audit hygiene → screen sweep) — both blocked on owner-provided credentials this session (prior session's env did not survive)

## 6. Rollback

`analytics` flag OFF (runtime, zero deploys) = scheduled runs skip + on-demand 423; dashboard reads remain. Code rollback = revert commits; migrations are additive (000–048 ledger), no destructive change.

## 7. Outstanding (owner inputs)

1. **OPS_TOKEN** (or admin password) → apply migrations 046–048 to production (`POST /api/admin/migrate`, ledger 46→49)
2. **Owner credentials** → run `scripts/phase13-live-acceptance.ts` on production
3. **Real Gemini API key** (`AIza...`, https://aistudio.google.com/apikey) + `LLM_PROVIDER=gemini` + `GEMINI_API_KEY` on Vercel (needs a fresh Vercel token — stored one lost team scope) → unfunded legs light up with zero code changes
