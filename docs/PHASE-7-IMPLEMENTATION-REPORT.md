# Phase 7 — Implementation Report (Research Workforce)

**Status:** COMPLETE — CI green, production deployed, live acceptance ALL PASS.
**Commit:** `5b71523` (feat) · ledger 32 (migrations 029–031) · production READY.
**Roadmap:** Phase 0.5 §6.2 **P6** (MVP use case #1: daily AI/legal-AI intelligence, §137), executed as the user-ordered "Phase 7".

## 1. Executive summary

The platform now runs its first true agent workforce: four research agents
(`research`, `intelligence`, `legal_intelligence`, `competitor`) execute
scheduled research on a durable task pipeline — acquire material from
monitored sources (RSS/sitemap/page) plus optional web search, analyze it
through the versioned agent prompt via the AI gateway, and store cited,
scored findings with full citation provenance. Ambiguous or low-confidence
material escalates to a human (ops paged through the event bus); LLM
outages degrade gracefully to stored `unprocessed` material instead of
failing runs. A `/research` Command Center screen manages schedules,
findings review, and the competitor registry. Nothing research produces is
ever published — content remains approval-gated (P7 boundary, unchanged).

## 2. Scope decisions (tech lead)

- **User ordering honored:** "Phase 7" = roadmap P6 (the next unplanned
  phase after the Phase 6 connector delivery). MVP use case #1 pulls
  forward because it exercises task engine + gateway + knowledge fetchers
  — everything built in Phases 3–5 — end to end.
- **C-3 framework re-evaluation (the trigger fired here):** NO framework.
  The pipeline is a bounded tool loop by construction — fixed phase
  sequence, hard caps (6 queries / 10 results/query / 6 fetch legs / 12
  sources in prompt / ONE analysis call). This satisfies §7's "agents may
  call tools" with zero dependencies; the Phase 0.5 rationale (isolation
  without framework weight) held under pressure.
- **Acquisition is layered (live-acceptance learning):** public search
  engines block Vercel datacenter egress, so `web_search` contained to
  `[]` on production exactly as designed. Schedules therefore carry
  **monitored sources** (RSS/sitemap/page — fetched with the Phase 5
  machinery) as the deterministic backbone; web_search is the optional
  amplification leg (Brave via `SEARCH_PROVIDER`/`BRAVE_SEARCH_API_KEY`
  env, zero deploys). This also matches the real monitoring use case
  (daily legal/AI intelligence from named feeds).
- **Degraded ≠ failed:** an unfunded/outage LLM stores `unprocessed`
  material (full sources + excerpts) and the task still succeeds — the
  daily cadence never burns retries against a dead provider; the
  dashboard offers one-click reprocessing when the key is funded.

## 3. Architecture: the research pipeline

```
research_schedules (cron sweep, period-idempotent spawn)
  ↓  research_run task (durable, FK-linked, maxAttempts 3)
  ↓  [deterministic] flag gate (fail-closed skip) + context load
  ↓  [tools]        monitored sources: RSS/sitemap/page → excerpts
  ↓  [tools]        web_search per query (contained) + fetch top URLs
  ↓  [agent]        ONE structured-output call through the gateway
  │                 (attribution: BU+task+agent, purpose="research";
  │                  budget ceilings + llm_requests ledger inherited)
  ↓  [deterministic] dedup gate → store (status routing) → events
```

Status routing: clean → `finding` (feed); ambiguous or confidence < 0.35
→ `escalated` (ops paged); LLM unavailable → `unprocessed` (material
kept); human review: `verified` / `rejected` / `archived`.

## 4. Data model (migrations 029–031, strictly additive)

- **029 `research_workforce`:** `research_schedules` (BU, agent_slug CHECK
  workforce, topic `{{date}}`-templated, queries, cadence, max_items,
  UNIQUE (bu, name)); `research_items` (6-state CHECK lifecycle, title/
  summary/analysis jsonb, score 0–100, confidence 0–1, sources jsonb,
  material text, dedup_hash, prompt_version/prompt_hash, task_id FK,
  reviewed_at/by, **UNIQUE (business_unit_id, dedup_hash)** = the content
  gate); `competitors` (UNIQUE (bu, name)); `competitor_events` (kind
  CHECK, snapshot, research_item_id FK, detected_at); workforce trio
  activated (`intelligence`, `legal_intelligence`, `competitor` → active)
  with versioned v1 prompts; `research` gets the workforce prompt as a
  new version (golden v1 row preserved).
