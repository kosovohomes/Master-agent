# PHASE 2 — IMPLEMENTATION REPORT

**Project:** AgentOS → Multi-Website AI Workforce & AI Command Center (`kosovohomes/Master-agent`, branch `main`)
**Implemented:** Phase 2 — Agent Registry & versions, exactly per §11 P2 / §5.2 / §6 / §7 of `docs/PHASE-0.5-Final-Architecture-Reconciliation.md`
**Commits:** `53158d9` (Phase 2 foundation), `92ecc97` (CI round-1 fixes), `18f10c1` (customer_service prompt_hash attribution), + clientIp hardening commit
**Date:** 2026-09-11
**Status:** CI green · deployed to production · migrations 011–015 applied · acceptance criteria verified live

---

## 1. Executive summary

Phase 2 turned agents from hardcoded TypeScript constants into DATA. The registry (`agents`, `agent_versions`, `agent_tools`, `agent_permissions`, `business_unit_agents`, `agent_identities`) now owns the workforce directory: the four surviving current agents (research, marketing, sales, customer_service) are seeded active and bound to their existing executors, the fifteen remaining workforce roles are seeded disabled with placeholders (registry-first: the directory exists before each worker), and the ambassador — per the approved fold decision — is not a registry row at all; its executor survives as a prompt variant of the content path. The generic LLM executor ships with the registry: any row + one versioned prompt = a working agent with zero core-platform edits, which is the Phase 0.5 §6.4 extensibility invariant. Every run now carries full attribution (registry agent_id, business_unit_id, prompt_version_id, a REAL sha-256 prompt hash replacing the raw-topic placeholder of C-14, model, timing), failed executions are recorded as failed with an error class (retiring the always-`completed` audit finding), and enablement is layered (global status × per-BU enablement × `disable_agent:<slug>` emergency flag) so flipping a flag changes behavior within one run with zero deploys — verified live on production during acceptance. Two security items were pulled forward or hardened on tech-lead authority: the DB-backed rate limiter (Phase 3 → Phase 2; per-instance memory buckets gave no global brute-force guarantee) and the clientIp resolution (last XFF hop only — earlier hops are client-spoofable). SEC-L2 key-id envelope encryption for channel tokens is live with full v1 backward compatibility, and SEC-L1 RLS scaffolding is in place without behavior change. The widget contract never blinked: `acme-homes` resolves identically before and after. Nothing from Phase 3+ (task/workflow engine, job queue, tools with side effects, supervisor) was implemented.

## 2. What was implemented

1. **Migrations 011–015** (versioned, ledgered, additive): rate_limit_buckets; the six registry tables + registry seed + `agents.manage` permission; agent_runs attribution ALTERs + topic backfill; channels key-id envelope cutover point; RLS scaffolding.
2. **Registry service** (`lib/agents/registry.ts`): CRUD, immutable versioning, per-BU enablement, layered runnability checks, machine identities, prompt hashing.
3. **Executors** (`lib/agents/executors.ts`): bound executors delegating to the untouched legacy generators (byte-identical prompts) + the generic LLM executor.
4. **Registry-driven dispatch** with refusal (409, audited), full attribution, and failure recording.
5. **DB-backed rate limiting** (global fixed-window buckets) replacing per-instance memory.
6. **SEC-L2 envelope crypto** `v2:<key_id>:…` with v1 compat and a documented rotation path.
7. **Agents API + Command Center screen**: `/api/admin/agents`, `/api/admin/agents/versions`, `/agents` (status, per-BU enablement, prompt history), nav entry.
8. **C-13 cleanup**: dead `content_system_prompt` no longer read by any code path.
9. **clientIp hardening** (last-hop XFF).
10. **Tests**: 2 new suites (registry, agent-executor), 4 suites extended; CI runs 22 suites total.

## 3. What was intentionally NOT implemented (Phase 3+ scope)

The task/workflow engine, task_steps, job queue with claims, event bus, notifications, content_publications (Phase 3). Tools with side effects — agent_tools rows are registry metadata only; nothing executes them (Phase 3+). Supervisor autonomy, autonomy levels, plan decomposition (Phase 14; deterministic templates until then). The AI Gateway with token-accurate accounting and budgets (Phase 4; the daily cap remains a crude per-tenant counter). Knowledge v2 scoping (Phase 5). RLS FORCE + dedicated DB role (SEC-L1 full cutover, Phase 3/4). Website connectors and the Add-Website wizard (Phase 11). No destructive schema operations of any kind.

