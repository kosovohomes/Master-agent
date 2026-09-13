# Phase 9 Implementation Report — SEO Workforce

**Status:** COMPLETE — production live at `5a50c2a` (deploy READY), CI green (43 suites),
live acceptance ALL PASS on production.

**Roadmap anchor:** PHASE-0.5 §464 (P8 in roadmap numbering; report numbering continues
the Phase N sequence): "SEO workforce — SEO agent, keyword store, gap analysis,
recommendations with approval flags. Acceptance: SEO recommendations appear with evidence."

## 1. Executive summary

The SEO workforce turns platform artifacts (research findings, content items, competitor
registry + intelligence) into keyword intelligence and actionable, evidence-backed
recommendations. Every recommendation carries a mandatory evidence array — the acceptance
criterion is "recommendations appear with evidence", and the service refuses to store a
recommendation without it. Recommendations flow through approval flags
(open → approved → done / dismissed) with immutable reviewer identity, mirroring the §72
class of the content approval center.

The scan is deliberately two-legged:

1. **Deterministic leg (always runs, zero LLM):** keyword harvest (frequency-ranked n-gram
   phrases from research findings/content titles + competitor brand names + competitor
   event fragments), brand-gap rule, competitor-term gap rule, content-coverage rule.
2. **LLM analysis leg (versioned `seo` prompt, structured output):** intent/difficulty
   estimates and richer on_page/technical recommendations. With the OpenAI account still
   unfunded this leg degrades cleanly — the scan still succeeds with the deterministic
   artifacts, `degraded=true`, `degradeReason="llm_unavailable"` recorded. Funding the key
   instantly upgrades the same task with no rework.

## 2. Scope decisions (tech lead)

- **Deterministic-first recommendation rules.** The original rule set (gap = event-derived
  terms not in the store; coverage = strong findings without content) produced zero
  recommendations on production BU 1, where all competitor events and scored findings are
  LLM-derived (and the LLM is unfunded). Rather than seed synthetic data, the rules were
  redesigned to be production-viable without the LLM:
  - **Brand gap** (new): a tracked competitor with no content item covering its brand term
    → comparison/alternative-page recommendation. Evidence = competitor registry entry +
    keyword-store observation. This is honest, useful, dedup-stable advice.
  - **Term gap** (reworked): event-derived competitor terms whose store row has no target
    URL → "evaluate targeting" recommendation, keyed to the post-harvest store state.
  - **Content coverage** (unchanged): research findings scoring ≥ 70 with no overlapping
    content item.
- **Post-harvest evaluation.** The keyword store is re-read in the recommendations step so
  the gap rules reason over what the scan actually tracked ("tracked, no target URL") —
  not a stale pre-scan snapshot.
- **No schedule table for v1.** Scans are manual + durable (`seo_scan` tasks); recurring
  cadence semantics belong to the P9 social calendar per roadmap. The task engine makes
  any future scheduler a thin wrapper.
- **No per-recommendation notification fanout in v1.** The /seo screen is the sink; a
  high-risk notification policy rides the later notification-policy pass.

## 3. Architecture

```
POST /api/admin/seo {businessUnitId}          (seo.manage, audited)
  └→ spawnTask(seo_scan)                      durable, SKIP LOCKED, steps recorded
       └→ lib/seo/tasks.makeSeoScanHandler
            1. flag gate (fail-closed SKIP)
            2. context  — website, owned keywords, research excerpts,
                          content titles, competitors + event fragments
            3. keywords — deterministic harvest → upsert (normalized UNIQUE)
            4. analysis — ONE LLM leg (versioned prompt, SEO_ANALYSIS_SCHEMA);
                          any failure → degraded=true, deterministic stands
            5. recommendations — re-read store → rules + sanitized LLM drafts
                                 → recordRecommendation (dedup = DB, evidence gate)
            6. seo.scan event
```

Attribution rides the AI gateway (`withAttribution`, purpose="seo") so budget ceilings
and the `llm_requests` ledger cover the analysis leg like every other workforce.

