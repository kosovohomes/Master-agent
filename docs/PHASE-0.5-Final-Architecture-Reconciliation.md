# PHASE 0.5 — FINAL ARCHITECTURE RECONCILIATION & IMPLEMENTATION BLUEPRINT

**Project:** AgentOS → Multi-Website AI Workforce & AI Command Center (`kosovohomes/Master-agent`, branch `main`, reconciled at HEAD `52f32e6`)
**Date:** 2026-09-11
**Status:** Architecture decision document. **READ-ONLY PHASE — no source files, schema, environment variables, dependencies, APIs, authentication, or deployment configuration were modified. No migrations, commits, or branches were created.**

**Read-only attestation (this phase):** the only repository operations performed were file reads, `rg`/`wc` searches, and a `git status`/`git diff --stat` check confirming the working tree remains content-identical (67 mode-only diffs, 0 insertions/deletions). All conclusions below are decisions, not implementations. Nothing in this document may be treated as authorization to change code until the owner approves Phase 1.

---

## 0. INPUT REGISTER & READING VERIFICATION (STEPS 1–2)

This reconciliation was produced from exactly six inputs. Each was re-read in this phase; nothing was relied on from memory or from the executive summary alone.

| # | Input | Location | Re-read in this phase | Verification result |
|---|---|---|---|---|
| 1 | Master Technical Architecture & Build Specification — Multi-Website AI Workforce & AI Command Center (v1.0, 4,218 lines, §1–§167 + Phases 0–16) | `upload/Master Technical Architecture….md` | Full structural pass + complete reads of §1–§57, §58–§79, §80–§117, §118–§134, §135–§167 | Treated as TARGET. Not reinterpreted to fit AgentOS |
| 2 | Universal Build Rules | **No standalone file exists** in the repo, `upload/`, or `download/` | Searched repo-wide (`rg -i "universal build"`, doc-tree inspection) | **Disposition:** the operative build-rules corpus exists inside the Master Architecture — §120 (one platform + configuration + connectors), §152 (AI coding agent implementation rules, 15 rules), §153 (existing-website modification rule), §154 (approval before destructive change), §155–§156 (env/config management), §158–§159 (human oversight, operating model), §164–§165 (implementation order, critical rule) — plus the standing owner directives from the Phase 0 and Phase 0.5 instructions (read-only gates, no hard-coding of seed businesses, approval-controlled publishing). This mapping is ratified in §14 of this document (contradiction C-18) and flagged for the owner to confirm or supply the standalone text. It does not block Phase 1 because every rule is already enforced by the roadmap in §12 |
| 3 | PHASE-0-Architecture-Rebaseline-Codebase-Audit.md (975 lines, 22 sections + 2 appendices) | `download/PHASE-0-Architecture-Rebaseline-Codebase-Audit.md` | Read in full (all 22 sections) | Every load-bearing conclusion re-verified against source (below). Two administrative corrections noted: C-17 (phase numbering) and the audit's interim "Phase 0.5 security gate" is re-homed as Phase 1 Milestone 0 |
| 4 | AgentOS source code + database structure (HEAD `52f32e6`) | `/home/z/my-project/agentos` | Direct reads this phase: `lib/migrations.ts`, `lib/db.ts` (per audit), `lib/admin.ts`, `lib/security.ts` (imports), `lib/llm.ts`, `lib/agents/{catalog,core,dispatch,generators,approval,publishers/index}.ts`, `lib/rag/*` (per audit), `lib/demo-seed.ts`, `lib/widget.ts` (per audit), all 11 API routes, 3 pages, `public/widget.js`, `vercel.json`, `package.json` | Audit confirmed with zero substantive discrepancies. Spot-verified: keyword router + silent marketing default (`lib/agents/core.ts:4-24`); `recordRun` always writes `status='completed'` (`core.ts:34-39`); `promptHash = goal.topic` raw string (`dispatch.ts:29`); `content_system_prompt` selected but never consumed (`dispatch.ts:13`, repo-wide grep); `LLMClient` discards `usage`, no timeout/retry, hardcoded `api.openai.com` (`lib/llm.ts:22-52`); channels wire-up performs zero authorization and `ON CONFLICT DO UPDATE` overwrites tokens (`app/api/v1/channels/route.ts:10-33`); LinkedIn `author: p.target ?? "urn:li:person:unknown"` and `sweepDue` declares `target` but never selects it (`publishers/index.ts:58,84-86`); sessionStorage plaintext password (`app/admin/login/page.tsx:14`); `vector(1536)` + ivfflat (`lib/migrations.ts:61-65`); no `CHECK` on `drafts.channel` (`migrations.ts:84`); cron `30 3 * * *` (`vercel.json:3`) |
| 5 | AGENTOS-RUNBOOK.md (158 lines) | `agentos/AGENTOS-RUNBOOK.md` | Read in full; every claimed contradiction re-checked against code | 4 contradictions confirmed (C-9..C-12 in §14): "every 15 min" (lines 26, 107) vs actual daily cron; chat example uses `"message"` (line 108) vs API requires `question` (`chat/route.ts:10,16`); `PATCH /api/admin/drafts/[id]` (line 120) vs POST-only route; deployed URL `agentos-nine` (line 3) vs production alias `masteragent-nine` |
| 6 | seed-demo implementation | `lib/demo-seed.ts` + `scripts/seed-demo.ts` + `POST /api/admin/seed` | Read in full | Verified: idempotent upsert pattern, undefined-filter fix, demo data (`acme-homes`) is **data-only** (no hard-coding in platform code), and the seed comment "topic wording matters — the router is keyword-based" (`demo-seed.ts:23-24`) is itself evidence of the classification limitation resolved in Step 8 |