## 4. New files

- `lib/agents/registry.ts` — registry service (list/get/setStatus; currentVersion/listVersions/createAgentVersion; listBuAgents/setBuAgent; checkRunnable/buIdForLegacyTenant; identities create/list/revoke; promptHash).
- `lib/agents/executors.ts` — bound executor map + `makeGenericLLMExecutor`.
- `app/api/admin/agents/route.ts` — GET (registry + current versions; BU links via `?businessUnitId=`), PATCH (global status or per-BU enablement), agents.manage-gated, audited.
- `app/api/admin/agents/versions/route.ts` — GET history (?slug=), POST next immutable version.
- `app/(dashboard)/agents/page.tsx` — registry screen v1.
- `tests/registry-tests.ts`, `tests/agent-executor-tests.ts`.

## 5. Modified files

- `lib/migrations/definitions.ts` — migrations 011–015 appended; header updated.
- `lib/agents/core.ts` — routeAgent ambassador fold; recordRun rewritten (attribution columns, failure semantics, backward-compatible defaults); classifyError added.
- `lib/agents/dispatch.ts` — registry-driven execution; AgentNotRunnableError; attribution; failure recording; customer_service attribution; TenantCfg drops contentSystemPrompt (C-13).
- `lib/agents/generators.ts` — `channelHint` exported (single source, reused by executors); otherwise untouched.
- `lib/security/ratelimit.ts` — DB-backed buckets (async), probabilistic cleanup, clientIp last-hop.
- `lib/channels.ts` — v2 envelope with key id + v1 compat + rotation env keys.
- `app/api/agents/run/route.ts` — awaited limiter; AgentNotRunnableError → 409 audited.
- `app/api/auth/login/route.ts`, `app/api/v1/chat/route.ts`, `app/api/v1/channels/route.ts` — awaited limiter.
- `app/(dashboard)/layout.tsx` — Agents nav entry.
- `tests/run-all.ts` (+2 suites), `tests/ratelimit-tests.ts` (async DB buckets, clientIp, cross-suite resets), `tests/channels-tests.ts` (v2 envelope + rotation), `tests/dispatch-tests.ts` (attribution, fold), `tests/agents-routing-tests.ts` (fold), `tests/chat-tests.ts` (TenantCfg), `tests/publishers-tests.ts` (v2 regex, bucket reset), `tests/security-tests.ts`/`auth-tests.ts`/`audit-tests.ts`/`widget-tests.ts`/`admin-tests.ts` (bucket resets).
- Deleted: none. Renamed: none.

## 6. Migration detail

| # | Name | Contents |
|---|------|----------|
| 011 | rate_limit_buckets | `key TEXT PK, count INT, window_start TIMESTAMPTZ` |
| 012 | agents_registry | 6 tables (agents, agent_versions, agent_tools, agent_permissions, business_unit_agents, agent_identities) + seed (4 active bound; 15 disabled placeholders; version-1 golden prompts) + `agents.manage` permission → owner/administrator |
| 013 | agent_runs_attributes | 15 ADD COLUMNs (agent_id FK, business_unit_id FK, task_id, workflow_run_id, model, prompt_version_id FK, topic, started_at, completed_at, duration_ms, input_tokens, output_tokens, estimated_cost, error, error_class) + `UPDATE agent_runs SET topic = prompt_hash WHERE topic IS NULL` (C-14 backfill; 2 legacy rows) + 2 indexes |
| 014 | channels_key_id_envelope | Marker (`SELECT 1`) documenting the SEC-L2 cutover; envelope logic is self-describing in the wire format |
| 015 | rls_scaffolding | ENABLE RLS on business_units/websites + idempotent policies keyed on `current_setting('agentos.bu_id', true)` |

All are idempotent (IF NOT EXISTS / ON CONFLICT DO NOTHING / pg_policies guard) and safe to re-run. Re-run on production after apply: `applied: 011-015, skipped: 11, ledgerSize: 16` — no-op on second call.