## 4. Data model (migrations 035–036, strictly additive)

- **035 `seo_workforce`**
  - `seo_keywords` — BU-scoped store; `normalized_keyword` UNIQUE per BU; intent
    (informational/commercial/transactional/navigational), position/previous_position,
    volume_est/difficulty_est, source (manual/research/content/scan), status
    (active/retired), task attribution, first/last seen.
  - `seo_recommendations` — target (page/site), kind (on_page/technical/content/keyword/
    gap), title/detail, **evidence JSONB**, status FSM (open/approved/dismissed/done),
    risk, dedup_hash UNIQUE per BU, reviewer identity (reviewed_by/reviewed_at),
    prompt_version/prompt_hash, task link.
  - `seo` agent activated (P2 placeholder) + versioned v1 prompt (agent_versions).
- **036 `seo_flag_permissions`** — `seo` feature flag (kill switch) + `seo.manage`
  permission granted to owner + administrator.

Legacy 11 tables untouched (verified: production `legacyTables: 11/11`).

## 5. Storage contracts (`lib/seo/service.ts`)

- The service is the ONLY writer of `seo_*` rows (same discipline as research/content).
- Keyword upsert: re-observation updates intent/difficulty/source/last_seen instead of
  duplicating; retired keywords are NOT resurrected by scans (manual re-entry only).
- Recommendation dedup: `UNIQUE (business_unit_id, dedup_hash)`; hash = sha256 of
  (BU, kind, target_url, normalized title) — repeated scans are counted no-ops.
- **Evidence gate at the write boundary:** empty evidence → `evidence_required` error;
  evidence entries without label+note → `invalid_evidence`. (Pipeline and the LLM schema
  also enforce it; the service is the last line of defense.)
- Approval FSM: `open → approved | dismissed`, `approved → done`; terminal states are
  terminal; reviewer identity is stamped in the same UPDATE as the status and guarded by
  `WHERE status = <read>` so concurrent decisions have exactly one winner (loser surfaces
  `conflict` or `invalid_transition` depending on race timing — both mean one winner).
- Event bus: `seo.recommendation` + `seo.scan` (observable, no notification fanout v1).

## 6. API surface (fail-closed, RBAC, audited)

| Route | Gate | Behavior |
|---|---|---|
| `GET /api/admin/seo` | seo.manage \| audit.read | keywords + recommendations (filterable), stats, flag state |
| `POST /api/admin/seo` | seo.manage | spawn `seo_scan` task (audited; returns taskId) |
| `PATCH /api/admin/seo/keywords/[id]` | seo.manage | retire/reactivate keyword (audited) |
| `PATCH /api/admin/seo/recommendations/[id]` | seo.manage | approve / dismiss / complete — FSM-guarded, reviewer-stamped, audited |

Unauthenticated → 401 (verified live); illegal actions → 400 with stable codes; no
provider detail leakage anywhere.

## 7. Command Center screen

`/seo` (nav-gated on `seo.manage | audit.read`): scan trigger (BU picker), stats cards
(active keywords / open / approved / done / with-evidence %), recommendations list with
status/kind/risk badges, expandable evidence (labeled links + notes + research-item
links), approve/dismiss/complete actions, and the keyword table (intent, difficulty,
est. volume, source, last seen, retire action).

## 8. Security review

- RBAC: every route gated server-side; owner + administrator hold `seo.manage` (seeded).
- Flag kill switch: `seo` OFF → handler skips fail-closed (`seo_flag_off`), no error
  loops, zero deploys. Verified live via the flag drill.
- Audit: scan spawn + every recommendation decision recorded with actor identity; the
  live audit-hygiene check confirms no secrets in audit rows.
- Secrets: none printed; the acceptance script reads credentials from env only.
- Evidence is data, not HTML — stored as JSONB, rendered as text/links client-side.

## 9. Test evidence (43 suites, ALL PASS)

