# Phase 4 Implementation Report — AI Gateway & Cost Control

**Status:** COMPLETE — CI green, production deployed, live acceptance passed
**Commit:** `7d47656` (origin/main) · **CI:** run #17 success (typecheck + 29 suites + build, ephemeral pgvector Postgres) · **Production:** Vercel READY, migrations 020–022 applied (ledger 23, legacy 11/11 intact)
**Roadmap authority:** PHASE-0.5 §8, §24, §26, §41, §323, §352, §448–452 (P4)
**Date:** 2026-09-12

---

## 1. Objective

One controlled doorway for every completion and embedding in the platform (Phase 0.5 §135 P4): provider abstraction behind the existing `LLMClient` contract, budgets as first-class objects (SEC-L9), per-BU call-rate limits, retries + model fallback, a per-call usage/cost ledger (`llm_requests`), operator-editable pricing (`model_prices`), structured outputs + validation, and the embedding-dimension decision record — with cost per agent/BU/task/month visible and a runaway agent hard-stopped on budget.

## 2. What shipped (capability inventory)

| Capability | Implementation |
|---|---|
| Gateway (one doorway) | `lib/ai/gateway.ts` — `makeGatewayClient()` + production singleton `ai` |
| Provider abstraction | `lib/ai/providers/openai.ts` (moved from `lib/llm.ts` per §323; shim left one phase) |
| Usage/cost ledger | `lib/ai/usage.ts` + `llm_requests` table (migration 020) |
| Cost math as data | `lib/ai/prices.ts` + `model_prices` table (seeded 4 OpenAI price rows) |
| Budgets (SEC-L9) | `lib/ai/budgets.ts` + `budgets` table + `tasks.budget_usd` (migration 021) |
| Rate limits | per-BU LLM call rate via the Phase 1 DB-backed limiter (global, not per-instance) |
| Retry + fallback | retriable (429/5xx/timeout) failures walk the fallback model chain; every attempt ledgered |
| Timeout/abort | per-call `AbortController`, `LLM_TIMEOUT_MS` (default 60s) |
| Structured outputs | `lib/ai/structured.ts` — dependency-free JSON-Schema subset + `completeJSON` with one repair turn (§86–§87 seam) |
| Flag rollback | `ai_gateway` feature flag OFF = raw provider passthrough, zero deploys (migration 022 seeds it) |
| Cost visibility | `/api/admin/llm/usage` + **AI Gateway screen** in the Command Center |
| Budget management | `/api/admin/budgets` (GET/POST) + `/api/admin/budgets/[id]` (PATCH/DELETE) |
| Ops paging | `budget.hard_stop` event on the event bus → notification fanout (10-minute per-scope cooldown) |
| Run accounting | ledger rows back-linked to `agent_runs`; token-accurate `input_tokens/output_tokens/estimated_cost` on runs (§71's deferred P4 note) |

## 3. Architecture — the one doorway

```
call sites (executors, generators, chat, RAG)   ← unchanged; receive a plain LLMClient
        │
composition roots attach attribution:
  agents/run route → dispatch({ llm: ai })
  chat route       → ai.withAttribution({ businessUnitId, purpose: "chat_answer" })
  task engine      → dispatch({ ..., attribution: { taskId } })
  demo seed        → ai (embed ledgered as ingest)
        │
lib/ai/gateway.ts   flag gate → budget pre-check → per-BU rate limit
        │           → routing (opts.model > agent version config.model > env > default)
        │           → attempt chain [primary, ...fallbacks] with timeout/abort
        │           → every attempt → llm_requests (tokens, cost via model_prices, latency)
        │           → post-call over-budget detection → budget.hard_stop event
        ▼
lib/ai/providers/openai.ts  (the innermost adapter; no policy here)
```

**Zero call-site changes, grep-enforced.** `tests/call-site-grep-tests.ts` walks `lib/**` + `app/**` and fails the build if anything outside `lib/ai/**` + the `lib/llm.ts` shim imports the provider or constructs `makeOpenAI/makeLLM`. Executors/generators/chat call `ctx.llm.complete/embed` exactly as before.

## 4. Migrations (020–022, additive-first)

- **020 `ai_gateway_ledger`** — `llm_requests` (BU/agent/agent_slug/agent_run_id/task_id, provider, kind chat|embed, model, status `ok|error|budget_blocked|rate_limited`, error_code, prompt/completion/total tokens, `cost_usd NUMERIC(14,8)`, latency, attempt_no, purpose, metadata) + 4 indexes; `model_prices` (UNIQUE provider+model+kind, per-1K input/output USD) seeded with gpt-4o-mini, gpt-4o, text-embedding-3-small/large.
- **021 `budgets`** — first-class budget objects: `scope_type business_unit|agent`, `scope_id`, `period daily|monthly`, `limit_usd`, enabled, `UNIQUE(scope_type, scope_id, period)`; `tasks.budget_usd` column for per-task lifetime ceilings.
- **022 `gateway_flag_permissions`** — `ai_gateway` emergency feature flag (ON) + `llm.view` and `budgets.manage` permissions granted to owner + administrator.

Legacy contract: 11/11 legacy tables intact; no destructive DDL. `agent_run_id`/`task_id` are plain BIGINT (no FK) so the ledger can never be blocked by run-row lifecycle.

## 5. Attribution & run accounting

`dispatch()` now attaches attribution (`businessUnitId`, `agentId`, `agentSlug`, `taskId`, `purpose`) via the gateway's `withAttribution` before executing; plain test stubs without `withAttribution` pass through untouched (Phase 2 test seams preserved). After `recordRun`, dispatch (a) back-links the run's ledger rows via `linkRun` (attribution + since-window), (b) writes token-accurate totals onto `agent_runs.input_tokens/output_tokens/estimated_cost`. Known v1 limitation: two concurrent runs of the same agent share the attribution window, so run-level linking is best-effort under concurrency; BU/agent/task attribution is always exact.

## 6. Budgets model (SEC-L9)

- Spend source of truth = `SUM(llm_requests.cost_usd)` in period (daily = UTC midnight, monthly = UTC month start). Blocked rows cost 0 and never inflate spend.
- Pre-call hard-stop: first scope/period at-or-over limit throws `BudgetExceededError` BEFORE the provider call → audited 429 `BUDGET_EXCEEDED` (with scope/period/limit/spent detail) on the agents/run route, 429 on the public chat route.
- Post-call re-check: the call that crosses a budget pages ops via `budget.hard_stop` (event + notification through the task queue; 10-min per-scope cooldown prevents event floods). The NEXT call is hard-stopped.
- Per-task ceilings: `tasks.budget_usd` (lifetime per task) enforced in the same pre-check; the task engine passes `taskId` so engine-driven runs are covered.
- $0 limit = complete brake for a scope (proven live below).
- `agents` table has no legacy budget column (registry v1 shipped without one), so `budgets` is the single source — no dual-write ambiguity.

## 7. Routing policy

Resolution order: explicit `opts.model` (call site) → per-agent model from `agent_versions.config.model` (wired through the generic LLM executor) → `OPENAI_MODEL` env → `gpt-4o-mini` default. Fallback chain: `LLM_FALLBACK_MODELS` (comma list) appended after the primary; only retriable failures (429/5xx/timeout) walk the chain; non-retriable 4xx fail fast. Embeddings have NO fallback by design (dimension integrity of the 1536-d vector store outweighs availability).

## 8. Embedding decision record (roadmap §352, decided not built)

Decision: **stay on `text-embedding-3-small`, vector(1536), single-model storage.** Rationale: the crown-jewel `chunks` table + `search_chunks()` seam work and are test-proven; multi-model embedding storage (per-model columns/namespaces + dimension registry) is designed in the reconciliation doc but has no consumer until a second embedding model is actually needed. The `search_chunks()` seam is the swap point. Revisit trigger: a provider/model change request or RAG quality mandate. This record satisfies the P4 "embedding-dimension decision" deliverable.

## 9. Structured outputs (§86–§87 seam)

`completeJSON(client, messages, schema)` — system-prompt schema injection, fenced/preamble-tolerant JSON extraction, dependency-free validator (types, required, enum, nested objects/arrays, minLength/maxLength/pattern/minimum/maximum, additionalProperties), and ONE repair turn carrying validator errors back to the model. Result carries `attempts`/`repaired` for audit. Phase 6 contract consumers build directly on this seam.

## 10. Error surface (HTTP contract)

| Condition | Route behavior |
|---|---|
| `AgentNotRunnableError` | 409 `AGENT_NOT_RUNNABLE` (unchanged, Phase 2) |
| `BudgetExceededError` | 429 `BUDGET_EXCEEDED` + scope/period/limit/spent detail, audited denied |
| `LlmRateLimitedError` | 429 `LLM_RATE_LIMITED` + Retry-After, audited denied |
| `LlmProviderError` (all attempts failed) | 502 `PROVIDER_FAILED` (attempts count only — no provider detail leak), audited failure |
| gateway flag OFF | passthrough — pre-Phase-4 behavior exactly |

## 11. Security posture

- Both new permissions are server-enforced at the API (`requirePermission`/`requireAnyPermission`); the Gateway screen is shell-gated + nav-filtered like all others.
- Budget/rate-limit/ledger checks run inside the gateway for BOTH authenticated runs and the public widget chat path (chat embeds + answers attribute to the caller's BU).
- No secrets in the ledger: `llm_requests` records error codes, never API keys or raw provider payloads.
- Provider failures return fixed detail strings (`all N model attempt(s) failed`) — no provider error text echoed to clients.
- The gateway fails OPEN to gateway-behavior if the flag read errors (provider errors still surface; no silent bypass of budgets).

## 12. Test coverage (29 suites total; 4 new)

- **gateway-tests** — flag OFF = passthrough with zero ledger rows; forced-429 → fallback serves the call with exactly one error row + one ok row (attempt numbers, provider error code, tokens, price-computed cost 0.04 = 1000×0.02 + 1000×0.02, latency, BU attribution, purpose); embed ledgered (kind=embed, 2 texts → 100 input tokens); $0 budget → `BudgetExceededError` + `budget_blocked` row + `budget.hard_stop` event; disabled budget releases; per-BU rate limit (limit 1 → 2nd call `LlmRateLimitedError` + rate_limited row); all-attempts-fail → `LlmProviderError` with 2 attempts; `linkRun`/`runTotals` accounting.
- **budgets-tests** — first-class objects (upsert idempotent per scope+period, re-price keeps identity, daily ≠ monthly), ledger spend sums, blocked rows don't inflate spend, monthly/daily hard-stop independence, disabled budgets pass, per-task lifetime ceiling (`tasks.budget_usd`), post-call over-budget detection, event cooldown predicate, delete.
- **structured-tests** — validator matrix (happy path + 5-violation object), integer/number distinction, pattern/enum/required, `completeJSON` repair turn (asserts the validator complaints reach the model), first-try success, retry exhaustion.
- **call-site-grep-tests** — no provider imports/constructors outside `lib/ai/**` + shim; composition roots import the gateway surface (4 found: run route, chat route, demo-seed, task executors).
- Existing 25 suites unchanged and green (incl. dispatch tests with plain stub clients — the withAttribution guard keeps them valid).

## 13. CI stabilization rounds

1. **Round 1** (`e4f740e` → fixes `3affba0`): flags-seed count assertion updated to 4 (migration 022 adds `ai_gateway`); budget SQL precedence bug (`WHERE enabled AND a OR b` → `WHERE enabled AND (a OR b)` — the OR branch could read disabled budgets); gateway flag-off test used the 429-model; budgets test math (hard-stop needs spend ≥ limit — re-price path added).
2. **Round 2** (`3affba0` → `ba3bd85`): gateway suite ledger assertions now go through `withAttribution` clients (unattributed calls write NULL attribution, so the slug-filtered queries found nothing).
3. **Round 3** (`ba3bd85` → `84c633a`): budget-release assertion used the succeed-model (no fallback chain configured on that client).
4. **Round 4** (`84c633a` → `7d47656`): `linkRun` test moved to a dedicated BU (window isolation from earlier attributed rows). **CI GREEN.**

## 14. Production acceptance (live evidence)

- **Migrate:** `POST /api/admin/migrate` → applied `[020 ai_gateway_ledger, 021 budgets, 022 gateway_flag_permissions]`, ledger 23, skipped 20, legacy 11/11.
- **Ledger proof:** agent run (research topic) → 502 `PROVIDER_FAILED` → `llm_requests` row: research / chat / gpt-4o-mini / error / `credit_balance_exhausted` / attempt 1, attributed to Acme Homes. Usage API: totals, byAgent `[research, 1]`, byBu `[Acme Homes, 1]`. Audit: `agents.run` failure with `provider_failed`.
- **Budget hard-stop:** `$0` daily budget on BU 1 → next run → **429 BUDGET_EXCEEDED** `{scope: business_unit#1, period: daily, limitUsd: 0, spentUsd: 0}` pre-provider → `budget_blocked` ledger row (`error_code BUDGET_EXCEEDED`, model `pre-call`) → `budget.hard_stop` event on the bus with full payload. PATCH disable → run proceeds (to the known quota failure); DELETE cleans up.
- **Flag rollback:** `ai_gateway` OFF → run → ledger calls 2 → 2 (zero rows; raw passthrough) → ON → run → row 3 ledgered (`sales / error / credit_balance_exhausted`). Zero deploys both ways.
- **Permissions live:** `/api/auth/me` for the owner now includes `llm.view` + `budgets.manage`.
- **Regressions:** `/gateway` 200 (new screen), `/operations` 200, `/login` 200, widget config `?tenant=acme-homes` 200, chat endpoint 500 = the pre-existing OpenAI-quota blocker (unchanged semantics; the gateway now attributes and ledgers those failures instead of swallowing them).

## 15. New environment variables (all optional)

| Variable | Default | Meaning |
|---|---|---|
| `LLM_FALLBACK_MODELS` | *(empty)* | Comma-separated fallback chain for retriable chat failures |
| `LLM_TIMEOUT_MS` | `60000` | Per-call provider timeout (abort) |
| `LLM_RATE_PER_MIN` | `120` | Per-BU gateway calls per minute (0 = off) |

## 16. Deferred decisions (tech-lead calls, documented)

- **`tenants` → compatibility VIEW / `outbox` drop (roadmap cleanup items):** deferred — both require DROP TABLE on legacy tables, violating the standing additive-first discipline. They ride a dedicated cleanup phase with owner sign-off. The write-stop on `outbox` (Phase 3) remains; rows stay as archive.
- **Streaming:** deferred per §352 (no UI consumer yet).
- **Moderation:** Phase 15 content-safety pipeline per roadmap.
- **Per-agent model UX:** registry screen config editing for `agent_versions.config.model` arrives with the registry UI iteration; the gateway seam already honors it.

## 17. Owner action items (unchanged blockers)

1. **OpenAI credits** — every LLM path currently fails with `credit_balance_exhausted`. The gateway now makes these failures *visible and attributable* (error rows + 502s + failed runs), but real completions need funded credits. This also unlocks live chat answers and P5 embedding verification.
2. **Resend domain verification** (or set ops email to a verified address) — `budget.hard_stop` and other ops notifications materialize as `suppressed` rows until then (observable, not blocking).

## 18. Next phase (per roadmap §456)

**P5 — Knowledge system v2:** five-scope authorization on knowledge (website/jurisdiction/…), metadata + legal fields, fetchers (URL/sitemap/RSS→PDF/DOCX/CSV), hybrid retrieval, chunking upgrade, knowledge admin UI. Tests: five-scope leak matrix; zero jurisdiction cross-contamination. Rollback: retrieval seam keeps the legacy path behind a flag. Note: P5's *build* is CI-verifiable with stub embedders; its *live* verification needs funded OpenAI credits (embeddings).