## 7. Data backfills

- **C-14 topic backfill**: legacy `prompt_hash` content (raw topics) copied to `topic`; new runs write real sha-256 hashes into `prompt_hash`. Legacy rows keep both.
- **Registry seed**: 4 active agents + 15 placeholders + 4 version-1 rows; version-1 prompts are the exact legacy role lines (golden preservation, asserted by tests).
- No data was modified, moved, or deleted beyond the additive backfill above.

## 8. Registry design (§6.4 invariant)

Adding an agent = 1 `agents` row + 1 `agent_versions` row (+ optional tool/permission grants + optional executor binding) with ZERO core-platform edits, via two executor kinds: `bound` (TypeScript functions registered by slug — the pre-registry five) and `llm` (generic executor that runs any versioned prompt). The generic executor assembles prompts exactly like the bound path (version prompt + brand voice/persona/audience + channel hint + rules), so quality and attribution are uniform.

## 9. Enablement layers & acceptance (§11 P2)

Three layers govern runnability, checked on every dispatch in order: (1) `feature_flags.disable_agent:<slug>` emergency kill-switch; (2) `agents.status` (active/disabled/archived); (3) `business_unit_agents.enabled` per BU (absent row = follow global). Refusals raise `AgentNotRunnableError` → HTTP 409 `AGENT_NOT_RUNNABLE` with a stable detail code, audited as `denied`.

**Live production acceptance (executed 2026-09-11):** PATCH disabled marketing → `POST /api/agents/run` returned `409 AGENT_NOT_RUNNABLE / AGENT_DISABLED` (audited) → PATCH re-enabled → next run proceeded past the registry into the LLM call (500 = the known OpenAI quota blocker) — **flag flip propagated within one run, zero deploys**. Widget config for `acme-homes` remained 200 throughout.

## 10. Run attribution (§71 / C-14)