- **030 `research_flag_permissions`:** `research` flag (ON, kill switch)
  + `research.manage` permission → owner + administrator.
- **031 `research_schedule_sources`:** `research_schedules.sources` jsonb
  (monitored-source refs, max 6, kinds url/rss/sitemap).

Legacy 11/11 tables untouched; every migration is idempotent.

## 5. Tools layer (`lib/research/tools.ts`)

- **web_search provider seam** (mirrors lib/ai): `duckduckgo` (no key,
  parse-tolerant HTML endpoint) and `brave` (`BRAVE_SEARCH_API_KEY`).
  A failing search returns `[]` — one dead query never kills a run.
- **fetch_url** reuses the Phase 5 knowledge fetcher (timeout,
  content-type guard, byte cap, revision provenance) behind the research
  **SSRF guard**: http(s) only, loopback/private/link-local/`.internal`
  hosts and dangerous ports blocked — the agent cannot be turned into an
  internal-network prober.
- **fetch_rss / fetch_sitemap** legs for monitored sources (same guard).
- Hard limits encoded as `DEFAULT_TOOL_LIMITS` and asserted by tests.

## 6. Prompt + output contract (`lib/research/pipeline.ts`)

- Prompts live in `agent_versions` (data, not code); the pipeline reads
  the current version per slug and records `prompt_version` +
  `sha256(prompt_hash)` on every item (C-14 lineage).
- One JSON schema (`FINDING_SCHEMA`) validated by the Phase 4
  `completeJSON` validator with one repair retry: title, summary,
  score, confidence, ambiguous, implications/opportunities/risks/actions,
  competitorEvents[{competitor, kind, title, url, citations}].
- Sources are numbered `[n]` in the user prompt; citations in the finding
  reference those indices; `ambiguous=true` is the model's escape hatch
  instead of guessing (§109 dataset contract).

## 7. Storage + dedup (`lib/research/service.ts`)

- The DB is the dedup gate: `ON CONFLICT (business_unit_id, dedup_hash)
  DO NOTHING`; a duplicate is a **counted no-op** (`duplicates` in the
  task result), never an error. Hash = sha256(bu | slug | primaryUrl |
  topic) — cross-BU isolation holds (same story in two BUs = two items).
- Competitor events require a registry match (case-insensitive) on the
  tracked-competitor name — the pipeline never fabricates competitors.
- Escalations page ops via the event bus (`research.escalated`); clean
  findings emit `research.finding` (observable, non-paging).

## 8. Scheduling (`spawnDueResearchRuns`)

- Cadence math vs `last_run_at` (hourly/daily/weekly); spawn is
  idempotent per period: `research_run:<schedule>:<YYYY-MM-DD>` (hourly
  appends the hour) — a duplicate cron tick never double-spawns.
- The cron sweep route (`/api/agents/sweep`) spawns due schedules behind
  the `research` flag; the engine tick endpoint (or the daily cron floor)
  executes them. Run-now bypasses the clock (priority 10).

## 9. Reprocess path

`PATCH /api/admin/research/items/:id {action:"process"}` spawns a
research_run restricted to the stored material (no search/fetch): the
analysis re-runs, the SAME row is upgraded to finding/escalated, and
events fire with `reprocessed: true`. Rows without material auto-archive.

## 10. API surface (fail-closed, RBAC, audited)

| Route | Guard | Behavior |
|---|---|---|
| GET `/api/admin/research` | research.manage / audit.read | items + schedules + competitors + events + stats + flag |
| POST `/api/admin/research` | research.manage | create schedule (sources normalized server-side) |
| PATCH/DELETE `/api/admin/research/schedules/:id` | research.manage | update / delete (findings retained) |
| POST `.../schedules/:id/run` | research.manage | run-now; **409 `RESEARCH_DISABLED`** when flag OFF |
| PATCH `/api/admin/research/items/:id` | research.manage | verify/reject/archive/escalate/process; unknown action 400; process 409s (flag OFF / not unprocessed) |
| GET/POST `/api/admin/competitors` | manage / audit.read | registry (DUPLICATE → 409, case-insensitive) |
| PATCH/DELETE `/api/admin/competitors/:id` | research.manage | update / untrack (events cascade, findings kept) |

Every mutation is audited (`research.*` action namespace); no secrets
exist in this domain. The tasks read model now exposes `result` for
operations visibility.