New suites (3):
- `seo-pipeline-tests` (pure): normalization, dedup-hash stability/sensitivity, harvest
  (research phrases, competitor brands, stopword filtering, dedup, 40-cap), brand-gap +
  term-gap + coverage rules (evidence mandatory, brand suppression when covered, 6-cap),
  LLM output sanitization (evidence-less dropped, 12-cap), citation numbering.
- `seo-service-tests` (DB): keyword upsert semantics (normalize, re-observe, retired
  guard, manual resurrect, BU isolation), evidence gate, recommendation dedup, FSM
  (all transitions + terminality + concurrent exactly-one-wins + reviewer identity),
  lists, stats, stored-hash consistency.
- `seo-tasks-tests` (DB + fake LLM): flag-off skip; degraded mode (LLM down → task
  SUCCEEDS with deterministic artifacts + degradeReason); LLM mode (single analysis
  call, intent/difficulty keywords, LLM rec stored with evidence); repeat-scan dedup
  (no new rows, duplicates counted); payload BU scoping; flag restore.

Updated: `migrations-tests` (21 tables / 9 flags), `registry-tests` (seo activated,
8 placeholders left). Full suite verified against the staging Neon DB
(`agentos_staging`, ALLOW_PROD_TESTS=1 per STAGING.md Option B precedent) — ALL PASS;
the known shared-DB flake in task-queue re-ran clean.

## 10. Live acceptance (production) — VERIFIED

`scripts/phase9-live-acceptance.ts`: **ALL PASS (36 checks)** — owner login; unauth 401;
surface + flag; scan spawned (durable task) and processed via engine tick (steps
context→keywords→analysis→recommendations recorded twice-over, task SUCCEEDED);
degraded mode coherent (`llm_unavailable`, OpenAI still unfunded); keyword store
populated (4 keywords: competitor brand + research-harvested phrases, intent+source on
every row); recommendation recorded with evidence 1/1 and 100% evidence coverage;
approval flags (illegal transition 400 → approve with reviewer identity → done →
terminal 400); flag drill OFF (fail-closed skip) → ON restored; audit rows present
(scan.spawn, approve, complete) with no secrets; 6 screens 200; widget regression 200.

## 11. Rollback map

- **Flag `seo` OFF** → scans skip fail-closed; routes still read-only. Zero deploys.
- Migrations are additive; dropping the phase = flag OFF (+ optionally inert tables).
- Legacy flows (drafts FSM, publishers, widget, channels) untouched — asserted by the
  existing suites; the SEO layer is strictly additive.

## 12. Known limitations (recorded)

- With the OpenAI key unfunded, the analysis leg degrades: no intent/difficulty
  enrichment beyond defaults, no on_page/technical LLM recommendations. The
  deterministic legs still deliver evidence-backed recommendations (proven live).
- Rank positions are schema-ready (position/previous_position) but unused in v1 — there
  is no rank-tracking source integrated yet; the columns wait for a real data source.
- Content-coverage recommendations require scored findings (score ≥ 70); unscored
  (unprocessed) material is excluded by design.
- Gap recommendations key on "no target URL" — target-URL assignment UX (keyword → URL)
  is a dashboard follow-up, not a v1 surface.

## 13. Deferred (recorded)

- Scheduled SEO sweeps (cadence) — ride the P9 social calendar's scheduling semantics.
- Keyword → target URL assignment UI + click-through tracking.
- Search-console/keyword-volume integrations (real volume data replaces est. fields).
- Notification fanout for high-risk recommendations (notification-policy pass).

## 14. Next per roadmap

**P9 — Social workforce (roadmap §466):** social_accounts (absorb channels + LinkedIn
account-ref fix), social_posts linked to content items, campaigns, platform variants,
scheduling calendar (time semantics, not cron pile), OAuth linking (SEC-L5), metrics
ingestion; IG/TikTok real adapters. Acceptance: one approved item → per-platform
scheduled posts; nothing publishes without approval unless policy later says so.