Every dispatch writes: agent (slug), agent_id, business_unit_id (resolved via `business_units.legacy_tenant_id`; NULL for unmapped tenants), prompt_version_id, prompt_hash (sha-256 of the rendered system prompt; customer_service/failures attribute to the agent's canonical prompt hash), topic, model (`OPENAI_MODEL` or default), started_at/completed_at/duration_ms, output_ref (`drafts/<id>`), status. Failed executions record `status='failed'`, `error` (truncated 2000), `error_class` (provider_quota | provider_request | provider_unavailable | timeout | internal). Token/cost columns exist but stay NULL until the Phase 4 Gateway captures provider usage.

## 11. Rate limiting (pull-forward decision)

The Phase 1 in-memory buckets were per serverless instance — demonstrated on production (12 rapid chats spread across instances, no 429) and dangerous for login brute-force. Phase 2 ships DB-backed fixed-window buckets: one atomic upsert (window reset + count in a single statement, row-locked) into `rate_limit_buckets`; fail-open on DB error (availability beats strictness; account lockout remains the credential-stuffing defense); ~1% probabilistic stale-row cleanup. Limits unchanged (login 10/5min, chat 10/min, run 5/min, channels 10/10min). Verified live: fixed-key flood → 429s.

## 12. clientIp hardening (this phase)

`clientIp` now returns the LAST `x-forwarded-for` hop. Vercel appends the edge-observed client to any client-supplied chain, so earlier hops are attacker-controlled; the old first-hop logic let clients rotate fake IPs to evade per-IP limits (demonstrated during verification). Single-hop chains and `x-real-ip` fallbacks are covered by tests.

## 13. SEC-L2 — channel token envelope

New ciphertexts are `v2:<key_id>:<iv>:<tag>:<data>`; legacy `iv:tag:data` payloads decrypt unchanged (no rewrite, no downtime). Rotation: set `CHANNEL_ENC_KEY_PREVIOUS`( + `_ID`) alongside new `CHANNEL_ENC_KEY`(+ `_ID`); old payloads resolve by id, new writes stamp the new id; unresolvable ids fail loudly. Tested: v1 compat, roundtrip, tamper, rotation, unknown-id failure.

## 14. SEC-L1 — RLS scaffolding

RLS enabled on business_units/websites with policies keyed on a session GUC for the future dedicated DB role. FORCE is deliberately NOT set: the application connects as table owner and app-level BU scoping (Phase 1) remains the enforced layer; the DB backstop activates with the role cutover (Phase 3/4). Zero behavior change; documented as scaffolding, not enforcement.

## 15. Agent dashboard v1

`/agents` lists the registry (name/slug/kind/executor/status/current version), supports Enable/Disable, per-BU enablement (default → disabled → enabled states), and read-only prompt history. Server-side enforcement everywhere: reads ride staff-read permissions, mutations require `agents.manage`, all mutations audited. The version editor ships with Phase 7 content screens.

## 16. API changes

New: GET/PATCH `/api/admin/agents`, GET/POST `/api/admin/agents/versions`. Changed: `POST /api/agents/run` may now return 409 `AGENT_NOT_RUNNABLE`; 429 behavior unchanged but now globally accurate. Removed: none. Breaking changes: none (the `content_system_prompt` field disappeared from internal types only — it was never part of any API response).

## 17. Dependencies

No new runtime dependencies. No dependency removals. Node built-ins (`node:crypto`) used for hashing.

## 18. Environment variables

No new REQUIRED vars. Optional: `CHANNEL_ENC_KEY_ID` (default k1), `CHANNEL_ENC_KEY_PREVIOUS`, `CHANNEL_ENC_KEY_PREVIOUS_ID` (default k0) — used only during key rotation. `DAILY_TENANT_LLM_CAP` unchanged.

## 19. Tests

New suites: `registry-tests` (19 checks: seed shape, golden prompts, versioning, status flip, kill-switch, per-BU enablement, legacy mapping, identities, permission grant), `agent-executor-tests` (16 checks: generic executor, prompt assembly, attribution incl. golden prompt_hash equality, failed-run recording, refusal contract). Updated: ratelimit (DB buckets, expiry, resets, clientIp last-hop), channels (v2 + rotation), dispatch (attribution + fold), agents-routing (fold), chat (TenantCfg), publishers (v2 regex), plus bucket resets in 8 route-exercising suites. CI: typecheck + migrations on ephemeral pgvector Postgres + all 22 suites + production build — green on the final commit.

## 20. CI rounds

Round 1 failed 5 suites (found and fixed: NOT NULL prompt_hash on failed-run records; kill-switch test key typo; topic assertion on the wrong call; v1-only ciphertext regex; cross-suite bucket accumulation — the suite processes share the DB-backed buckets now). Round 2 failed 1 suite (the customer_service dispatch path also needed prompt_hash). Round 3: green. Each fix is a deliberate, documented change — no test was weakened to pass.

## 21. Known limitations

1. Fixed-window buckets allow up to 2× limit across a boundary (abuse control only; the daily LLM cap is the billing control). 2. Token/cost columns await the Phase 4 Gateway. 3. RLS is scaffolding until the dedicated DB role lands. 4. The generic executor does not execute tools (registry rows only — by design until Phase 3+). 5. Ambassador persona variants are config, not a first-class agent; the router never selects the retained executor. 6. `agent_versions` has no activate-rollback endpoint yet (rollback = append a new version with prior content; UI shows history). 7. OpenAI quota remains unfunded — LLM-touching acceptance beyond the registry gate awaits credits.

## 22. Deviations from Phase 0.5

1. **DB-backed rate limiter pulled forward from Phase 3** (tech-lead decision, documented §11): global brute-force protection was a live gap. 2. **clientIp last-hop hardening** — not explicitly scheduled; required for limiter integrity. 3. **`agents.manage` permission added** — the Phase 0.5 permission list did not name a registry-management permission; adding one follows the established RBAC pattern rather than overloading `settings.manage`. 4. Ambassador fold implemented at the router (topics → marketing) with the executor retained as a bound prompt variant — the doc's "retained as a prompt variant" made concrete. No other deviations.

## 23. Verification summary

Production: migrations applied (ledger 16, no-op re-run); registry list via API shows 4 active + 15 disabled with version rows; flag-flip acceptance executed live (409 → re-enable → proceeds); audits present for every mutation and refusal; widget compat 200; owner login/session intact; DB-backed limiter 429s under fixed-key flood. CI: typecheck ✓, 22 suites ✓, build ✓ (30 routes). Local: tsc clean, build clean.