## 11. Command Center screen (`/research`)

Schedules table (create with BU + workforce agent + topic + cadence +
monitored-sources textarea, run-now, pause/enable, delete), findings feed
(status badges, score, confidence, expandable analysis + numbered citation
links with revision ids, Verify/Reject/Archive), unprocessed items with
one-click Process now, competitor registry (track/untrack + detected
events log). Nav link gated by `research.manage || audit.read`.

## 12. Security review

- Routes session-guarded server-side (Phase 1 guards); execution
  endpoints fail closed on the flag (409), mutations on permission (403).
- SSRF guard blocks private/loopback/link-local/`.internal` and port
  22/25/5432/6379 for every tool-fetched URL — including search-derived.
- Bounded loop caps (6 queries / 6 fetches / 12 prompt sources) bound
  both cost and runtime; one analysis call per run, budget-enforced.
- Audit contains no secrets (asserted in tests + live acceptance).
- Research output never reaches any publishing path (no wiring exists).

## 13. Test evidence (41 suites, ALL PASS)

New suites: `research-tools` (SSRF matrix, DDG/Brave parsing, provider
switch, containment, limits), `research-pipeline` (§109 datasets: known
event → cited+scored finding; ambiguous → escalation; degraded mode;
competitor events; rss-leg with a dead search engine; query-plan dedup),
`research-service` (CRUD, due math, period-idempotent spawn, dedup gate,
cross-BU isolation, escalation routing + event paging, review
transitions, competitor matching, sources normalization), `research-tasks`
(flag-off skip, happy path on real task rows, dedup, degraded, reprocess,
disabled-schedule skip, missing-topic failure). Updated:
`migrations-tests` (16 tables / 7 flags), `registry-tests` (Phase 7
activation + relative version math + golden v1 rows), `publishers-tests`
+ `task-queue-tests` (shared-DB re-run hardening). Full suite verified
against the staging Neon DB with the complete env: **ALL SUITES PASS**.

## 14. Live acceptance (production) — VERIFIED

`scripts/phase7-live-acceptance.ts` against
`https://masteragent-nine.vercel.app` @ `5b71523`: **ALL PASS (31 checks)** —

- Real acquisition: TechCrunch + The Verge RSS fetched; **10 real sources
  collected** with real article URLs in citations.
- Degraded mode on the unfunded OpenAI key: task succeeded, `degraded:
  true`, unprocessed item stored with full material; **reprocess spawned**;
  dedup gate held on the unchanged second feed (counted in results).
- Registry: competitor created; case-insensitive duplicate → 409.
- Flag drill: OFF → run-now 409 `RESEARCH_DISABLED` → ON → restored.
- Audit: `research.schedule.create` + `research.schedule.run` rows; no
  secrets. Screens: 6/6 → 200. Cleanup: schedule + competitor removed.

## 15. Rollback map

- **Flag `research` OFF** → run-now/process 409, cron stops spawning,
  handler skips in-flight tasks. Zero code change, one flip.
- Legacy executors untouched: `agent_dispatch`, publishing sweep,
  knowledge fetch behave exactly as before (asserted by existing suites).
- Migrations are additive; dropping the phase = flag OFF + (optionally)
  the four tables remain inert.

## 16. Known limitations (recorded)

- Without a funded OpenAI key, findings stay `unprocessed` (material
  fully preserved); the daily loop collects and dedups — nothing is lost.
- `web_search` via the no-key DuckDuckGo provider returns `[]` from
  Vercel egress (contained). A Brave key upgrades it via env only.
- Competitor events fire only when the model returns structured events
  AND the competitor is tracked; unmatched names are skipped by design.
- Vercel cron is a daily floor: hourly schedules fire per tick endpoint
  cadence (an external pinger on `/api/agents/engine/tick` raises it).

## 17. Deferred (recorded)

- Intelligence-agent chaining (consuming research_items as input) lands
  with the content chain (roadmap P7 strategy→content→fact_check).
- Evaluation datasets beyond §109 (golden sets per BU) — P15 metrics.
- Real-time search via a paid provider is configuration, not code.

## 18. Next per roadmap

**P7 — Content workforce (MVP use case #2: research → content, §138):**
content_items/content_versions (9-state lifecycle, never-overwrite),
strategy→content→fact_check chain, approval center v2. REQUIRES a funded
OpenAI key for live verification — the research workforce already feeds
cited, scored, deduplicated input for it.