**Phase 0 audit verification note (Step 2 mandate: "Do not rely only on the executive summary"):** all seven Critical/High security findings (S1–S6), all seven risks (R1–R7), the 11-table schema analysis, the agent-architecture findings (§2.7/§6), the orchestration gap (§7), the gateway gap (§8), the RAG assessment (§9), the tenancy analysis (§12), and the documentation contradictions (§16) were re-confirmed directly against source this phase. The readiness score **43/100** and the Option-A incremental strategy are **ratified unchanged**. No Phase 0 conclusion was found to be wrong; two require administrative restatement (§14, C-17) and one requires a precision improvement (the `tenants → business_units` migration mechanics in Step 6 of this document replace the audit's rename-based sketch with a strictly additive create-and-map design).

---

## 1. HEADLINE RECONCILIATION VERDICTS

1. **AgentOS is the foundation. No rewrite.** Option A (incremental in-place evolution) is confirmed as the migration strategy, with the security gate as the first work package of Phase 1 rather than a separately numbered phase (C-17).
2. **The reconciliation produces zero irreconcilable conflicts.** Every divergence between the Master Architecture and AgentOS resolves to KEEP / MODIFY / REPLACE / ADD / DEPRECATE with an additive, reversible path. The one input gap (standalone Universal Build Rules) is a documentation issue, not an architecture issue (C-18).
3. **Five subsystems are replaced outright** (shared-password auth, unauthenticated channel wire-up, outbox-as-queue, agents-as-code catalog, one-page admin UI). **One subsystem is demoted** (keyword router → classifier step inside the workflow engine). **Everything else survives in whole or in part.**
4. **The behavioral invariant "generation autonomous, publication human-gated" is preserved verbatim** and becomes the seed of the target Policy Engine (Master Arch §45–§49). No phase in this roadmap may introduce an autonomous public-publish path.
5. **Phase 1 is defined precisely** (§13 of this document) and becomes the Phase 1 implementation prompt upon owner approval.

---

## 2. STEP 3 — FULL RECONCILIATION MATRIX

Legend — **Reusable?**: Yes / Partial / No (does existing AgentOS work survive into the target). **Phase** = this document's roadmap (§12). **Risk** = risk of the required change. Master Arch section numbers cited as §.

| # | Target Requirement | Current AgentOS | Reusable? | Required Change | Phase | Risk |
|---|---|---|---|---|---|---|
| 1 | Users | None. One shared `ADMIN_PASSWORD` (`lib/admin.ts:5-8`) | No | `users` table, email+password (scrypt), statuses, audit columns | 1 | Low |
| 2 | Authentication | Password == bearer token, replayed from `sessionStorage` (`app/admin/login/page.tsx:14`) | Partial — timing-safe compare (`lib/security.ts`) reused | Replace with server-side sessions: httpOnly Secure SameSite cookie, `sessions` table, sliding expiry, logout; login brute-force protection | 1 | Medium |
| 3 | RBAC | None (§2.6 of audit) | No | `roles`, `permissions`, `role_permissions`, `user_roles`; 7 target roles (§74) seeded, Owner+Administrator+Reviewer active in Phase 1 | 1 | Medium |
| 4 | Permissions | None | No | Route→permission map module; `requirePermission()` guard wrapping every mutating API; agent permissions separately (#14) | 1 | Medium |
| 5 | Business Units | Flat `tenants` (id/slug/name/status) conflates org+website+brand+channels+knowledge (`lib/migrations.ts:12-26`) | Partial — row-scoping discipline and test net reusable | Create `business_units` additively with `legacy_tenant_id` mapping (never rename); backfill 1:1; add §9 fields (domain, industry, market, jurisdictions[], languages[], brand_voice, audience, business_goals, autonomy_level) | 1 | High |
| 6 | Websites | None | No | `websites` table (business_unit_id, domain, environment, framework, cms, api_endpoint, integration_status) per §10; Add-Website is configuration-only (§11) | 1 (schema) / 13 (wizard) | Medium |
| 7 | Website capabilities | None | No | `website_capabilities` grants (READ_CONTENT…READ_PRODUCTS, §12); enforced at connector layer | 13 (Phase 1 creates table) | Medium |
| 8 | Website integrations | `channels` rows are ad-hoc credentials | Partial — credential storage pattern reusable | `website_integrations` (site, kind, encrypted config, health, signing key); channels migrate into it + `social_accounts` (Step 6) | 13 (channels absorb) | Medium |
| 9 | Agents | 5 hardcoded TS constants, description-only (`lib/agents/catalog.ts:5-11`) | Partial — executor functions reusable | Registry rows + executor binding; catalog module becomes seed data | 2 | Medium |
| 10 | Agent Registry | Absent (code const) | No | `agents` table (slug, purpose, model_provider, model, autonomy_level, budget_limit, timeout, status) enableable per BU (§20–§21) | 2 | Medium |
| 11 | Agent versions | None; `prompt_hash` stores raw topic (`dispatch.ts:29`) | No | `agent_versions` (system_instructions, output_schema, version, changelog); per-run version attribution | 2 | Medium |
| 12 | Agent tools | None — agents receive no tools (audit §2.7) | No | `agent_tools` + Tool Registry with schema/validation/logging/timeout/rate-limit (§31) | 2 (tables) / 3–6 (tools) | High |
| 13 | Agent permissions | None | No | `agent_permissions` (allow/deny per capability, §32); checked in execution loop | 2 | High |
| 14 | Agent autonomy | None (publish always human-gated — the good default) | Partial — default posture matches Level ≤2 | `autonomy_level` 0–5 columns on agents + business_units; conservative defaults; enforced by Policy Engine | 2 (column) / 15 (engine) | High |
| 15 | Tasks | None | No | `tasks` with §24 fields + status machine incl. WAITING_APPROVAL/ESCALATED | 3 | High |
| 16 | Task steps | None | No | `task_steps` (ordered, status, output_ref) | 3 | Medium |
| 17 | Workflows | Sweep loop + dispatch function are proto-workflows | Partial — both become Workflow #1 and task executor | `workflows` (definition, trigger type, config) per §25–§26; deterministic engine | 3 | High |
| 18 | Workflow runs | None | No | `workflow_runs` (workflow_id, status, started/completed, error, trigger) | 3 | Medium |
| 19 | Events | None | No | `events` table + in-process bus; §95 event names; notification subscribers | 3 | Medium |
| 20 | Scheduler | Vercel cron daily `30 3 * * *` (`vercel.json:3`) | Yes — trigger mechanism works | Keep as workflow trigger #1; resolve sub-daily strategy (Pro plan or external scheduler) at Phase 3 | 1 (keep) / 3 (expand) | Low |
| 21 | Supervisor | Keyword router is the de-facto orchestrator (`core.ts:9-25`) | Partial — router demoted to deterministic classifier step | Supervisor agent (§22, §57): plan → task graph → delegate → monitor → escalate; bounded permissions; handoff logging (§23) | 14 | High |
| 22 | AI Gateway | `lib/llm.ts` 57-line OpenAI client, injectable seam | Partial — becomes the innermost provider adapter | Gateway wrapper (§41): routing, budgets, rate limits, timeout/abort, retry+fallback, usage capture, request logging (Step 9) | 4 | High |
| 23 | Model providers | OpenAI only, URL hardcoded | Partial — `LLMClient` interface is the adapter contract | `AIProvider` abstraction (generate/stream/embed/moderate §42); OpenAI adapter first; Anthropic/Google/open-weight adapters as demand lands | 4 | Medium |
| 24 | Token usage | `usage` field discarded (`llm.ts:35-36`) | No | Capture per call into `llm_requests` (provider, model, tokens, latency, run_id) | 4 | Low |
| 25 | Cost tracking | None | No | estimated_cost from usage × price table; dashboards per agent/BU/workflow/task/month (§44) | 4 | Medium |
| 26 | Budgets | None | No | budget_limit on agents + tasks + BUs; gateway enforces before call; hard-stop + notify | 4 | High |
| 27 | Rate limits | None anywhere | No | Phase 1: per-IP + per-tenant on public endpoints (closes S2/S3 volume); Phase 3–4: six §78 levels | 1 (basic) / 3–4 (full) | Medium |
| 28 | Knowledge sources | `content_sources` (sitemap/upload/api kinds, no fetcher) | Partial — row model + dedup pattern reusable | `knowledge_sources` with source_type/url/title/authority_level(1–5)/jurisdiction/language/refresh/status (§17–§18); real fetchers | 5 | Medium |
| 29 | Documents | `documents` (checksum dedup) | Yes — checksum dedup test-proven | Extend with jurisdiction/language/document_type/access_level/effective dates/verification (Step 10) | 5 | Medium |
| 30 | Chunks | `chunks` + pgvector ivfflat, tenant-scoped (`migrations.ts:56-65`) | Yes — crown jewel; test-proven isolation | Add scope columns (jurisdiction/language/access/agent_scope); keep vector(1536) now; multi-model embedding strategy decided at Phase 4 (Step 6 note) | 5 | Medium |
| 31 | Embeddings | `text-embedding-3-small` via `ctx.embed` injectable | Yes — provider-agnostic seam survives gateway unchanged | Route through gateway; keep 1536-d; `search_chunks()` seam isolates dimension change | 4–5 | Medium |
| 32 | Retrieval | Cosine top-K, tenant filter only (`retrieve.ts`) | Partial | Hybrid: semantic + tsvector keyword + metadata + jurisdiction + authority + date filters (§19); scope-resolution service (§16) | 5 | Medium |
| 33 | Research | "research" agent = copywriter from topic string, no sources (audit §6.2) | Partial — executor shell reusable | Real Research Agent per §52 contract: findings, sources, confidence, scores; research_items storage; scheduled pipeline | 6 | High |
| 34 | Intelligence | None | No | Intelligence Agent (§53): implications/opportunities/risks/actions; consumes research_items | 6 | Medium |
| 35 | Competitor intelligence | None | No | competitors/competitor_events (+snapshots) entities (§59) | 6 | Medium |
| 36 | Content | `drafts` single-row artifact + FSM | Partial — FSM + generator reusable | content_items/content_versions (9-state lifecycle §60, never-overwrite §61); strategy→content→fact-check chain | 7 | High |
| 37 | SEO | None | No | SEO Agent + keyword intelligence + gap analysis (§135 Phase 8) | 8 | Medium |
| 38 | Social | Publishers + draft queue; IG/TikTok draft-only | Partial — adapter pattern + sweep machinery reusable | social_accounts (absorbs channels, fixes LinkedIn account-ref), social_posts linked to content, campaigns, calendar, OAuth, metrics (§62) | 9 | High |
| 39 | Marketing | Marketing generator (brand-voiced drafts) | Partial — good behavioral seed | Campaigns, audience analysis, performance monitoring (§135 Phase 10) | 10 | Medium |
| 40 | Sales | Sales generator drafts outreach; lead insert dead-coded (`prospect` never passed by route — audit §6.2) | Partial | Sales Agent per §55: classification, lead_score, next_action, escalation; Lead Agent; inquiry integration | 11 | Medium |
| 41 | Customer support | RAG-grounded `answerChat`, citations, refuses fabrication (`chat.ts:5-24`, test-proven) | Yes — strongest reusable agent behavior | Split into customer_inquiry + customer_support registry agents; add conversation persistence + escalation | 11 | Medium |
| 42 | Leads | `leads` 5 stages, free-text source (`migrations.ts:97-108`) | Partial — extend in place | Add score, website_id, assigned_agent, human_owner, inquiry linkage; stage migration to §63's 6 stages | 11 | Low |
| 43 | Inquiries | None | No | `inquiries` (website/channel/customer/message/language/classification/priority/sentiment/lead_score, §64) | 11 | Medium |
| 44 | Conversations | None — chat is stateless | No | `conversations` storing user-visible messages + outcome + escalation; never internal reasoning (§65) | 11 | Medium |
| 45 | Approvals | Draft FSM + `approvals` rows, no reviewer identity, non-transactional, cascade-deleted with drafts | Partial — FSM semantics preserved | Approval Engine records (§48): reviewer, risk_level, requested_action, decision_reason, task linkage; transactional transitions; no cascade on audit | 1 (reviewer column) / 3 (engine) / 7 (approval center v2) | Medium |
| 46 | Notifications | None | No | Notification service (§96): dashboard + email first; priorities INFO→CRITICAL | 3 | Low |
| 47 | Analytics | None | No | Analytics Agent (§56), cross-BU dashboards with per-BU privacy (§99) | 12 | Medium |
| 48 | Goals | None | No | goals/goal_progress (§66); bounded autonomous loop (§67) | 16 | Medium |
| 49 | Recommendations | None | No | recommendations with reason/evidence/impact/confidence/cost/priority/required-approval (§104) | 12 (store) / 16 (loop) | Medium |
| 50 | Audit logs | Only `approvals` rows; ops endpoints unaudited; no reviewer identity | No | `audit_logs` (who/what/when/where/why/agent/tool/website/authorization/result, §72); written on every mutation | 1 | Low |
| 51 | Security | 3 unauthenticated mutation endpoints; shared password; no rate limits (S1–S4) | Partial — safeEqual, AES-GCM, generic-5xx, auth-before-parse are keepers | Security gate in Phase 1 M0 + identity/RBAC M1; full §73 model progressively (Step 5) | 1 | High |
| 52 | Secrets | AES-256-GCM channel tokens; single global key, no key-id/rotation (`lib/channels.ts`) | Yes — crypto primitive correct | Envelope format with key-id for rotation; agents never see raw credentials (§33–§34) | 2 (key-id) / 9 (OAuth) | Medium |
| 53 | Webhooks | None (inbound) | No | Signed webhooks: HMAC signature + timestamp + replay protection + rotation (§77) | 13 | Medium |
| 54 | Website connectors | Widget embed is the only site integration | Partial — widget becomes connector #1 | WebsiteConnector interface (getContent/createDraft/publishContent/getLeads/getAnalytics/getSiteStatus §35) + adapters per §36; contract in Step 11 | 13 | High |
| 55 | Multi-website isolation | Application-level `WHERE tenant_id` only; consistent + tested, no RLS | Partial — test discipline is the template | BU/Website scoping columns; RLS evaluated before multi-BU data exists; cascade audit; §101 customer isolation via website ownership | 1–2 | High |
| 56 | Human oversight | Approve/reject/schedule queue (works; one page) | Yes — keep the interaction model | Command Center (§80–§82): dashboard, websites, workforce, intelligence, content, sales, knowledge, analytics, approvals, integrations, security, settings; emergency controls (§79) | 1 (shell) → 16 | Medium |
| 57 | Controlled autonomy | Approval-always for public actions (by construction) | Partial — correct default; no levels/policy machinery | Autonomy levels 0–5 (§45), action risk classes (§46), Policy Engine (§49–§50), evaluation gates (§105, §110) | 15 | High |

**Matrix roll-up:** Reusable **Yes 9** · **Partial 33** · **No 15**. The 15 "No" rows are all *additions* (tasks, workflows, events, registry, RBAC, gateway properties, connector machinery) — none requires discarding a working subsystem. The 33 "Partial" rows survive via bounded modification or wrapping. Risk concentrates in five rows: #5 (BU migration), #12–#14 (tools/permissions/autonomy), #22 (gateway), #54 (connectors).

---

## 3. STEP 4 — SUBSYSTEM DISPOSITION (KEEP / MODIFY / REPLACE / DEPRECATE / REMOVE)

Classifications: **A. KEEP AS-IS** · **B. KEEP WITH MODIFICATION** · **C. WRAP / ADAPT** · **D. REPLACE** · **E. DEPRECATE** · **F. REMOVE LATER**. "Why" is evidence-backed; phase references are to §12.

| Subsystem | Class | Why | Phase |
|---|---|---|---|
| `pg` DB seam (`lib/db.ts`: pool, bigint parser, `transaction()`) | **A** | Correct, minimal, test-proven (commit/rollback paths); exactly what the target needs; also the natural RLS hook (`SET LOCAL`) later | — |
| Timing-safe security utils (`lib/security.ts` `safeEqual`) | **A** | Small, correct, tested; reused by every future guard | — |
| AES-256-GCM channel-token crypto (`lib/channels.ts`) | **A** (→ C at Phase 2) | Random IV, auth tag, tamper-tested. Only gap is no key-id for rotation — add envelope format when touched, don't preemptively rewrite | 2 |
| Publisher adapter pattern (`publishers/index.ts`: `Publisher` interface, per-channel adapters, health flip, injected fetch) | **A** | Direct seed of the target Integration Layer / adapter pattern (§34–§36); endpoints verified by tests; LinkedIn bug is a schema gap, not an adapter defect | — |
| Customer-service widget (`public/widget.js`) | **A** (→ C at Phase 11/13) | Dependency-free, CSP-safe, test-asserted, brand-safe config; implements §39–§40 "controlled interface" idea today. Later: site-registration binding + conversations | 11/13 |
| Test harness (14 suites, live-DB integration, DI stubs, self-cleaning fixtures) | **A** | The regression net that makes incremental migration safe; isolation tests become the template for scope tests | extended every phase |
| Uniform error contract (`{ errors: [{ code, detail? }] }`, generic 5xx) | **A** | Already target-grade API hygiene | — |
| RAG ingestion (`lib/rag/ingest.ts`) | **B** | Checksum dedup + embed-count guards are keepers; 800-char blind chunking must become structure-aware; needs fetchers (none exist) | 5 |
| RAG retrieval (`lib/rag/retrieve.ts`) | **B** | Cosine + tenant filter works and is tested; must gain hybrid keyword leg + scope filters (§16, §19) | 5 |
| Approval FSM (`lib/agents/approval.ts`) | **B** | State machine is correct and exhaustively tested — the single most valuable behavioral asset. Modify: reviewer identity, transactional transitions, risk level, no-cascade audit | 1/3/7 |
| `agent_runs` table + `recordRun` | **B** | Right idea; must open at start (not post-hoc 'completed'), add model/tokens/cost/duration/error/prompt_version columns, real status transitions | 2 |
| Schema management (`lib/migrations.ts` single DDL + CLI + Bearer endpoint) | **B** | Single-source-of-truth principle is right; convert the one string into ordered versioned migrations with a `schema_migrations` ledger (§114); endpoint stays as runner | 1-M0 |
| Demo seed (`lib/demo-seed.ts`, `POST /api/admin/seed`) | **B** | Idempotent, shared by CLI + endpoint, data-only (no hard-coded platform behavior); re-target from tenant → BU+website; keep as the migration's own acceptance test | 1 |
| Ops endpoints (migrate/seed/env-check, Bearer-guarded) | **B** | Valuable for no-terminal deployments; add audit rows per call, env separation, and keep them behind OPS_TOKEN only (drop ADMIN_PASSWORD fallback once sessions exist) | 1 |
| Cron + sweep route | **C** | Wrap as workflow trigger #1 + first job consumer; GET alias and secret gate stay until the Phase 3 engine replaces them | 3 |
| Agents (5 generator functions) | **C** | Become registry-bound executors: implementations never reference the registry; prompts move to `agent_versions`; retrieval context + budget/timeout wrappers added around, not inside, signatures | 2 |
| Keyword router (`routeAgent`) | **C** (demoted) | Too weak to remain the orchestrator (silent marketing default, no priorities/deadlines/budgets) but exactly right as a deterministic classifier step inside the Workflow Engine, with explicit FALLBACK/ESCALATE outcomes replacing the silent default | 3 |
| Dispatch loop (`dispatch`) | **C** | Signature maps 1:1 onto "execute task step T with agent A"; wrap in job runner; keep body | 3 |
| Chat route + `answerChat` | **C** | Grounding/citation contract preserved; becomes a thin façade over the task/run machinery + conversations persistence + rate limits + site binding | 11 |
| Widget config API (`lib/widget.ts`) | **C** | Keep brand-safe minimal shape; re-key from tenant to website registration when connectors land | 13 |
| LLM client (`lib/llm.ts`) | **C** | Becomes the innermost OpenAI provider adapter inside the AI Gateway; `LLMClient` interface is the provider contract; all `ctx.llm` call sites receive the gateway-wrapped client — zero call-site changes | 4 |
| Admin authentication (shared password == bearer, sessionStorage) | **D** | Architecturally incompatible with §73–§75 (no users, no expiry, no rotation, one password = every tenant, XSS-exfiltratable in sessionStorage). Replaced by users + sessions + RBAC | 1 |
| `POST /api/v1/channels` (auth-free wire-up) | **D** | Anyone on the internet can plant/overwrite publishing credentials for any tenant (S1). Replaced by authenticated integration management (session or signed integration key) | 1-M0 |
| `outbox` as publish queue | **D** | It is a post-hoc result log (no claims, no attempts, no idempotency); target needs `content_publications` + job-claim semantics (§28, §88). Existing rows kept as archive | 3 |
| `AGENT_CATALOG` as code const | **D** | Agents must be data (§20–§21, §83). Catalog module survives only as registry seed source | 2 |
| Hardcoded prompt templates (`generators.ts`) | **D** | Superseded by versioned `agent_versions.system_instructions` (§84–§85) | 2 |
| `/admin` one-page UI | **D** | Superseded by Command Center (§80); the approve/reject/schedule interaction survives as the Approvals screen | 1 (shell) → phased |
| `content_system_prompt` column | **E** | Dead config: selected into `TenantCfg` (`dispatch.ts:13`), never read by any prompt builder (grep-verified). Fold decision: wire into Phase 2 prompt model or drop; recommend drop | 2 |
| `prompt_hash` semantics (raw topic stored) | **E** | Misnamed field; replaced by real `prompt_hash` + `prompt_version` columns; legacy column backfilled as `topic` | 2 |
| `tenants` table | **E** (post-transition) | Preserved as legacy anchor through Phase 1–3 (widget contract depends on it); becomes a compatibility view; removed only after every reader is website/BU-keyed | 3→4 cleanup |
| `tenant_config` table | **E** | 1:1 satellite folded into `business_units` (brand_voice/persona/audience); low-risk retire once readers flip | 3 |
| `outbox` table | **F** | After `content_publications` cutover + archive export | 4 cleanup |
| `tenants` physical table | **F** | After widget/seed shims gone and all readers flipped | 4+ cleanup |
| `HANDOFF.md` | **F** | Stale historical snapshot (wrong HEAD, wrong cron, missing ops endpoints); archive | 1 (docs pass) |
| `docs/specs/2026-09-09-agentos-design.md` (as architecture-of-record) | **F** | Superseded by Master Architecture + this document; multiple unimplemented promises (approved_by, Arabic-safe normalization, per-tenant sessions, rate limiting, request IDs). Keep as historical rationale only | 1 (docs pass) |

**Explicit non-decisions:** no agent framework (LangGraph/OpenAI Agents SDK/n8n) is adopted in any phase by default — triggers for re-evaluation are defined in §12 Phase 6 and Phase 3 notes. No ORM, no auth library, no queue library unless a phase's risk note justifies one.

---

## 4. STEP 5 — SECURITY HARDENING GATE

Principle: **do not unnecessarily block development, but do not carry known-critical vulnerabilities across the Phase 1 boundary.** The gate is Phase 1 **Milestone 0** (see §13); identity/RBAC is Milestone 1. Items are split exactly as the mandate requires.

### 4.1 CRITICAL BEFORE PRODUCTION (must land in Phase 1; M0 before any new capability ships on top)

| ID | Item | Why it cannot wait | Resolution decided here |
|---|---|---|---|
| SEC-C1 | **Unauthenticated `POST /api/v1/channels`** (S1) | Internet attacker can plant/overwrite publishing credentials for any enumerable tenant → brand hijack, exfiltration-by-email | Guard with session auth in M0 (interim: existing ADMIN bearer accepted for ops CLI); replaced properly by `website_integrations` management (Phase 13) |
| SEC-C2 | **Unauthenticated `POST /api/agents/run`** (S2) | Unbounded OpenAI spend + approval-queue spam for any tenant | Session/API-key guard + per-IP and per-tenant rate limits + per-tenant daily LLM-call cap in M0 |
| SEC-C3 | **Unauthenticated `POST /api/v1/chat`** (S3) | Quota-burn + knowledge-phrasing oracle. **Cannot be auth-walled** — the widget is public by design | Mitigate, don't block: per-IP rate limits, per-tenant daily cap, per-website embed key binding (widget sends signed site token; server verifies origin binding), answer-length + depth caps. Full treatment at Phase 11 |
| SEC-C4 | **Shared `ADMIN_PASSWORD` as login + bearer, plaintext in `sessionStorage`** (S4) | No expiry/rotation/scoping; one credential = every tenant; XSS-exfiltratable | Phase 1 M1: users + httpOnly cookie sessions + password hashing; sessionStorage pattern deleted; ADMIN_PASSWORD retained only for the two ops endpoints until OPS_TOKEN-only cutover |
| SEC-C5 | **No audit logging** (S6) | Every admin/agent action unattributable; §72 unmet from day one of multi-user | `audit_logs` table + writer wired into every mutating route in M0 (including ops endpoints and approve/reject/schedule) |
| SEC-C6 | **Unversioned runtime DDL** | `/api/admin/migrate` applies a monolithic string; no ledger, no ordering, no rollback story — violates §114 before the first BU exists | Versioned migration runner + `schema_migrations` ledger in M0; every later phase lands as numbered migrations |
| SEC-C7 | **Approval transitions non-transactional + reviewer-less** (R5/S13) | Double-approve/publish windows widen once multiple operators exist | Wrap FSM transitions in the existing `transaction()` helper; add `reviewer_user_id` in M1 |

### 4.2 CAN BE IMPLEMENTED IN LATER PHASE (scheduled, not forgotten)

| ID | Item | Phase | Rationale for deferral |
|---|---|---|---|
| SEC-L1 | RLS policies + cascade audit (S10) | 1-M2 → 2 | Must land **before** multi-BU data exists; requires BU/Website schema first. No multi-BU data until Phase 1-M2 ships it, so the window is safe by construction |
| SEC-L2 | Key-id envelope encryption + rotation for channel tokens (S12) | 2 | Single-tenant reality today; must land before tenant count grows |
| SEC-L3 | Full six-level rate-limit matrix (§78) | 3–4 | M0 ships IP+tenant basics; per-agent/per-workflow limits need the engine to exist |
| SEC-L4 | Signed inbound webhooks (signature, timestamp, replay, rotation) (§77) | 13 | No inbound webhooks exist until connectors land |
| SEC-L5 | OAuth account lifecycle for social platforms | 9 | Replaces pasted tokens when social workforce lands |
| SEC-L6 | Brute-force lockout + session protection hardening depth (§73) | 1-M1 | Ships with sessions; depth (2FA, device binding) later |
| SEC-L7 | Data classification enforcement (§100) + customer-data isolation checks (§101) | 5 / 11 | Enforcement needs the classification columns and inquiry/conversation models |
| SEC-L8 | Emergency controls (§79) | 2 (flags v1: stop-all-agents, disable-publishing) → 3 (complete) | Flags need `system_settings`; stop-all is cheap and lands with feature flags |
| SEC-L9 | Spend budgets as first-class objects (agent/BU/task) | 4 | M0 ships a crude per-tenant daily call cap; real budgets ride the gateway |
| SEC-L10 | Agent machine identities (§75) | 2 | Real identity objects need the registry; until then agents run only via guarded routes |

**Deliberate posture:** SEC-C1..C7 are the entire "blocker" set. Nothing else blocks Phase 2–16 starts. Conversely, **no phase may ship a public, unauthenticated mutation endpoint ever again** — this is a standing acceptance criterion in every phase's test list.

---

## 5. STEP 6 — DATABASE REBASELINE

**Rules (binding on every phase):** (1) additive-first — every migration is `CREATE TABLE`/`ADD COLUMN` unless this document explicitly says otherwise; (2) never rename-and-hope — renames only via view/compat shims; (3) no destructive data loss ever; drops only in a cleanup phase after a documented cutover + archive; (4) every change is a numbered versioned migration with a ledger row (§114); (5) existing IDs — especially live tenant `491` and any deployed `data-tenant` attributes — must resolve at every intermediate step.

### 5.1 Existing 11 tables: CURRENT → TARGET → STRATEGY

| CURRENT TABLE | → | TARGET | Disposition | Migration strategy |
|---|---|---|---|---|
| `tenants` | → | `business_units` (+ `websites` children) | **ALTER-INTO-NEW (migrated, then deprecated)** | Do **not** rename. Phase 1-M2: create `business_units` with full §9 columns + `legacy_tenant_id BIGINT UNIQUE NOT NULL REFERENCES tenants(id)`; backfill one BU per existing tenant (`INSERT … SELECT`); create one `websites` row per BU (domain from BU, environment='production'). `tenants` remains the read anchor for the widget + existing code paths during transition. Phase 3: new readers key on `business_unit_id`/`website_id`; `tenant_id` derived as `legacy_tenant_id`. Phase 4 cleanup: `tenants` → compatibility VIEW over `business_units`; `tenant_config` folded. **ID preservation:** legacy tenant id 491 keeps resolving via the view (view exposes `id = legacy_tenant_id`-equivalent) and via `business_units.legacy_tenant_id` lookups |
| `tenant_config` | → | columns on `business_units` | **MIGRATE, then retire** | Copy `brand_voice`/`persona`/`audience` into BU columns in the M2 backfill transaction; `content_system_prompt` dropped (dead config, C-13). Table retired at Phase 3 reader-flip |
| `channels` | → | `social_accounts` (+ `website_integrations` for non-social) | **MIGRATE + RENAME (phased)** | Phase 1: add `target TEXT`, `metadata JSONB` (account ref, e.g. LinkedIn author URN; email recipient), `display_name` — additive, fixes R4's missing plumbing. Phase 9: create `social_accounts` (platform, account_ref, oauth tokens, health), copy rows with `website_id` resolved via tenant→BU→website, verify counts, then stop writing `channels`. Non-social kinds (`email`) become `website_integrations` rows |
| `content_sources` | → | `knowledge_sources` | **RENAME via view (phased)** | Phase 5: create `knowledge_sources` with §17–§18 columns (source_type, url, title, authority_level 1–5, jurisdiction, language, refresh_frequency, last_checked, status, business_unit_id, website_id nullable, access_level); backfill from `content_sources` (+ tenant→BU map); keep `content_sources` as view until Phase 6; kind expansion ('sitemap','upload','api','rss','url','github','db') via new CHECK |
| `documents` | → | `knowledge_documents` | **EXTEND in place, then rename** | Phase 5: ADD jurisdiction country/state_province, court, language, document_type, access_level, authority_tier, effective_date, source_date, source_url, provenance JSONB, verification_status, business_unit_id, website_id NULL-able (NULL = global per §14). Rename in the same migration that flips readers; checksum dedup logic unchanged |
| `chunks` | → | `knowledge_chunks` | **EXTEND with care** | Keep `vector(1536)` (decision: single model until a second provider is real). Add scope columns + `search_chunks()` SQL seam so dimension changes never leak into app code. If/when multi-model embeddings arrive: add per-model `chunk_embeddings(child)` table rather than widening this one (decision recorded, not implemented). ivfflat index retained; revisit HNSW at >1M rows |
| `agent_runs` | → | `agent_runs` (same name, richer) | **ALTER (additive)** | Phase 2: ADD agent_id (FK), business_unit_id, task_id NULL, workflow_run_id NULL, model, prompt_version_id, real prompt_hash, started_at, completed_at, duration_ms, input_tokens, output_tokens, estimated_cost, error, error_class (§71). Existing rows untouched; `prompt_hash`'s legacy raw-topic content backfilled to a `topic` column then column repurposed (C-14) |
| `drafts` | → | `content_items` + `content_versions` | **RESTRUCTURE (phased, non-destructive)** | Phase 7: create `content_items` (business_unit_id, website_id, type, lifecycle §60 9-state, created_by_agent, current_version_id) + `content_versions` (immutable copies). Migrate each draft → content_item + version 1; FSM state map: pending→DRAFT, approved→APPROVED, scheduled→SCHEDULED, posted→PUBLISHED, failed→PUBLISHED (with failed publication record), rejected→REVIEW. `drafts` kept read-only until cutover verified, then archived |
| `approvals` | → | `approvals` (extended) + `approval_actions` | **ALTER + stop-cascade** | Phase 1-M1: ADD `reviewer_user_id NULL`. Phase 3/7: ADD task_id, risk_level, requested_action, decision_reason; new approvals reference `content_items` **without** `ON DELETE CASCADE` (audit immutability, §72); `approval_actions` (edit-before-approve diffs) at Phase 7. Legacy rows retained |
| `leads` | → | `leads` (extended) | **ALTER + stage migration** | Phase 11: ADD score INT, website_id, assigned_agent_id, human_owner_id, inquiry_id, business_unit_id; stage CHECK replaced (new: new/qualified/contacted/follow_up/converted/lost) with data migration mapping responded→contacted, dead→lost inside one transaction; old CHECK dropped only after mapping verified row-count-identical |
| `outbox` | → | `content_publications` + job queue | **REPLACE; archive; then drop** | Phase 3: create `content_publications` (content_item_id, channel, external_id UNIQUE, published_at, attempted_at, error) with idempotency key + claim integration; Phase 3 cleanup: stop writing outbox; keep rows as archive; Phase 4: dump-to-archive + drop |

### 5.2 New target entities by phase (no migration written yet — the map only)

| Phase | Tables added |
|---|---|
| 1 | `schema_migrations`, `audit_logs`, `users`, `sessions`, `roles`, `permissions`, `role_permissions`, `user_roles`, `system_settings`, `feature_flags` (or settings-keyed), `business_units`, `websites`, `website_integrations` (structure), `website_capabilities` (structure), `rate_limits` counters (or in-memory + `tenant_usage_daily`) |
| 2 | `agents`, `agent_versions`, `agent_tools`, `agent_permissions`, `business_unit_agents` (enablement), machine `agent_identities` |
| 3 | `tasks`, `task_steps`, `workflows`, `workflow_runs`, `jobs` (queue), `events`, `notifications`, `content_publications` |
| 4 | `llm_requests` (usage/cost ledger), `model_prices`, budget columns |
| 5 | `knowledge_sources`, `knowledge_documents`, `knowledge_chunks` (evolutions above), `jurisdictions` reference |
| 6 | `research_items`, `competitors`, `competitor_sources`, `competitor_events`, `competitor_snapshots` |
| 7 | `content_items`, `content_versions` (+ drafts migration), `approval_actions` |
| 8 | `seo_keywords`, `seo_recommendations` |
| 9 | `social_accounts`, `social_posts`, `social_campaigns` (+ channels absorption) |
| 10 | `campaigns` (marketing-level), `audience_segments` |
| 11 | `inquiries`, `conversations`, `conversation_messages` (+ leads extension) |
| 12 | `reports`, `recommendations` |
| 14 | `handoffs` (or agent_events covers it) |
| 15 | `policies`, `policy_decisions`, `evaluations`, `eval_datasets` |
| 16 | `goals`, `goal_progress` |

### 5.3 The tenants → BusinessUnit → Website → Integration → Capabilities transition (the critical one)

```
PHASE 1-M2 (additive)         tenants (unchanged, still authoritative for legacy readers)
                              business_units(id, …, legacy_tenant_id UNIQUE → tenants.id)
                              websites(id, business_unit_id, domain, …)            -- 1:1 backfill
PHASE 2-3 (coexistence)       every new business table carries business_unit_id (+ website_id where customer-facing)
                              legacy tables: tenant_id still read; derived via legacy_tenant_id
PHASE 3-4 (flip + cleanup)    readers flip one endpoint at a time, guarded by the existing
                              tenant-isolation suites extended to website scope
                              tenants → VIEW; tenant_config folded; channels → social_accounts
ACCEPTANCE GATE (§121–§123)   adding "AI News Platform" BU + website + agents + knowledge +
                              integrations requires CONFIGURATION ROWS ONLY, zero code
```

**Preservation guarantees:** tenant id 491 → `business_units.legacy_tenant_id = 491` → widget `data-tenant=acme-homes` (slug) and any embedded numeric ids keep resolving at every step; the demo seed doubles as the migration acceptance test (re-run after M2 must produce identical visible behavior). No step renames a table in place; no step deletes a column before its last reader is gone (verified by grep + test).

---

## 6. STEP 7 — AGENT REBASELINE

### 6.1 The current five agents

| Current agent | Disposition | Target state |
|---|---|---|
| `research` | **Survives → specialized** | Registry agent `research` (Phase 2 seed). Behavior upgraded at Phase 6 to §52 contract (retrieval + web tools + sources + confidence + scores). Until then it runs as-is through the registry |
| `marketing` | **Survives → forks into two** | Behavioral seed for registry agents `content` and `marketing`. Prompts become versioned rows; channel style hints become prompt config |
| `sales` | **Survives → specialized** | Registry agent `sales`. Dead `prospect` lead-insert path (route never passes it — audit §6.2) fixed at Phase 11 when the §55 contract (classification, lead_score, next_action, escalation) and inquiry linkage land. `lead` agent added Phase 11 |
| `ambassador` | **Folds — not a registry agent** | Not in §21's 18-agent list. Executor retained as a *prompt variant* of content/social (BU-specific persona config), not a platform-level agent. Decision: fold |
| `customer_service` | **Survives → splits later** | Registry agent `customer_service` at Phase 2 (unchanged behavior = lowest-risk cutover). Phase 11: split into `customer_inquiry` + `customer_support` per §21 when conversations/inquiries exist |

### 6.2 New agents required (from §21's registry of 18)

Seeded **disabled** with placeholders at Phase 2 (registry-first means the directory exists before each worker); each workforce phase enables and implements its own:

`supervisor` (P14) · `research` (P6) · `intelligence` (P6) · `legal_intelligence` (P6, LegalWakeely-class BUs) · `competitor` (P6) · `content_strategy` (P7) · `content` (P7) · `fact_check` (P7) · `seo` (P8) · `social_media` (P9) · `marketing` (P10) · `lead` (P11) · `sales` (P11) · `customer_inquiry` (P11) · `customer_support` (P11) · `analytics` (P12) · `strategy` (P12) · `reporting` (P12).

### 6.3 Agent → workflow → deterministic service allocation

| Function | Goes to | Why |
|---|---|---|
| Objective classification / routing | **Deterministic** (workflow step; current router as classifier v1) | Predictable sequence — §7 mandates workflow |
| Scheduling, job claims, retries, backoff | **Deterministic** (engine) | §25–§29 |
| Publishing execution (sweep) | **Deterministic** (workflow + tools) | No reasoning required; idempotency + approval checks are code, not judgment |
| Event fan-out, notifications, cost accounting | **Deterministic** services | Pure bookkeeping |
| Research relevance judgment, content quality, strategy, implication analysis | **Agent reasoning** | Requires judgment — §7's agent side |
| Plan creation / task decomposition / escalation decisions | **Supervisor** (agent) at P14, **deterministic templates** until then | MVP's "Supervisor" (§136) is satisfied by the deterministic subset (C-5) |
| Dedup/near-duplicate detection pre-publish | **Deterministic** (checksum + similarity + pending-draft check, §89) | Codeable |

### 6.4 Extensibility invariant (the decisive design rule)

**Adding an agent must require: one `agents` row + one `agent_versions` row + tool/permission grants + optional executor binding. Zero core-platform edits.** Two executor kinds make this true: (a) bound executors (TypeScript functions registered by slug — the current five), and (b) a **generic LLM executor** that runs any registry agent from its versioned prompt + tools + output schema (this is what makes arbitrary future agents possible without code). The generic executor ships with the registry (Phase 2); the five existing functions become bound executors behind the same interface. No agent framework is required to achieve this; re-evaluation trigger stays Phase 6+ (multi-step tool loops).

---

## 7. STEP 8 — ORCHESTRATION REBASELINE

### 7.1 Target execution pipeline (replaces keyword-router → agent → draft)

```
Goal (objective, BU, constraints, budget, deadline)
  ↓  [deterministic]  Task created (§24 fields) + task_steps planned
  ↓  [deterministic]  Permission validation (agent_permissions + BU enablement + emergency flags)
  ↓  [deterministic]  Context assembly: knowledge scope resolution (§16 filters) + brand config + task input
  ↓  [agent]          Reasoning step (LLM executor or bound executor) — may call TOOLS
  │                   each tool call: schema validation → permission check → rate limit → execute → log (§31)
  ↓  [deterministic]  Structured output validation (§86–§87) → invalid = error, never DB corruption
  ↓  [deterministic]  Policy check (§49): action risk class vs autonomy level → APPROVE / ALLOW / PROHIBIT
  ↓  [deterministic]  Approval routing if HIGH risk (§46–§48): task → WAITING_APPROVAL, approval record
  ↓  [deterministic]  Execution of approved action (job claim, idempotency key, §88–§89)
  ↓  [deterministic]  Events emitted (§95) → notifications, downstream workflows
  ↓  [deterministic]  Audit trail (§72) + run record closed (status, cost, duration, error)
  ↓                   Result stored; task COMPLETED/FAILED/ESCALATED
```

### 7.2 Where deterministic ends and agent reasoning begins (the boundary, normative)

**Deterministic (code, never LLM):** objective→task bookkeeping; permission/autonomy validation; knowledge-scope filtering; tool dispatch mechanics; schema validation; policy evaluation; approval state; job claims/retries/idempotency; publishing sweeps; event emission; audit writes; cost accounting.

**Agent (LLM, bounded):** deciding *what* to investigate/retrieve (research), *how* to shape content (content/social/marketing), *how* to classify/score an inquiry (sales/support), *whether* findings are relevant (intelligence), *how* to decompose an objective (supervisor, Phase 14).

**Rule of thumb encoded into the engine:** if the step can be expressed as a pure function or a lookup, it is a workflow step; if it requires judgment over unbounded input, it is an agent step; every agent step is wrapped by deterministic pre-checks (permissions, budget, scope) and post-checks (validation, policy, audit).

### 7.3 Evolution mechanics

- **Phase 3** wraps `dispatch()` as the first task executor and `sweepDue()` as Workflow #1; `routeAgent()` becomes the classifier step with explicit `FALLBACK → ESCALATE` outcomes replacing the silent marketing default (`core.ts:24`).
- **Phase 6+** adds agent steps with tools inside the same pipeline — the pipeline never changes shape, only the contents of the reasoning step.
- **Phase 14** inserts the Supervisor *above* task creation (goal → plan → task graph); the pipeline below is untouched.
- The demo-seed comment "topic wording matters — the router is keyword-based" (`demo-seed.ts:23`) documents today's limitation; it is retired when classification becomes configuration + escalation instead of substring matching.

---

## 8. STEP 9 — AI GATEWAY

### 8.1 Implementation boundary

New module tree `lib/ai/` (Phase 4); `lib/llm.ts` moves (re-export shim left behind for one phase) and becomes `lib/ai/providers/openai.ts`:

```
lib/ai/
  gateway.ts          runCompletion(runSpec, messages, opts) / runEmbedding()  ← the ONLY door
  policy.ts           resolves model/params per agent version × BU × task class (§43)
  budgets.ts          pre-call budget check; post-call accounting; hard-stop + event
  ratelimit.ts        per agent/BU/workflow limits (§78)
  retry.ts            classified retries: TRANSIENT/MODEL → backoff+fallback; others fail fast (§71)
  usage.ts            writes llm_requests rows (provider, model, tokens, cost, latency, run_id)
  providers/
    types.ts          AIProvider { generate, stream, embed, moderate } (§42)
    openai.ts         = today's makeLLM, completed with usage capture + timeout
    anthropic.ts / google.ts / openweight.ts   (stubs → implemented when a real demand lands)
```

### 8.2 What `lib/llm.ts` becomes — exactly

| Today | Becomes |
|---|---|
| `LLMClient` interface (`complete`, `embed`) | `providers/types.ts` `AIProvider` contract — interface name changes, shape survives; `ctx.llm` call sites receive the gateway-wrapped client, so **no call-site edits** (the DI seam the audit verified holds) |
| `makeLLM(fetchImpl)` | `openai.ts` adapter constructor; adds AbortController timeout + `usage` capture (currently discarded at `llm.ts:35-36`) |
| module singleton `llm` | gateway instance built once per request context; providers resolved by `policy.ts` |
| hardcoded `api.openai.com` | provider base URL from provider config (env-backed) |
| no retries/timeouts/fallback | `retry.ts` + `AbortController` + fallback model chain |
| no logging/cost | `usage.ts` → `llm_requests` + `model_prices` |

### 8.3 Duties vs phasing (all §41 responsibilities assigned)

Provider abstraction + OpenAI adapter, timeouts, usage capture, request logging, basic rate limits: **Phase 4**. Model routing per agent/BU, budgets, cost dashboards: **Phase 4**. Fallback models + structured outputs (JSON schema + validation §86–§87): **Phase 4** (structured outputs also pulled forward into Phase 6 contracts). Streaming: deferred until a UI needs it. Moderation: Phase 15 content-safety pipeline. Embedding-dimension decision (stay 1536; `search_chunks()` seam; multi-model storage designed, not built): **Phase 4 decision record**.

**Acceptance (Phase 4):** every completion row records model/tokens/cost tied to run_id; forced-429 test proves fallback; forced over-budget test proves hard-stop + notification; zero call sites construct provider clients directly (grep-enforced).

---

## 9. STEP 10 — KNOWLEDGE SYSTEM

### 9.1 Scope model: from one level to five

Current: `tenant_id` only. Target scopes — **GLOBAL → BUSINESS → WEBSITE → JURISDICTION → AGENT** (Master §15's four levels + the WEBSITE refinement; reconciliation at C-4). Implementation: `business_unit_id NULL = global` (§14), `website_id NULL = BU-wide`, `jurisdiction` columns, `agent_scopes` grants. Retrieval resolves the caller's scope set and applies ALL filters — an agent never receives unscoped corpora (§16 becomes mechanically enforceable, today it is unimplementable at any level finer than tenant — audit §9.4).

### 9.2 Document/chunk metadata (including the legal contract)

| Field group | Columns | Serves |
|---|---|---|
| Scope | business_unit_id (NULL=global), website_id NULL, access_level, agent_scopes | §15–§16 |
| Legal | jurisdiction, country, state_province, court_system, effective_date, source_date | §50–§51 — law from one jurisdiction never assumed elsewhere |
| Authority | authority_tier 1–5 (government/court → unverified social), source_url, provenance JSONB (fetch timestamp, crawler id, revision), verification_status (unverified/verified/stale/contradicted) | §18 source quality; research citations |
| Language | language, translation_group_id (original preserved; translations linked, never overwrite) | §97 |
| Lifecycle | refresh_frequency, last_checked, status | §17 |

### 9.3 What is preserved vs changed

**Preserved (high confidence, test-proven):** pgvector + ivfflat; checksum dedup + embed-count guards; injectable `ctx.embed`; grounding prompt + `{answer, sources[]}` citation shape; cross-tenant leak tests as the template extended to every new scope axis.
**Changed (Phase 5):** scope columns + filtered hybrid retrieval (tsvector keyword leg + metadata + authority + date + jurisdiction); real fetchers (URL/sitemap/RSS first; PDF/DOCX/CSV next) — today `content_sources` declares kinds no code fetches; structure-aware chunking with overlap (800-char blind slicing materially harms legal-domain retrieval); authority tiers feeding research recommendations; ingestion admin UI.
**Decision recorded:** vector dimension stays 1536 until a second embedding provider is adopted; the `search_chunks()` seam + per-model child-table design is the pre-agreed escape hatch (never a column-width ALTER on live data).

**Acceptance (Phase 5):** extended leak tests prove GLOBAL vs BUSINESS vs WEBSITE vs JURISDICTION vs AGENT separation; a legal question scoped to jurisdiction X never returns Y's law; every research citation carries tier + provenance.

---

## 10. STEP 11 — WEBSITE CONNECTOR STRATEGY

### 10.1 Principles (from §36–§39, §153, binding)

Existing websites are **independent systems** — never redesigned here, never assumed owned, no destructive changes, no forced upgrades. Integration preference order: official API → CMS API → dedicated endpoint → webhook → controlled DB → other. One platform + configuration + connectors = many websites (§120). Future sites connect without core changes.

### 10.2 Connector contract

**Platform-side standard operations (§35):** `getContent`, `createDraft`, `updateContent`, `publishContent`, `getLeads`, `getAnalytics`, `getSiteStatus` — adapters per technology (Next.js / WordPress / custom API / CMS).

**Capability grants (§12) gate every operation:** READ_CONTENT, CREATE_CONTENT, UPDATE_CONTENT, PUBLISH_CONTENT, READ_LEADS, CREATE_LEAD, READ_ANALYTICS, SEND_NOTIFICATION, READ_PRODUCTS. An agent may invoke a connector operation only if (a) the website granted the capability, and (b) the agent has the matching permission — checked deterministically at dispatch.

**Data flows the contract must carry (per the reconciliation mandate):**

| Flow | Direction | Mechanism |
|---|---|---|
| Inquiries | site → platform | site posts to signed webhook `/api/integrations/:siteId/events` (or platform-side widget capture) → `inquiries` + `website.inquiry.created` |
| Leads | bidirectional | platform creates leads from inquiries (CREATE_LEAD); site may push lead status updates via webhook; `getLeads()` for pull-based sites |
| Content | platform → site | `createDraft`/`publishContent` via the site's chosen adapter (API/CMS/dedicated endpoint); drafts respect the site's own review process |
| Publishing | platform → channel | social/email adapters (existing publisher layer) — not the website itself |
| Analytics | site → platform | webhook push or `getAnalytics()` pull → analytics store (Phase 12 reads) |
| Notifications | platform → site | SEND_NOTIFICATION capability → site endpoint or email fallback |
| Knowledge | platform ↔ site | site content synced as knowledge sources (sitemap/RSS fetchers, Phase 5 machinery reused); site never hosts the workforce (§39) |
| Products | site → platform | READ_PRODUCTS for commerce-capable sites (Almizan-class), pull-only in v1 |

### 10.3 Security & the widget as connector #1

Every site registration issues a **signing key** (HMAC). Inbound requests: signature + timestamp + replay cache + rotation (§77). Outbound: platform identifies itself with a per-integration key. The existing widget+chat pair is formalized as the first connector capability (`chat.answer`) in Phase 11/13 — proving the grant model on an integration that already works, with the widget re-keyed from bare tenant id to a site embed token (also closes S3 properly). **Do-not list:** no workforce components installed into sites; no site-side DB access; no redeploys of the platform when a site is added (§11 acceptance).

---

## 11. STEP 12 — FINAL PHASE 0–16 ROADMAP

Numbering reconciles the Master Arch phases (§135) with the Phase 0 audit's roadmap; "Phase 0.5" is consumed by this reconciliation document, and the audit's interim security gate is re-homed as **Phase 1 M0** (C-17). Dependency law enforced throughout: Identity/RBAC → multi-tenant administration; BU/Website → website-level permissions; Agent Registry → autonomous execution; Task/Workflow infra → Supervisor; AI Gateway → uncontrolled multi-agent production execution; Approvals/policies → high-risk autonomous actions.

**P0 — Architecture validation (DONE).** Deliverables: Phase 0 audit + this reconciliation. No autonomous agents (§135 met).

**P1 — Platform foundation: security gate, identity, BusinessUnits, Websites, ops**
- Objective: administrator logs in and manages multiple BUs/websites without code changes (§135 P1 criterion); no unauthenticated mutation endpoint remains.
- Prerequisites: this document's approval.
- Capabilities: session auth + RBAC v1; BU/Website model + additive tenancy migration; audit logging; versioned migrations; rate limits; feature flags + emergency flags v1; Command Center shell; CI; staging.
- DB: §5.2 P1 rows. Backend: guards on 3 endpoints, auth module, migration runner, audit writer, BU/Website APIs. Frontend: login, shell nav, Websites/BU screens, Settings, Audit viewer v0; Tailwind+shadcn baseline. Security: SEC-C1..C7 all closed. Migrations: runner + 001–0xx.
- Dependencies: none. Tests: new auth/rbac/rate-limit/audit/migration suites + all 14 existing green in CI.
- Acceptance: curl sweep of unauth mutations fails closed (401/403/429); 2 users × 2 roles see different capabilities; 2 BUs + 2 websites configurable in UI; widget still resolves `acme-homes`; `schema_migrations` ledger ordered; CI green on GitHub.
- Rollback: migrations are additive; auth middleware is per-route (no big-bang cutover); legacy password path retained behind flag during M1 window only.
- NOT yet: agent registry, autonomy, workflow engine, knowledge scoping, connector wizard.

**P2 — Agent Registry & versions (+ agent identities, key-id crypto, flags-driven emergency stops)**
- Objective: agents become data; enable/disable per BU without deploys (§135 P2).
- Capabilities: registry + versions + per-run attribution; agent dashboard v1; machine identities (§75); envelope crypto key-id; STOP-ALL-AGENTS / DISABLE-AGENT flags.
- DB: agents/agent_versions/agent_tools/agent_permissions/business_unit_agents/agent_identities; agent_runs ALTERs; channels key-id migration. Backend: registry service, generic LLM executor, prompt loader. Frontend: Agents screens.
- Tests: registry CRUD, permission-matrix, prompt-version attribution, golden-prompt before/after set.
- Acceptance: flipping an agent's enabled flag changes behavior in ≤1 run, zero deploys; every run names its prompt version.
- Rollback: registry rows can be re-pointed to prior versions; bound executors unchanged.
- NOT yet: tools with side effects (registry rows only), task engine, supervisor.

**P3 — Task + Workflow Engine, jobs, events, notifications, publications**
- Objective: background execution without the browser (§135 P3); reliability (§140: jobs must not disappear).
- Capabilities: tasks/steps/status machine incl. WAITING_APPROVAL/ESCALATED; workflows + triggers (schedule/event/manual; webhook+goal reserved); job queue with claims (FOR UPDATE SKIP LOCKED), attempts/backoff; event bus + notifications v1; sweep → Workflow #1; dispatch → task executor; content_publications with idempotency; outbox write-stop.
- Tests: forced duplicate-sweep produces zero duplicate posts; retry/backoff; cancellation; event delivery.
- Acceptance: scheduled task executes with browser closed; concurrency test proves idempotency (§88).
- Rollback: cron sweep retained behind flag until engine soaks.
- NOT yet: LLM budget enforcement (P4), agent tool loops, supervisor.

**P4 — AI Gateway & cost control**
- Objective: one controlled doorway (§135 P4) per §8 of this document.
- Capabilities: gateway, provider abstraction, routing policy, budgets, rate limits, retries+fallback, usage/cost ledger, structured outputs + validation, embedding-dimension decision record.
- DB: llm_requests, model_prices. Tests: forced-429 fallback; budget hard-stop; usage row per call; call-site grep (no direct provider use).
- Acceptance: cost per agent/BU/task/month visible; runaway agent halts on budget.
- Rollback: gateway flag → direct adapter (single toggle) during soak.
- NOT yet: moderation (P15), multi-provider rollout beyond OpenAI until needed.

**P5 — Knowledge system v2** — scopes (5 levels), metadata + legal fields, fetchers (URL/sitemap/RSS→PDF/DOCX/CSV), hybrid retrieval, chunking upgrade, knowledge admin UI. Tests: five-scope leak matrix; jurisdiction cross-contamination zero. Acceptance: agent answers using only authorized website+jurisdiction knowledge (§135 P5). Rollback: retrieval seam keeps legacy path behind flag. NOT yet: research agents consuming it (P6).

**P6 — Research workforce (MVP use case #1: daily AI/legal-AI intelligence, §137)**
- Research + Intelligence (+ Legal Intelligence, Competitor) agents per §52–§53; research_items, competitors/competitor_events(+snapshots); tools `web_search`/`fetch_url` with schema/limits; scheduled research workflow; research dashboard. **Agent-framework re-evaluation trigger fires here** (multi-step tool loops first appear). Tests: §109 datasets (known event → expected finding; ambiguous → escalation). Acceptance: daily cited+scored findings per BU without human trigger. NOT yet: autonomous publishing of research (content stays approval-gated).

**P7 — Content workforce (MVP use case #2: research → content, §138)**
- content_items/versions migration (drafts FSM state-mapped, §5.1); strategy→content→fact_check chain; 9-state lifecycle; approval center v2 (risk levels, reviewer identity, edit-before-approve, transactional FSM). Acceptance: finding → versioned, fact-checked, approval-gated package. Rollback: drafts kept read-only until cutover verified. NOT yet: auto-publish anything.

**P8 — SEO workforce** — SEO agent, keyword store, gap analysis, recommendations with approval flags. Acceptance: SEO recommendations appear with evidence.

**P9 — Social workforce** — social_accounts (absorb channels + LinkedIn account-ref fix), social_posts linked to content items, campaigns, platform variants, scheduling calendar (time semantics, not cron pile), OAuth linking, metrics ingestion; IG/TikTok real adapters. Security: OAuth lifecycle (SEC-L5). Acceptance: one approved item → per-platform scheduled posts; nothing publishes without approval unless policy later says so. 

**P10 — Marketing workforce** — campaigns, audience analysis, performance monitoring (§91 autonomy: drafts AUTO, campaigns APPROVAL). Acceptance: campaign lifecycle operational.

**P11 — Sales + Customer workforce (MVP use case #3: inquiry → lead, §139)**
- inquiries/conversations(+messages); leads extension + stage migration; sales/lead/customer_inquiry/customer_support registry agents; classification/scoring/escalation; widget → site-registered connector #1 (`chat.answer`); chat route becomes façade over task machinery. Security: §101 customer isolation enforced by website ownership; SEC-C3 full treatment. Acceptance: inquiry → classified, scored lead with human escalation; conversations never expose internal reasoning (§65).

**P12 — Analytics + Strategy** — analytics/strategy/reporting agents, cross-BU dashboards (aggregate-only across BUs per §99), recommendations store, reports (daily/weekly/monthly/on-demand §102–§103). Acceptance: owner-level reporting with per-BU privacy.

**P13 — Website connectors (connect the seed sites, then Add-Website wizard)**
- WebsiteConnector interface + adapters; signed inbound webhooks (SEC-L4); capability grants live (§12); integration management UI (replaces the P1-guarded channels endpoint permanently); Add-Website wizard (§121). **Acceptance gate = §121–§123 test: onboarding a new site is configuration only; one site failing does not affect others (§144).**

**P14 — Supervisor** — bounded planner/delegator per §57 (plan → task graphs → delegate → monitor → escalate); handoff logging (§23); router permanently demoted to classifier. Hard budget/permission ceilings on delegation. Acceptance: stated goal → delegated, logged, approval-respecting tasks.

**P15 — Controlled autonomy** — autonomy levels 0–5 per agent/BU (§45); Policy Engine (§49) incl. legal-safety hierarchy (§50); action risk classes (§46) fully wired; evaluation datasets + metrics (§105, §109); progression gates Sandbox→…→Full (§110); moderation in pipeline (§90). Acceptance: a proven workflow moves approval→automatic **under policy** with a rollback switch. **No phase before P15 may enable autonomous HIGH-risk actions — this line is non-negotiable.**

**P16 — Autonomous business operations** — goals/goal_progress (§66–§67); recommendation-driven bounded loop (§134); full emergency-controls verification (§79). Acceptance: §160–§162 definitions of done; "knowing when to stop and ask a human" demonstrated (§162).

**Dead-end prevention (standing):** identity+audit precede multi-BU data; embedding + content-versioning decisions precede data volume; approval-gate invariant survives all phases; every DB change is a versioned migration; no new dependency without a written trigger.

---

## 12. STEP 13 — PHASE 1 DEFINED PRECISELY (becomes the Phase 1 implementation prompt)

**Scope = security gate (M0) → identity/RBAC (M1) → BusinessUnits/Websites (M2) → ops/CI/Command Center shell (M3).** Nothing outside this list may be implemented in Phase 1.

### 12.1 Exact files/modules changed
- `app/api/v1/channels/route.ts` — add session/integration guard (M0).
- `app/api/agents/run/route.ts` — add session guard + per-tenant daily cap + rate limit (M0).
- `app/api/v1/chat/route.ts` — rate limit + per-tenant daily cap + embed-token verification hook (M0; full site binding at P11).
- `app/api/agents/sweep/route.ts`, `app/api/admin/migrate|seed|env-check/route.ts` — audit-write on every call; OPS_TOKEN-only for ops (M0/M1).
- `app/admin/login/page.tsx`, `app/admin/page.tsx` — replaced by `/login` + Command Center shell using cookie sessions; sessionStorage pattern deleted (M1).
- `lib/migrations.ts` — superseded by `lib/migrations/` (runner + `001_*.ts` … ledger-aware) (M0).
- `lib/admin.ts` — extended to session-based `authorize(user, permission)`; `safeEqual` retained (M1).
- `lib/demo-seed.ts` — re-targeted to BU + website (M2).
- `README.md` embed example fixed; `AGENTOS-RUNBOOK.md` corrections (cron frequency, `question` key, POST method, URL); `HANDOFF.md` archived (M3 docs pass).

### 12.2 Exact new modules
`lib/auth/{password.ts (scrypt), sessions.ts, rbac.ts, guards.ts}` · `lib/security/ratelimit.ts` (per-IP + per-tenant token bucket; daily LLM counters) · `lib/audit.ts` · `lib/migrations/runner.ts` · `lib/settings.ts` (system_settings + feature flags + emergency flags) · `lib/bu.ts` (business-unit/website service + legacy mapping) · `app/(dashboard)/{page,websites,settings,audit,approvals}` shells.

### 12.3 Exact database migrations (numbered, additive)
`001 schema_migrations` · `002 audit_logs` · `003 users, sessions` · `004 roles, permissions, role_permissions, user_roles` (+ seed Owner/Administrator/Reviewer/Operator) · `005 system_settings, feature_flags` · `006 rate-limit counters (tenant_usage_daily)` · `007 business_units (+legacy_tenant_id UNIQUE), websites` (+ 1:1 backfill transaction) · `008 website_integrations, website_capabilities` (structure only) · `009 channels: ADD target, metadata, display_name` · `010 approvals: ADD reviewer_user_id NULL` · tenant_config→BU column copy in 007's transaction.

### 12.4 Exact APIs
`POST /api/auth/login` · `POST /api/auth/logout` · `GET /api/auth/me` · `POST /api/admin/drafts/[id]` (session-or-legacy-bearer, reviewer recorded) · `GET /api/admin/drafts` (scoped to user's permitted BUs) · `GET/POST/PATCH /api/admin/business-units` · `GET/POST/PATCH /api/admin/websites` · `GET/POST /api/admin/users` (invite/disable; Owner-only) · `GET/PUT /api/admin/settings` · `GET /api/admin/audit` · guarded `POST /api/v1/channels` · rate-limited `POST /api/v1/chat`, `POST /api/agents/run`.

### 12.5 Exact authentication model
Email + password (scrypt, per-user salt, `node:crypto` — no new dependency); opaque 256-bit session token in `httpOnly; Secure; SameSite=Lax` cookie; `sessions` table (user_id, token_hash, expires_at, 7-day sliding); logout deletes row; login rate-limited + lockout after N failures. `ADMIN_PASSWORD`/OPS_TOKEN retained **only** for ops endpoints during transition; dashboards never see or store a password after login.

### 12.6 Exact authorization model
`roles` (owner/administrator/operator/reviewer/analyst/developer/agent — first four active) × `permissions` (e.g. `bu.manage`, `website.manage`, `drafts.approve`, `drafts.schedule`, `users.manage`, `settings.manage`, `audit.read`, `ops.run`) × `role_permissions`; route handlers declare required permission via `requirePermission(...)`; BU-scoped reads filtered by the user's BU access (Owner = all). Agent machine identities are modeled in P2, not P1.

### 12.7 Exact tests
New suites: `auth-tests` (login/logout/expiry/cookie flags), `rbac-tests` (role × route denial matrix), `ratelimit-tests` (429 behavior, daily caps), `audit-tests` (every mutating route writes a row), `migrations-tests` (apply-to-empty + apply-twice idempotent on ephemeral DB), `bu-website-tests` (backfill correctness, widget resolution, cross-BU denial). All 14 existing suites remain green. CI runs everything against an ephemeral Postgres (Neon branch or container), never production.

### 12.8 Exact acceptance criteria
1. `curl` sweep: every mutation endpoint unauthenticated → 401/403; flood → 429. 2. Two users (Owner, Reviewer) demonstrate different allowed actions. 3. Two BUs + two websites each configurable via UI with zero code changes. 4. Live widget still resolves `acme-homes` (id 491) unchanged. 5. `schema_migrations` shows ordered ledger; re-running runner is a no-op. 6. Every admin mutation appears in `audit_logs` with user id. 7. GitHub Actions green (typecheck + suites + build). 8. Staging environment exists with a separate database.

---

## 13. STEP 14 — ARCHITECTURAL CONTRADICTIONS (complete register)

Each entry: conflict → authoritative decision → what changes later.

| # | Conflict | Authoritative decision | Later change |
|---|---|---|---|
| C-1 | Master §6 "Supabase preferred" vs reality: Neon Postgres + Vercel, working | **PostgreSQL is the requirement (§13); Supabase is a preference, not a mandate. Stay on Neon.** Migration to Supabase buys zero target capability at real risk | None (document note) |
| C-2 | Master §6 "Supabase Auth or equivalent" vs no auth library in repo | **"Equivalent secure managed authentication" = server-side sessions (§12.5). Managed-auth providers may be adopted later only if they don't fight the API-route model** | Revisit trigger at P2+ |
| C-3 | Master §6 "may use OpenAI Agents SDK/LangGraph/n8n" vs framework-free codebase | **No framework now. Internal agent interface (registry + generic executor) satisfies §6's isolation requirement at lower complexity; n8n excluded to keep single-runtime deploys** | Re-evaluate at P6 (tool loops) |
| C-4 | Master §15 defines 4 knowledge levels; owner's directive + website model imply 5 (WEBSITE distinct) | **Implement 5 scopes; WEBSITE is a refinement of BUSINESS via website_id; Master doc amended at next revision** | Master doc note |
| C-5 | Master §136 MVP includes "Supervisor" but §135 places Supervisor at P14 | **MVP Supervisor = deterministic subset (scheduler + classifier + escalation); LLM planner arrives P14** | None |
| C-6 | Drafts FSM (6 states) vs §60 content lifecycle (9 states) | **content_items/versions with 9 states; FSM semantics preserved via documented state map (§5.1)** | P7 migration |
| C-7 | §114 "no agent may alter production schema" vs `/api/admin/migrate` applying DDL | **Endpoint is human-triggered, bearer-guarded, fixed version-controlled DDL → acceptable interim; becomes ledger-runner in P1-M0** | P1 |
| C-8 | README embed example (`data-tenant` on div) vs widget reading `currentScript` only | **Code is right; README wrong** | P1 docs pass |
| C-9 | RUNBOOK "every 15 min" vs `vercel.json` daily `30 3 * * *` | **Code right; RUNBOOK wrong** | P1 docs pass |
| C-10 | RUNBOOK chat example `{message}` vs API requiring `question` (`chat/route.ts:10,16`) | **Code right; RUNBOOK wrong (documented curl 400s)** | P1 docs pass |
| C-11 | RUNBOOK `PATCH /api/admin/drafts/[id]` vs POST-only route | **Code right; RUNBOOK wrong** | P1 docs pass |
| C-12 | RUNBOOK URL `agentos-nine` vs production alias `masteragent-nine` | **masteragent-nine is canonical (matches Vercel project + alias)** | P1 docs pass |
| C-13 | `content_system_prompt` exists in schema, loaded in `dispatch.ts:13`, never consumed | **Dead config; drop during BU fold; if per-BU prompt overrides are wanted, they return as `agent_versions` config** | P2/P3 cleanup |
| C-14 | `agent_runs.prompt_hash` stores raw topic (`dispatch.ts:29`) | **Add real prompt_hash + prompt_version; backfill legacy column to `topic`** | P2 migration |
| C-15 | Design spec promises (approved_by, Arabic-safe normalization, per-tenant sessions, rate limits, request IDs) vs unimplemented code | **Spec is superseded by Master Arch + this document as architecture-of-record** | P1 docs pass (archive) |
| C-16 | seed-demo comment "topic wording matters — router is keyword-based" vs target classification quality | **Router demoted to classifier with FALLBACK/ESCALATE at P3; comment retired then** | P3 |
| C-17 | Phase 0 audit reserved "Phase 0.5" for the security gate; owner assigned Phase 0.5 to this reconciliation | **This document owns the number; security gate = Phase 1 M0** | Done here |
| C-18 | "Universal Build Rules" referenced as standalone input; no such file exists | **Rules corpus lives in Master §120, §152–§156, §158–§165 + standing owner directives (Input Register, item 2). Mapping ratified here; owner may supply the standalone text, which would then supersede only where it conflicts** | Owner confirmation optional |
| C-19 | Email publisher global `EMAIL_TARGET` fallback vs per-tenant routing | **Per-website/lead routing required before marketing use; until then email stays approval-gated (it already is)** | P9/P11 |
| C-20 | `ON DELETE CASCADE` from tenants/approvals vs audit immutability (§72) | **Cascade removed on audit-path tables when restructured; kept only on true child data (chunks→documents)** | P3/P7 migrations |

---

## 14. STEP 15 — FINAL ARCHITECTURE DECISION

> ## **APPROVED — READY FOR PHASE 1**
>
> Subject only to the owner's ratification of this document. The decision is unconditional in kind: no architectural question blocks Phase 1. The one open input (standalone Universal Build Rules, C-18) is a documentation formality whose operative content is fully enforced by the roadmap; the one operational blocker (OpenAI key quota, Phase 0 finding C2) affects LLM-touching acceptance runs only and does not gate Phase 1's infrastructure scope.

**Why APPROVED and not CONDITIONAL:** every contradiction in §13 received a decision that is (a) consistent with the Master Architecture as the target authority, (b) consistent with the Universal Build Rules' substance (phase-by-phase, preserve functionality, no invented behavior, tests with features, approval before destructive change), and (c) supported by re-verified repository evidence. The migration is additive at every step; the live deployment and the widget contract never blink; and the security gate is embedded as Phase 1's first milestone so no critical vulnerability crosses the phase boundary.

**Standing invariants carried into implementation (non-negotiable in every phase):**
1. Generation autonomous, publication human-gated — until P15 explicitly changes it under policy.
2. No unauthenticated mutation endpoint, ever.
3. Every DB change is a versioned, ledgered, additive-first migration.
4. Agents are data; the registry references implementations, never the reverse.
5. Deterministic engine executes; agents reason inside bounded steps.
6. Seed businesses (WakeelyPro, Mokhamen, Almizan, LegalWakeely) are configuration rows, never code.
7. No phase claims "done" without its tests green in CI against a non-production database.

---

*Bridge complete: MASTER ARCHITECTURE → UNIVERSAL BUILD RULES → PHASE 0 AUDIT → **PHASE 0.5 RECONCILIATION (this document)** → PHASE 1 IMPLEMENTATION (§12 of this document is the Phase 1 prompt).*

**PHASE 0.5 COMPLETE — WAIT FOR OWNER APPROVAL. DO NOT BEGIN PHASE 1 AUTOMATICALLY.**
