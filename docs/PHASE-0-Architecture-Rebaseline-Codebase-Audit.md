# PHASE 0 — ARCHITECTURE REBASELINE & CODEBASE AUDIT

**Project:** AgentOS (`kosovohomes/Master-agent`, branch `main`, audited HEAD `52f32e6`)
**Target architecture:** *Master Technical Architecture & Build Specification — Multi-Website AI Workforce & AI Command Center*, v1.0 (Architecture Baseline)
**Audit date:** 2026-09-11
**Audit type:** READ-ONLY. No source code, schema, environment, dependency, or configuration was modified. No migrations were run. No branches or commits were created. No implementation was performed.

**Read-only attestation & verification log**

| Check performed | Nature | Result |
|---|---|---|
| Full source read: all 8 `lib/*` modules, all 11 API route handlers, 3 pages, `public/widget.js`, 14 test suites, 2 scripts, all 6 docs, `vercel.json`, `.env.example`, `tsconfig.json`, `next.config.ts`, `package.json` | read-only file inspection | complete; cited throughout |
| `git log`, `git status`, `git diff --stat` | read-only | HEAD `52f32e6`; 67 files show **mode-only** diffs (100644→100755 clone artifact), **0 insertions / 0 deletions** — working tree content untouched |
| `tsc --noEmit --incremental false` | safe static check (emits nothing) | exit 0, zero type errors |
| `wc -l` code metrics | read-only | lib ≈ 860 LOC; app UI ≈ 73 LOC; tests ≈ 1,856 LOC |
| Live deployment probes (`https://masteragent-nine.vercel.app`) | outbound **GET** only | `/` → 200; `/admin/login` → 200; `GET /api/v1/widget/config?tenant=acme-homes` → 200 `{tenantId:491, brand:"Acme Homes"}`; `GET /api/admin/drafts` unauthenticated → 401 |
| Tests / migrations / LLM calls / DB writes | **deliberately NOT run** | tests write+delete rows on the production Neon database; excluded under read-only constraint |

**Conventions used in this report:** evidence is cited as `path:line` where precise. Where a claim could not be verified in this audit it is marked **NOT VERIFIED**. Where a claim rests on the prior operations session of 2026-09-11 (documented in `AGENTOS-RUNBOOK.md` §2–§8), it is marked *(verified in prior ops session; not re-executed in this audit)*.

---

## 1. EXECUTIVE SUMMARY

### 1.1 Is AgentOS a viable foundation?

**Yes — as a foundation, not as the product.** AgentOS is a compact, disciplined, well-tested v1 of a *single-website-per-tenant social-media automation tool* (≈ 860 lines of library code, 4 runtime dependencies, zero agent-framework dependencies). Its core mechanics — a tenant-scoped pgvector knowledge store, a strict draft approval FSM, an adapter-pattern publisher layer, and an AES-GCM secrets pipeline — are technically sound and map onto identifiable subsystems of the Master Architecture. The codebase is deployable, type-clean (`tsc` exit 0), and its 14 test suites demonstrate unusually honest engineering discipline for a v1.

However, the Master Technical Architecture describes a **different product category**: a centralized AI Workforce and Command Center operating multiple independent businesses/websites through registered agents, tools, workflows, policies, and connectors. AgentOS currently implements roughly one corner of that target (the "Content/Social Workforce for one tenant + a customer-service widget"). The gap is architectural, not cosmetic: there are no users/roles, no BusinessUnit/Website model, no agent registry or versions, no task/workflow engine, no AI gateway, no event system, no audit log, and no per-agent permissions. The security posture (single shared password; three fully unauthenticated mutation endpoints) is not a basis for the target system.

### 1.2 Is starting from scratch justified?

**No.** A rewrite would discard working, tested mechanics that the target architecture needs in essentially the same shape: pgvector retrieval, the draft FSM, publisher adapters, channel-token encryption, the timing-safe auth primitives, and the test harness. The audit found **no irreversible architectural poison** in the reusable core — the schema is additive (idempotent `CREATE TABLE IF NOT EXISTS` DDL in `lib/migrations.ts`), the LLM client is already an injectable seam (`makeLLM(fetchImpl)` in `lib/llm.ts:17`), and the agents are plain functions that can be re-registered into a future Agent Registry. Everything the target adds (users, business units, websites, tasks, workflows, gateway, audit) can be **added alongside** the existing tables and modules incrementally. The honest characterization: AgentOS is roughly 40% of the way to the target's *infrastructure* and roughly 15% of the way to the target's *scope*.

### 1.3 Strongest reusable parts

1. **RAG core** — `lib/rag/ingest.ts` (checksum-deduplicated ingestion, 800-char chunking, pgvector writes) and `lib/rag/retrieve.ts` (cosine-distance, tenant-scoped) with genuinely tenant-isolated test coverage (`tests/rag-tests.ts:66-68`, `tests/chat-tests.ts:100-103`).
2. **Approval FSM** — `lib/agents/approval.ts:5-12` (`pending → approved|rejected`, `approved → scheduled`, `scheduled → posted|failed`), enforced in code and exhaustively tested including illegal-transition rejection (`tests/approval-tests.ts:60-88`).
3. **Publisher adapter pattern** — `lib/agents/publishers/index.ts` (`Publisher` interface, per-channel adapters, channel-health flip on failure) — directly seeds the target's Integration Layer / WebsiteConnector pattern.
4. **Channel-token crypto** — `lib/channels.ts` AES-256-GCM with random IV and auth-tag verification, tamper-tested (`tests/channels-tests.ts:17-27`).
5. **DB seam** — `lib/db.ts` parameterized pool + `transaction()` helper; `lib/migrations.ts` as a single idempotent DDL source consumed by both CLI and a Bearer-guarded endpoint.
6. **Widget** — `public/widget.js` is dependency-free, CSP-safe (verified by `tests/widget-tests.ts:84-86`), and already implements the "controlled interface into the central platform" idea of Master Arch §40.
7. **Test discipline** — 14 suites (`tests/run-all.ts:3`), integration-style against a live DB with stubbed LLM, strict tenant-isolation assertions, self-cleaning fixtures.

### 1.4 Biggest architectural conflicts

1. **Tenancy granularity.** Target requires `BusinessUnit → Websites → Integrations` with capability grants (Master Arch §8–§12). AgentOS has a flat `tenants` row = one website = one brand = one channel set. This is not a rename; it is a two-level hierarchy the schema cannot express (evidence: `lib/migrations.ts:12-26`).
2. **Agents are code constants.** Target requires a DB-backed Agent Registry with versions, tools, permissions, budgets, and autonomy levels (Master Arch §20–§21, §83–§84). AgentOS defines 5 agents in `lib/agents/catalog.ts:5-11` with one-line descriptions; instructions are hardcoded template strings in `lib/agents/generators.ts:8-13`; there is no versioning, no tool assignment, no permissions, no budgets.
3. **Orchestration is a keyword router.** `lib/agents/core.ts:9-25` routes by substring match with a marketing default. There is no Task object, no Workflow object, no run lifecycle (runs are recorded as `'completed'` after the fact — `lib/agents/core.ts:34-39`), no retries, no event triggers. The target's Task Engine + Workflow Engine + Supervisor (Master Arch §22, §24–§26, §28–§30) do not exist in any form.
4. **No AI Gateway.** `lib/llm.ts` is a single-provider OpenAI client with no token/cost tracking, no per-agent budgets, no fallback, no rate limiting, no request logging — all mandated by Master Arch §41–§44.
5. **Security model.** Master Arch §73–§78 requires RBAC, agent identities, webhook signatures, rate limiting, and audit logging. AgentOS has one shared `ADMIN_PASSWORD` for everything, three unauthenticated mutation endpoints (`POST /api/v1/channels`, `POST /api/agents/run`, `POST /api/v1/chat` — `README.md:134-141` admits this), no users table, no audit log, and no rate limiting anywhere.

### 1.5 Highest-risk areas

| # | Risk | Severity | Evidence |
|---|---|---|---|
| R1 | Unauthenticated `POST /api/v1/channels` lets any internet caller store/overwrite publishing credentials for any tenant → publishing hijack via planted tokens | Critical | `app/api/v1/channels/route.ts:10-44`; acknowledged in `README.md:160-164` |
| R2 | Unauthenticated `POST /api/agents/run` + `POST /api/v1/chat` allow unbounded OpenAI spend and approval-queue spam for any numeric tenantId (no rate limit, no budget) | Critical | `app/api/agents/run/route.ts:8-29`, `app/api/v1/chat/route.ts:9-33` |
| R3 | Single shared `ADMIN_PASSWORD` doubles as dashboard password *and* API bearer, held in browser `sessionStorage`; no users, no sessions, no expiry, no rotation, no per-tenant scoping | High | `app/admin/login/page.tsx:14`, `app/admin/page.tsx:6-9`, `lib/admin.ts:5-8` |
| R4 | LinkedIn publishing cannot work as deployed: channels table has no `target`/author column; publisher falls back to `urn:li:person:unknown` (`lib/agents/publishers/index.ts:58`); `sweepDue` declares `target` in its row type but never selects it (`publishers/index.ts:84-85`) | High (functional) | `lib/agents/publishers/index.ts:58,84-85` |
| R5 | Non-transactional FSM transitions and sweep (read-then-write `approval.ts:18-25`; per-draft loop `publishers/index.ts:75-103`) → duplicate publishes/leads under concurrency; acknowledged at-least-once semantics | Medium | `README.md:167-173` |
| R6 | Fixed `vector(1536)` column hard-locks the embedding model; changing models requires schema migration of every chunk row | Medium | `lib/migrations.ts:61` |
| R7 | No audit log of administrative or agent actions beyond the minimal `approvals` rows (which carry **no reviewer identity**) | Medium | `lib/migrations.ts:89-95` |

### 1.6 Overall recommendation

**Rebaseline AgentOS against the Master Architecture and evolve it incrementally (Migration Strategy A), preceded by a security-hardening gate.** Keep the RAG core, FSM, publisher adapters, crypto, DB seam, widget, and test harness. Add the missing platform layers (identity, BusinessUnit/Website, Agent Registry, Task/Workflow engine, AI Gateway, audit) *around* them. Replace only three things outright: the shared-password auth model, the auth-free channel wire-up endpoint, and the treatment of `outbox` as a queue surrogate. Do **not** rewrite, and do **not** preserve the current security model into any phase beyond the hardening gate.

### 1.7 Readiness score: **43 / 100** — "viable foundation, not yet the platform"

**Methodology.** Seven dimensions, each scored 0–5 against the *Master Architecture requirements for Phases 0–5 (the foundation phases)*, since later phases legitimately have no current implementation. Score 5 = target-aligned and reusable as-is; 3 = reusable with bounded modification; 1 = exists but conflicts with target; 0 = absent. Weights reflect how much each dimension constrains later phases.

| Dimension | Weight | Score | Rationale (evidence anchor) |
|---|---|---:|---|
| Data foundation (engine, vector, migration mechanics) | 15% | 3.0 | Postgres+pgvector+idempotent DDL is target-aligned (`lib/migrations.ts`); single-string DDL and `vector(1536)` lock-in need work |
| Tenancy & isolation model | 15% | 2.0 | Row-scoping discipline is real and tested, but flat `tenants` cannot express BU/Website hierarchy (`lib/migrations.ts:12-26`) |
| Agent & orchestration layer | 15% | 1.5 | Working dispatch-to-draft loop, but keyword router + code-constant agents + fake run lifecycle conflict with Task/Workflow/Registry requirements (`lib/agents/core.ts`, `catalog.ts`) |
| AI Gateway & knowledge system | 15% | 2.5 | Good RAG core is genuinely reusable; LLM client is a seam but has zero gateway properties (`lib/llm.ts`) |
| Security, auth & audit | 15% | 1.0 | Correct primitives (`safeEqual`, AES-GCM) buried under a shared-password model, 3 unauthenticated mutation endpoints, no audit log |
| Product surface (Command Center, widget, publishing, approvals) | 15% | 2.5 | Widget + approval queue are solid seeds; admin UI is one page; LinkedIn path broken; no connectors |
| Engineering quality (tests, build, deployability, docs) | 10% | 3.0 | 14 suites + clean build + type-check pass; docs drift, no CI |
| **Weighted total** | 100% | **2.15 / 5 → 43 / 100** | |

Interpretation: nothing here argues for a rewrite; equally, nothing here may be shipped to the target's Phase 1 gate (multi-website administration) without the identity/tenancy rework. The score is deliberately *not* a measure of code quality (which is above average) but of **distance to the target architecture**.

---

## 2. CURRENT AGENTOS ARCHITECTURE (WHAT ACTUALLY EXISTS)

Everything in this section was verified by reading the source at HEAD `52f32e6`. Where the documentation contradicts code, §16 lists the contradiction; this section reflects **code**, not README claims.

### 2.1 Framework & runtime

- **Next.js 16.3.4 (App Router) + React 19.2.8 + TypeScript 5** (`package.json:17-30`). Node pinned `>=20.9.0` (`package.json:14-16`). Runtime deps: exactly 4 — `next`, `pg`, `react`, `react-dom`. Dev deps: 6. No Tailwind, no shadcn/ui, no ORM, no auth library, no agent framework. (`README.md:9-10` matches code.)
- **Build health:** `tsc --noEmit` exit 0 (this audit); `next build` produced 13 routes cleanly *(verified in prior ops session; not re-run here)*. A stale `.next/` build dir exists in the working tree (gitignored, untouched).
- `next.config.ts` is empty of options (`next.config.ts:1-7`). `tsconfig.json` strict mode, `noEmit`, `@/*` path alias.
- No `middleware.ts` exists (checked) — **there is no centralized request middleware of any kind**; auth is per-route-handler.
- No `.github/workflows/` (checked) — **no CI/CD pipeline exists**.

### 2.2 Frontend

- `/` — a static placeholder page: heading + one paragraph (`app/page.tsx:1-7`).
- `/admin/login` — password form; on success stores the **raw password** in `sessionStorage` under `agentos_admin_pw` and redirects (`app/admin/login/page.tsx:13-16`).
- `/admin` — the entire "Command Center": tenant-ID text box + Load, then a list of drafts with Approve / Reject (hardcoded comment `"tone"`, `app/admin/page.tsx:34`) / Schedule buttons; sends `Authorization: Bearer <password>` on every call (`app/admin/page.tsx:6-9`). Client-side gate only (`useEffect` redirect, `app/admin/page.tsx:23`); all real enforcement is server-side in the API routes. Inline styles; no component library; no state management; no routing beyond these pages.
- Layout metadata is still the create-next-app default (`app/layout.tsx:15-18` — `title: "Create Next App"`), a cosmetic but telling sign of v1 scope.
- `public/widget.js` — 106-line vanilla-JS embeddable chat (§2.13).

### 2.3 Backend / API surface (11 handlers, 3 pages, 1 static script)

| Route | Method | Auth | Handler evidence |
|---|---|---|---|
| `/api/agents/run` | POST | **none** | `app/api/agents/run/route.ts:8-29` |
| `/api/agents/sweep` | POST + `GET = POST` alias | `x-cron-secret` timing-safe | `app/api/agents/sweep/route.ts:12-24,27-28` |
| `/api/v1/chat` | POST | **none** | `app/api/v1/chat/route.ts:9-33` |
| `/api/v1/channels` | POST | **none** | `app/api/v1/channels/route.ts:10-44` |
| `/api/v1/widget/config` | GET | none (public by design) | `app/api/v1/widget/config/route.ts:6-19` |
| `/api/admin/login` | POST | compares against `ADMIN_PASSWORD` | `app/api/admin/login/route.ts:4-9` |
| `/api/admin/drafts` | GET | Bearer `ADMIN_PASSWORD` | `app/api/admin/drafts/route.ts:4-12` |
| `/api/admin/drafts/[id]` | POST | Bearer `ADMIN_PASSWORD`; auth **before** body parse | `app/api/admin/drafts/[id]/route.ts:7-27` |
| `/api/admin/migrate` | POST | Bearer `ADMIN_PASSWORD` or `OPS_TOKEN` | `app/api/admin/migrate/route.ts:15-34` |
| `/api/admin/seed` | POST | Bearer `ADMIN_PASSWORD` or `OPS_TOKEN` | `app/api/admin/seed/route.ts:16-56` |
| `/api/admin/env-check` | GET | Bearer `ADMIN_PASSWORD` or `OPS_TOKEN` | `app/api/admin/env-check/route.ts:28-53` |

Error contract is uniform: `{ errors: [{ code, detail? }] }` with 4xx/5xx codes; 5xx bodies carry a fixed generic detail (e.g. `channels/route.ts:42`, `chat/route.ts:31`). There is no request-ID, no rate-limit header, no pagination anywhere.

### 2.4 Database

- **PostgreSQL (Neon) + pgvector**, accessed via `pg` `Pool` keyed on `DATABASE_URL` with a bigint→Number type parser (`lib/db.ts:1-9`) and a manual `transaction()` helper (`lib/db.ts:11-30`).
- **11 tables** created by one idempotent DDL string (`lib/migrations.ts:9-120`), consumed by `scripts/migrate.ts` (CLI) and `POST /api/admin/migrate` (deployed envs). `AGENTOS_TABLES` pins the expected set (`migrations.ts:122-125`). Schema was applied to the live Neon DB and verified 11/11 *(prior ops session)*.
- Schema summary (authoritative source `lib/migrations.ts`): `tenants` (slug unique, status active/suspended), `tenant_config` (brand_voice, persona, audience, content_system_prompt), `channels` (kind ∈ linkedin/x/instagram/tiktok/email, token_encrypted, status healthy/unhealthy, unique tenant+kind), `content_sources` (kind ∈ sitemap/upload/api), `documents` (checksum), `chunks` (content, `vector(1536)`, ivfflat lists=100), `agent_runs` (agent, trigger, status ∈ pending/completed/failed, prompt_hash, output_ref), `drafts` (6-state FSM status), `approvals` (decision approved/rejected, comment — **no reviewer identity**), `leads` (stage ∈ new/contacted/responded/converted/dead), `outbox` (draft_id, channel, external_id, status ok/failed, error).
- **No RLS, no DB-level tenant enforcement, no CHECK on `drafts.channel`, no updated_at columns, no soft deletes.** Isolation is 100% application-side `WHERE tenant_id = $1` (consistently applied — see §10.9).

### 2.5 Authentication

- Exactly one user class: holder of `ADMIN_PASSWORD`. Three guards: `authorizeAdmin` (password), `authorizeOpsOrAdmin` (password or `OPS_TOKEN`) — both timing-safe via `safeEqual` (`lib/admin.ts:5-19`, `lib/security.ts:3-9`).
- `POST /api/admin/login` just re-compares the password and tells the client "ok"; **no session is created** — the browser then replays the raw password as a Bearer token from `sessionStorage` (`app/admin/login/page.tsx:13-16`, `app/admin/page.tsx:6-9`).
- Sweep: `x-cron-secret` header, timing-safe (`sweep/route.ts:13-16`).
- Public endpoints (`chat`, `run`, `channels`, `widget/config`) have **no authentication and no rate limiting** (§10).
- No CSRF tokens (bearer-header model mitigates classical CSRF for the admin API, but the unauthenticated POST endpoints are plain open), no brute-force lockout on login, no token expiry.

### 2.6 Authorization

- **None in any granular sense.** There are no roles, no permissions, no per-tenant admin scoping: the single password unlocks every tenant's drafts (admin UI takes an arbitrary tenant ID; `drafts/route.ts:8-11` validates only the digits format). The design spec's "per-tenant approval inbox / tenant-scoped login" (`docs/specs/2026-09-09-agentos-design.md:101`) was **never implemented**.
- Agent-side authorization does not exist: any caller of `/api/agents/run` triggers any agent for any tenant.

### 2.7 Agent architecture

- **5 agents as a TypeScript const array** (`lib/agents/catalog.ts:5-11`): research, marketing, sales, ambassador, customer_service. Fields: `id`, `name`, `description` only — no model, no tools, no permissions, no knowledge scopes, no autonomy, no budget, no version.
- **Instantiation:** there is none — "running an agent" means calling `generateDraft()` with one of four hardcoded role-prompt templates (`lib/agents/generators.ts:8-13`) + tenant brand fields + a per-channel style hint (`generators.ts:27-36`). `customer_service` never generates; it answers chat from RAG (`lib/agents/chat.ts`).
- **Instructions:** template literals in code, assembled at `systemPromptFor()` (`generators.ts:15-25`). The `tenant_config.content_system_prompt` column is selected into `TenantCfg` but **never referenced by any prompt builder** — dead configuration (grep-verified across `lib/` and `app/`).
- **Versions:** none. No prompt versioning; `agent_runs.prompt_hash` is populated with the **raw topic string, not a hash** (`dispatch.ts:29` — `const promptHash = goal.topic`), so the audit field is misnamed and unhashlike.
- **Tools:** none. Agents receive no tools; the "tools" listed in the design spec (`docs/specs/2026-09-09-agentos-design.md:36-42` — web search, corpus retrieval, lead store) were not built; research/marketing/ambassador prompts get **no retrieved context at all** — generation is pure LLM from the topic line (the RAG corpus is only wired to `customer_service` chat and the seed demo's ingestion).
- **Model selection:** global env (`OPENAI_MODEL` default `gpt-4o-mini`, `OPENAI_EMBEDDINGS_MODEL` default `text-embedding-3-small`) with per-call override plumbing that no agent uses (`lib/llm.ts:8-9,21`).
- **Budgets/timeouts:** none anywhere — no token budget, no cost cap, no request timeout, no execution deadline.
- **Run logging:** `agent_runs` row written **after** success, always `status='completed'` (`core.ts:34-39`); failures during generation are never recorded as failed runs (the API route returns 500 with no run row — `run/route.ts:26-28`). No error column, no model/tokens/cost/duration columns.
- **Failure handling:** none (no retries, no backoff, no dead-lettering; exceptions bubble to the route's generic 500).
- **Reusability verdict for the target:** the *pattern* (plain functions + injectable LLM + audit row) is safe to reuse; the *registration, instructions, and run-lifecycle* must be replaced by the Registry/versions/runs model (§6).

### 2.8 Orchestration

- Single entry point `dispatch()` (`lib/agents/dispatch.ts:24-47`): route via `routeAgent()` keyword match → generate draft → record run. Routing rules: channel `chat` ⇒ customer_service (checked first); topic contains research/news/intel/trend/brief/gather ⇒ research; outreach/pitch/lead/partnership/prospect/sell/sales ⇒ sales; promote/awareness/mention/testimonial/event/ambassador/endorse ⇒ ambassador; default ⇒ marketing (`core.ts:4-24`).
- Trigger is exclusively synchronous HTTP (`POST /api/agents/run`) or the demo seed. The sole scheduled job is the publishing sweep (`vercel.json:2-4`, daily 03:30 UTC on Vercel Hobby; the route also accepts GET for cron compatibility, `sweep/route.ts:27-28`).
- No queues, no events, no webhooks, no background worker process, no idempotency keys, no cancellation. Long-running work runs inside the request lifecycle (contrary to Master Arch §27).

### 2.9 AI/LLM integration

- `lib/llm.ts` — hand-rolled OpenAI REST client (57 lines): `complete()` (chat completions) + `embed()` (embeddings), Bearer key from env, `makeLLM(fetchImpl)` factory for testability, module-level singleton `llm`. No streaming, no structured outputs/JSON mode, no retries, no timeouts, no fallback, no token/cost capture, no request logging. Provider is hardcoded to `api.openai.com`.
- Live status: the configured production key exists but has **no quota** — seed returns OpenAI 429 `insufficient_quota` *(verified in prior ops session; NOT re-verified in this audit — no LLM call was made)*. All non-LLM paths confirmed working live (§11).

### 2.10 RAG / knowledge architecture

- **Ingestion** (`lib/rag/ingest.ts`): text in → whitespace collapse → fixed 800-char chunks (no overlap, no sentence awareness) → embeddings via `ctx.embed` → `documents` + `chunks` rows; sha256 checksum dedup skips re-embedding identical text (test-verified, `tests/rag-tests.ts:73-84`); embed-count guard prevents phantom docs (`tests/rag-tests.ts:86-100`). `content_sources.kind` supports sitemap/upload/api, but **no fetcher exists** — nothing in the repo fetches a sitemap, a URL, a PDF, DOCX, CSV, or RSS; ingestion happens only by calling `ingestText()` programmatically (seed script / seed endpoint).
- **Retrieval** (`lib/rag/retrieve.ts`): embed query → top-K cosine nearest chunks filtered by `tenant_id`. Purely semantic; no keyword/hybrid search, no metadata, jurisdiction, language, authority, or date filters.
- **Grounding:** `answerChat()` (`lib/agents/chat.ts`) answers **only** from retrieved passages at temperature 0.2, returns `{answer, sources[]}`, and explicitly handles the empty-retrieval case ("no passages retrieved"). Fabrication guard tested (`tests/chat-tests.ts:55-58`); cross-tenant isolation tested (`tests/chat-tests.ts:99-103`).
- **Isolation:** every read filters `tenant_id`; suspended tenants unresolvable via widget config (`lib/widget.ts:17-22`, tested `tests/widget-tests.ts:55-61`).

### 2.11 Approvals

- FSM in code (`lib/agents/approval.ts:5-12`): `pending → approved|rejected`; `approved → scheduled`; `scheduled → posted|failed`; terminal `rejected/posted/failed`. Transitions validated by read-then-write (`approval.ts:18-25`) — non-transactional.
- Every approve/reject writes an `approvals` audit row; rejection stores `review_notes` on the draft (`approval.ts:36-45`). **No reviewer identity, no risk level, no reason codes, no edit-before-approve** (the admin UI's reject always sends comment `"tone"` — `app/admin/page.tsx:34`).
- Publish path: sweep selects all `scheduled` drafts across all tenants, skips instagram/tiktok (draft-only by design), requires a healthy channel row, decrypts the token, publishes, marks posted/failed, writes `outbox`, flips channel to `unhealthy` on failure (`publishers/index.ts:75-103`).

### 2.12 Publishing / channels

- 5 channel kinds; **live**: x (`POST api.x.com/2/tweets`), linkedin (`POST api.linkedin.com/v2/shares`), email (Resend API); **draft-only**: instagram, tiktok (`publishers/index.ts:56-67`). Adapters are injected with `fetchImpl` for testing; endpoints/payloads verified by `tests/publishers-tests.ts:92-111`.
- **LinkedIn gap:** `author: p.target ?? "urn:li:person:unknown"` (`publishers/index.ts:58`) — no schema column stores a per-tenant author URN, and `sweepDue` never selects a target (`publishers/index.ts:84-85`), so live LinkedIn publishing would 4xx against a real token. **NOT VERIFIED end-to-end** (no live post attempted in this audit).
- **Email gap:** recipient is `p.target ?? env.EMAIL_TARGET` (`publishers/index.ts:48`) — global blast address; per-tenant/per-lead routing not implemented (HANDOFF.md §8 admits this).
- Token lifecycle: plaintext pasted once via unauthenticated `POST /api/v1/channels` → AES-256-GCM at rest → decrypted only in the sweep route's publish callback (`sweep/route.ts:17-22`). No OAuth flows for X/LinkedIn (tokens are long-lived pastes), no signature-verified inbound webhooks (Master Arch §77).

### 2.13 Customer-service widget

- `public/widget.js`: self-contained IIFE; reads `data-tenant`/`data-brand`/`data-base` **from the script tag itself**; injects styles + floating toggle + panel; POSTs `{tenantId: Number(tenant), question}` to `/api/v1/chat`; renders answer + first source title; CSP-safe (no eval/inline handlers/external calls — `tests/widget-tests.ts:84-86`). No conversation persistence, no session identity, no reconnect/backoff, single-source citation display.
- Config endpoint returns only `{tenantId, brand}` for active tenants (brand-safe; asserted by tests `tests/widget-tests.ts:43-44`).

### 2.14 Tenancy

- One flat table `tenants` (id, slug, name, status, created_at). Tenant = brand = website = channel set = knowledge scope, all in one. `tenant_config` adds 4 brand fields. Creation paths: raw SQL in tests, or `runDemoSeed()` (`lib/demo-seed.ts:54-72`). No tenant self-service, no signup UI, no domains, no per-tenant secrets beyond channel tokens.
- Live state: 1 seeded tenant `acme-homes` (id 491) + widget config serving real data (this audit's GET probe).

### 2.15 Background jobs / cron

- One cron: `vercel.json` → `/api/agents/sweep` daily `30 3 * * *` (Hobby-plan constraint, documented `AGENTOS-RUNBOOK.md:154-158`). In-process sweep loop; no job table, no attempts/max_attempts, no retry, no lock — two concurrent sweeps could double-publish (mitigated only by FSM terminality after first success). Master Arch §28's job-queue contract is absent.

### 2.16 Testing

- 14 suites run sequentially in separate `tsx` processes with `--env-file=.env.local` (`tests/run-all.ts:3-13`, `package.json:10`). ≈1,856 lines. Style: custom `check()` counters, live-Neon integration with unique-slug fixtures and `finally` cleanup, stubbed `LLMClient`/`fetchImpl` seams. Coverage map and gaps: §15.

### 2.17 Deployment & operations

- Vercel Hobby, project `masteragent` (`prj_2fETMrfjCsoskRRzbnkGKDTRnaOE`), production alias `masteragent-nine.vercel.app`. Deployed via CLI (GitHub webhook had never fired) *(prior ops session)*. 12 runtime env vars verified present via `GET /api/admin/env-check` *(prior ops session)*. Ops endpoints (migrate/seed/env-check) enable remote bootstrap without terminal access. No staging environment, no preview-DB separation, no backups/DR definition, no uptime monitoring, no cost telemetry.
- Live probes this audit: all 200s as listed in the attestation; unauthenticated admin API correctly 401.

---

## 3. TARGET ARCHITECTURE SUMMARY (FROM THE MASTER TECHNICAL ARCHITECTURE)

The Master Technical Architecture (v1.0, 4,218 lines, 167 numbered requirements + phased build plan) is summarized here only to the depth needed for gap classification. Section numbers below refer to that document.

**Core shape (§2, §118).** Five layers: Presentation (Command Center web UI) → Platform/Orchestration (API core, Task Manager, Workflow Engine) → AI Workforce (Supervisor + specialist agents) → Knowledge/Data (global / business / jurisdiction knowledge) → Integration Layer (websites, social, external APIs). Cloud-first (§3): execution never depends on the owner's machine; the browser is the CEO workstation (§4).

**Tenancy & multi-website (§8–§12, §120–§124).** Primary object is `BusinessUnit` with fields id/name/slug/domain/description/industry/market/jurisdictions/languages/audience/brand_voice/business_goals/status/autonomy_level. Each BU has one or more `Websites` (business_unit_id, domain, environment, framework, cms, api_endpoint, integration_status). "Add Website" must be pure configuration — no redeploy, no code. Websites expose enumerated **capabilities** (READ_CONTENT, CREATE_CONTENT, UPDATE_CONTENT, PUBLISH_CONTENT, READ_LEADS, CREATE_LEAD, READ_ANALYTICS, SEND_NOTIFICATION, READ_PRODUCTS) that agents may use only when explicitly granted. Initial BUs (WakeelyPro, Mokhamen, Almizan, LegalWakeely) are seed rows, never hard-coded. One platform + configuration + connectors = many websites.

**Platform database (§13–§14).** ~40 core tables: users/roles/permissions; business_units/websites/website_integrations/website_capabilities; agents/agent_versions/agent_tools/agent_permissions; tasks/task_steps/workflows/workflow_runs; approvals/approval_actions; knowledge_sources/knowledge_documents/knowledge_chunks; research_items/competitors/competitor_events; content_items/content_versions/content_publications; social_accounts/social_posts/social_campaigns; leads/inquiries/conversations; goals/goal_progress/recommendations; agent_runs/agent_events/audit_logs; notifications/system_settings. Every business record carries `business_unit_id` (NULL only for intentionally global records).

**Knowledge (§15–§19, §125–§128).** Four logical levels — Global → Business → Jurisdiction → Agent. Retrieval is **always filtered** by business_unit, jurisdiction, language, agent, document_type, access_level; agents never receive all documents. Sources carry authority tiers 1–5 (government → unverified social) and refresh metadata. Hybrid retrieval preferred (semantic + keyword + metadata + date). Ingestion must support URLs, sites, PDF, DOCX, text, CSV, RSS, APIs, GitHub repos, structured DBs. Central AI/Legal intelligence cores feed multiple BUs by explicit authorization.

**Agents (§20–§25, §83–§87).** Agents are configurable DB objects: id/slug/purpose/version/model_provider/model/system_instructions/tools/permissions/knowledge_scopes/autonomy_level/budget_limit/timeout/status. A central **Agent Registry** lists ~18 initial agents (Supervisor, Research, Intelligence, Legal Intelligence, Competitor, Content Strategy, Content, Fact Check, SEO, Social, Marketing, Lead, Sales, Customer Inquiry, Customer Support, Analytics, Strategy, Reporting), enableable per BU. Supervisor plans, delegates, monitors, escalates, enforces policy — with bounded permissions. Handoffs are logged. Agent instructions are versioned prompts held as configuration (§84–§85); outputs are structured and schema-validated (§86–§87). Named input/output contracts exist for Research, Intelligence, Content, Sales, Analytics, Supervisor (§52–§57).

**Tasks & workflows (§24–§26, §28–§30).** Tasks carry business_unit_id, created_by, assigned_agent, priority, objective, input, deadline, budget, autonomy_level and statuses PENDING/RUNNING/WAITING_APPROVAL/COMPLETED/FAILED/CANCELLED/ESCALATED. Workflows are deterministic (schedule/event/webhook/manual/goal triggers) and explicitly preferred over agents whenever the sequence is predictable (§7 is a mandatory distinction). Background execution is required — the browser must not stay open (§27). Jobs have attempts/max_attempts/errors; transient failures retry with configurable limits (§28–§29). Agent execution loop: validate permissions → load context → plan → act → observe → continue/stop/escalate (§30).

**Tools & integrations (§31–§39, §46).** Agents act only through tools (web_search, fetch_url, read_document, search_knowledge, create_draft, publish_content, read_analytics, create_lead, send_email, schedule_social_post), each with schema/permission/validation/logging/timeout/rate limit, classified LOW/MEDIUM/HIGH/CRITICAL risk. WebsiteConnector standard operations (getContent, createDraft, publishContent, getLeads, getAnalytics, getSiteStatus) behind adapters (Next.js/WordPress/custom API/CMS). Existing websites are never assumed owned; no destructive changes; integration preference order: official API → CMS API → dedicated endpoint → webhook → controlled DB → other.

**AI Gateway (§41–§44).** All AI calls pass a central gateway: model routing, auth, cost tracking, request logging, policy enforcement, rate limits, model fallback, prompt/version tracking. Internal `AIProvider` abstraction (generate/stream/embed/moderate) with OpenAI/Anthropic/Google adapters. Per-execution cost records (provider, model, input_tokens, output_tokens, estimated_cost, execution_time); dashboards show cost per agent/website/workflow/task/month.

**Autonomy, approvals, policy (§45–§51, §88–§94).** Autonomy levels 0–5 (human-only → goal-autonomous); production default conservative. Approval Engine routes HIGH-risk actions (publish/send/modify) through a queue with approval records (approval_id, task_id, requested_action, requested_by_agent, risk_level, reviewer, decision, decision_reason). Policy Engine decides what agents may do (e.g., publish on Mokhamen ⇒ approval; legal_advice ⇒ prohibited autonomously). Legal-safety hierarchy narrows autonomy from general information down to professional representation (§50). Idempotency and duplicate detection required for publish/send (§88–§89). Initial autonomy matrix: research/drafts/recommendations AUTO; campaigns, publishing, advertising APPROVAL; budget spend RESTRICTED; sales classification/scoring AUTO, legal advice HUMAN.

**Data systems (§59–§66, §95–§104).** Competitors as entities with sources/events/snapshots. Content lifecycle IDEA→RESEARCHING→DRAFT→FACT_CHECK→REVIEW→APPROVED→SCHEDULED→PUBLISHED→ARCHIVED with never-lose versioning. Social posts are independent records linked to source content (draft/approved/scheduled/published/failed). Leads have source/website/inquiry/score/stage (NEW…LOST)/assigned_agent/human_owner. Inquiries carry website/channel/customer/message/language/classification/priority/sentiment/lead_score. Conversations are customer-facing records stored separately from internal reasoning — no hidden reasoning exposure. Goals (objective/KPI/target/deadline/budget/allowed_agents/constraints) drive a bounded autonomous loop.

**Observability, errors, audit (§68–§72, §117, §157).** Traceable run events (RUN STARTED … RUN COMPLETED); agent_runs records with run_id/agent_id/task_id/business_unit_id/workflow_id/model/status/cost/error. Error classes: TRANSIENT/CONFIGURATION/AUTHENTICATION/MODEL/TOOL/POLICY/CRITICAL. Audit log: who/what/when/where/why/agent/tool/website/authorization/result. Non-technical error surfacing ("Research Agent could not access Source X").

**Security (§73–§79, §100–§101).** Secure auth, RBAC, RLS where applicable, encrypted transport & secrets, least privilege, token rotation, audit logging, rate limiting at user/agent/website/integration/API/workflow levels, session protection, CSRF where applicable, secure webhooks (signature, timestamp, replay protection, rotation), signed integration requests. Roles: Owner/Administrator/Operator/Reviewer/Analyst/Developer/Agent. Agents get machine identities and never use admin credentials. Data classification PUBLIC→RESTRICTED; customer data isolated per BU. Emergency controls: STOP ALL AGENTS / STOP ALL AUTOMATIONS / PAUSE WEBSITE / DISABLE SOCIAL PUBLISHING / DISABLE EMAIL / DISABLE SPECIFIC AGENT / REVOKE INTEGRATION (§79).

**Command Center UX (§80–§82, §149–§151, §166).** Navigation: Dashboard; Websites; AI Workforce (Agents/Runs/Tasks/Workflows); Intelligence; Content; Marketing; Sales; Knowledge; Analytics; Approvals; Integrations; Security; Settings. Agent dashboards show success rate, cost, duration, errors, permissions, autonomy. No-code operations for add website/enable agent/approve/change autonomy/connect integrations/create goals/pause automation; developer mode separate.

**Operational requirements (§108–§117, §135, §140–§148).** Test pyramid incl. agent evaluation datasets and security boundary tests. Production safety progression Sandbox → Read-only → Approval → Limited Autonomous → Full. Dev/staging/prod environments; feature flags; GitHub→CI/CD→cloud deploy; version-controlled migrations (no agent may alter production schema); backups, RPO/RTO; observability stack (uptime, API errors, agent failures, job failures, DB health, integration health, AI costs, latency). Scalability floor: 10+ websites, 20+ agents, hundreds of workflows, thousands of tasks without redesign. Failure isolation per website/agent/integration mandatory (§144–§146). Data ownership/exportability (§147–§148).

**Build sequence (§135–§139, §164–§165).** Phases 0–16: architecture validation → platform foundation → agent registry → task+workflow engine → AI gateway → knowledge → research workforce → content → SEO → social → marketing → sales/customer → connectors → supervisor → controlled autonomy → goal-driven operations. MVP = Command Center, BUs, Website Manager, Auth, Agent Registry, Task Engine, Workflow Engine, Approval Center, Knowledge System, Supervisor, Research Agent, Intelligence Agent, Audit Logs, Notifications. First use case: daily AI/legal-AI intelligence; *not* autonomous publishing. Critical rule: "build the infrastructure that makes an autonomous AI company controllable" first.

---

## 4. FULL KEEP / MODIFY / REPLACE / ADD MATRIX

Classifications: **KEEP** = substantially aligned, reusable as-is. **MODIFY** = useful implementation exists but must change to meet the target. **REPLACE** = materially conflicts with the target; its replacement supersedes it (salvageable pieces noted). **ADD** = does not exist. **DEFER** = intentionally later-phase. "Reuse potential" is a judgment of how much of the artifact survives into the target.

| # | Area | Current AgentOS implementation | Target requirement (Master Arch §) | Classification | Reuse potential | Required change | Risk | Evidence |
|---|---|---|---|---|---|---|---|---|
| 1 | Runtime & framework | Next.js 16 App Router, React 19, TS strict, 4 deps | Next.js/TS stack preferred (§6) | **KEEP** | High | none | Low | `package.json:17-30` |
| 2 | UI component baseline | Inline-styled single page, no Tailwind/shadcn | Tailwind + shadcn/ui + Lucide (§6) | **MODIFY** | Medium | adopt component baseline when Command Center UI is built (Phase 1) | Low | `app/admin/page.tsx` |
| 3 | DB connection seam | `pg` Pool, bigint parser, `transaction()` helper | PostgreSQL primary DB (§13) | **KEEP** | High | none (optionally add pooling tuning) | Low | `lib/db.ts` |
| 4 | Schema management | One idempotent DDL string; CLI + Bearer endpoint | Version-controlled migrations; no autonomous schema change (§114) | **MODIFY** | High | split DDL into ordered, versioned, recorded migrations; keep endpoint as runner | Medium | `lib/migrations.ts`, `app/api/admin/migrate/route.ts` |
| 5 | Tenancy root | `tenants` flat table (slug/name/status) | `business_units` + `websites` hierarchy, autonomy_level, jurisdictions, languages (§8–§10) | **MODIFY** | High | promote `tenants` → `business_units` (add columns), add `websites` child; keep `tenants` as view/alias during transition | High | `lib/migrations.ts:12-26` |
| 6 | Brand config | `tenant_config` (brand_voice/persona/audience + dead content_system_prompt) | BU brand_voice/audience + structured config (§9, §98) | **MODIFY** | High | fold into business_units; wire or drop the dead prompt column | Low | `lib/migrations.ts:20-26`, `dispatch.ts:11-18` |
| 7 | Channel credentials | `channels` (5 kinds, AES-GCM token, health, unique tenant+kind) | `social_accounts` + `website_integrations` with capability scoping (§12, §34) | **MODIFY** | High | add target/author + per-tenant email routing; generalize into integrations with capability grants; move behind auth | Medium | `lib/migrations.ts:28-36`, `publishers/index.ts:56-67` |
| 8 | Knowledge sources | `content_sources` (sitemap/upload/api kinds, no fetcher) | `knowledge_sources` with source_type/authority/jurisdiction/language/refresh (§17–§18) | **MODIFY** | High | add metadata columns; implement actual fetchers per source type | Medium | `lib/migrations.ts:38-44`, `rag/ingest.ts` |
| 9 | Documents & chunks | `documents` (checksum dedup) + `chunks` (`vector(1536)`, ivfflat) | `knowledge_documents`/`knowledge_chunks` + 4-level scoping (§15–§16) | **MODIFY** | High | add jurisdiction/language/access_level/agent_scope columns; make dimension configurable or use halfvec/expr index | Medium | `lib/migrations.ts:46-65` |
| 10 | Retrieval engine | cosine top-K, tenant filter | hybrid semantic+keyword+metadata+jurisdiction+authority+date (§19) | **MODIFY** | High | add filters + keyword leg (tsvector) + scope resolution | Medium | `lib/rag/retrieve.ts` |
| 11 | Ingestion pipeline | text → 800-char chunks → embed; checksum dedup; guards | URL/PDF/DOCX/CSV/RSS/API ingestion, normalization incl. Arabic-safe (§17) | **MODIFY** | High | add source fetchers, smarter chunking, language detection; keep dedup + guard pattern | Medium | `lib/rag/ingest.ts` |
| 12 | Agent definitions | `AGENT_CATALOG` code const, 5 agents, description-only | Agent Registry DB table, ~18 agents, enable-per-BU (§20–§21) | **REPLACE** | Medium | registry tables + seeding; keep catalog module as seed source | Medium | `lib/agents/catalog.ts:5-11` |
| 13 | Agent instructions | hardcoded role templates + brand interpolation; unused content_system_prompt | versioned `system_instructions` in DB, prompt versioning per execution (§84–§85) | **REPLACE** | Medium | move prompts to `agent_versions`; log version per run | Medium | `lib/agents/generators.ts:8-25` |
| 14 | Agent tools & permissions | none (agents receive no tools) | `agent_tools`/`agent_permissions`, tool schema/permission/logging/timeout/rate-limit (§31–§32) | **ADD** | — | build Tool Registry + permission checks into execution loop | High | absent |
| 15 | Agent runs | `agent_runs` (always-completed rows, prompt_hash=raw topic) | run lifecycle PENDING/RUNNING/…, model/cost/tokens/duration/error (§69, §44) | **MODIFY** | High | add columns; write runs at start with real status transitions; hash prompts properly | Medium | `lib/agents/core.ts:27-40` |
| 16 | Run events | none | `agent_events` trace (RUN STARTED…RUN COMPLETED) (§68) | **ADD** | — | event writer in execution loop | Low | absent |
| 17 | Routing | `routeAgent()` keyword router | Task Engine + Workflow Engine + Supervisor delegation (§22, §24–§26) | **MODIFY** | Medium | keep as deterministic routing step inside workflow engine; not the orchestrator | Medium | `lib/agents/core.ts:9-25` |
| 18 | Dispatch loop | `dispatch()` sync request-scoped execution | background job execution, retries, cancellation, idempotency (§27–§29) | **MODIFY** | High | wrap dispatch as a task executor invoked by job runner | High | `lib/agents/dispatch.ts:24-47` |
| 19 | Tasks | none | `tasks`/`task_steps` with statuses incl. WAITING_APPROVAL/ESCALATED (§24) | **ADD** | — | full task engine | High | absent |
| 20 | Workflows | none | `workflows`/`workflow_runs`, schedule/event/webhook/manual/goal triggers (§25–§26) | **ADD** | — | deterministic workflow engine (cron exists as a precursor) | High | absent |
| 21 | Job queue | none (sweep is an in-process loop) | job table with attempts/max_attempts/error (§28) | **ADD** | — | outbox/job table + claim loop; reuse cron as scheduler | High | absent |
| 22 | Event bus | none | internal events (website.inquiry.created … agent.failed) (§95) | **ADD** | — | DB-backed event table + pollers or broker | Medium | absent |
| 23 | Approval FSM | drafts FSM + `approvals` rows (no reviewer id) | Approval Engine + approval records with reviewer/risk/reason; task-level approvals (§47–§48) | **MODIFY** | High | add reviewer, risk_level, requested_action, task linkage; make transitions transactional | Medium | `lib/agents/approval.ts` |
| 24 | Draft/content store | `drafts` single row per artifact | `content_items`+`content_versions` (never overwrite), 9-state lifecycle (§60–§61) | **MODIFY** | High | evolve drafts → content_items; add versions table; map FSM states into lifecycle | Medium | `lib/migrations.ts:78-87` |
| 25 | Publications | `outbox` result log | `content_publications` + idempotent publish queue (§88) | **REPLACE** | Medium | outbox is a write-behind log, not a queue; replace with publications + job claims; keep outbox as archive or drop | Medium | `lib/migrations.ts:110-119` |
| 26 | Publishers | Publisher interface; x/linkedin/email live; IG/TikTok draft-only; channel-health flip | Integration adapters with capability + risk classification (§34–§36, §46) | **KEEP** | High | keep adapter pattern; fix LinkedIn target plumbing; add per-tenant routing; classify actions | Medium | `lib/agents/publishers/index.ts` |
| 27 | Channel wire-up API | unauthenticated `POST /api/v1/channels` | authenticated integration management (§76) | **REPLACE** | Low | move behind admin/integration auth with signed requests | High | `app/api/v1/channels/route.ts` |
| 28 | Customer-service chat | RAG-grounded `answerChat` + public chat route | Customer-facing AI as controlled interface; conversations persisted separately (§40, §65) | **MODIFY** | High | keep grounding pattern; add `conversations` persistence + inquiry capture + rate limits | Medium | `lib/agents/chat.ts`, `app/api/v1/chat/route.ts` |
| 29 | Widget | vanilla-JS embed, CSP-safe | Website-side micro-integration; not whole workforce in site (§39–§40) | **KEEP** | High | keep; add config signing/site binding + conversation continuity | Low | `public/widget.js` |
| 30 | Widget config API | public `{tenantId, brand}` by slug/id | per-website public config incl. capability exposure | **MODIFY** | High | re-key by website; keep brand-safe minimal shape | Low | `lib/widget.ts` |
| 31 | Leads | `leads` (5 stages, source=agent) | leads with score/website/assigned_agent/human_owner, 6 stages (§63) | **MODIFY** | High | align stages; add score + ownership columns | Low | `lib/migrations.ts:97-108` |
| 32 | Inquiries | none | `inquiries` with classification/priority/sentiment (§64) | **ADD** | — | capture from widget/chat + future webhooks | Medium | absent |
| 33 | Conversations | none (chat stateless) | `conversations` separated from internal reasoning (§65) | **ADD** | — | persist user-visible messages + outcomes | Medium | absent |
| 34 | Research/competitor intelligence | none | research_items, competitors, competitor_events (+snapshots) (§58–§59) | **ADD (DEFER to Phase 6)** | — | research workforce phase | Medium | absent |
| 35 | Social campaign system | none (posts are drafts) | social_accounts/social_posts/social_campaigns (§62) | **ADD (DEFER to Phase 9)** | — | extend current channels/drafts lineage | Medium | absent |
| 36 | Goals & recommendations | none | goals/goal_progress/recommendations (§66, §104) | **ADD (DEFER to Phase 14–16)** | — | goal loop phases | Low | absent |
| 37 | LLM client | `lib/llm.ts` OpenAI-only complete+embed, injectable fetch | AI Gateway: routing, cost, logging, fallback, policy, rate limits; AIProvider abstraction (§41–§43) | **MODIFY** | High | keep `LLMClient` interface as provider adapter seam; wrap with gateway (tracking, budgets, retries) | High | `lib/llm.ts` |
| 38 | Token/cost accounting | none | per-run token+cost records, cost dashboards (§44) | **ADD** | — | usage extraction from provider responses | Medium | absent |
| 39 | Autonomy model | none (approval always required for publishes) | levels 0–5 per agent/BU; risk-classified actions (§45–§46) | **ADD** | — | conservative defaults; publish stays approval-gated | High | absent |
| 40 | Policy engine | none | policy rules (publish⇒approval; legal_advice⇒prohibit) (§49–§50) | **ADD (DEFER to Phase 15)** | — | needed before any autonomy expansion | High | absent |
| 41 | Identity & auth | shared ADMIN_PASSWORD as password+bearer; sessionStorage | users/roles/sessions, managed auth (§73–§74, §6) | **REPLACE** | Low | real auth: users table + sessions/OAuth; agents get machine identities (§75) | High | `app/admin/login/page.tsx`, `lib/admin.ts` |
| 42 | RBAC | none | Owner/Admin/Operator/Reviewer/Analyst/Developer/Agent roles (§74) | **ADD** | — | roles + permission checks per route | High | absent |
| 43 | Audit log | only `approvals` rows | `audit_logs` who/what/when/where/why/agent/tool/website/result (§72) | **ADD** | — | write audit on every mutation | High | absent |
| 44 | Rate limiting | none | at user/agent/website/integration/API/workflow (§78) | **ADD** | — | per-IP + per-tenant limits on public endpoints first | High | absent |
| 45 | Webhooks (inbound) | none | signature + timestamp + replay protection (§77) | **ADD (DEFER to Phase 13)** | — | needed for website event ingestion | Medium | absent |
| 46 | Emergency controls | none | STOP ALL AGENTS / pause website / disable publishing / revoke integration (§79) | **ADD** | — | global flags consulted in dispatch + sweep | High | absent |
| 47 | Feature flags | none | flag-controlled major features (§112) | **ADD** | — | system_settings-backed flags | Low | absent |
| 48 | Notifications | none | notification service, INFO→CRITICAL priorities (§96) | **ADD (DEFER to Phase 3+)** | — | start with dashboard + email on approval events | Low | absent |
| 49 | Command Center UI | `/admin` one-page draft queue | full navigation per §80–§82, no-code ops (§150) | **REPLACE** | Low | build Command Center; keep approve/reject/schedule interactions as a module | Medium | `app/admin/page.tsx` |
| 50 | Ops endpoints | Bearer-guarded migrate/seed/env-check | (no direct counterpart; supports §113 deployment, §114 migrations) | **KEEP** | High | keep; add env separation + audit each call | Low | `app/api/admin/*` |
| 51 | Demo seed | `runDemoSeed` idempotent bootstrap | seed/configuration data (§122) | **KEEP** | High | re-target to business_units/websites post-migration | Low | `lib/demo-seed.ts` |
| 52 | Testing harness | 14 tsx suites, live-DB integration, stub seams | unit/integration/agent/workflow/security/regression suites (§108–§109) | **KEEP** | High | add auth/RBAC, workflow, gateway, and cost-tracking suites | Medium | `tests/` |
| 53 | Cron scheduler | Vercel cron daily (Hobby limit) | workflow scheduler (§26) | **KEEP** | Medium | treat as workflow trigger #1; Hobby limit forces Pro or external scheduler later | Low | `vercel.json:2-4` |
| 54 | Env & config | 12 env vars, `.env.example` documented | env registry, dev/staging/prod separation (§111, §155–§156) | **MODIFY** | Medium | add staging; document registry; separate secrets from config | Medium | `.env.example` |
| 55 | CI/CD | none (CLI deploys) | GitHub → CI/CD → cloud (§113) | **ADD** | — | GitHub Actions: typecheck, tests (against ephemeral DB), build, deploy | Medium | absent |
| 56 | Observability/monitoring | none (env-check only) | uptime/error/cost/health monitoring (§117, §70) | **ADD** | — | start with structured logs + health endpoint | Medium | absent |
| 57 | Backups / DR | none | backups, RPO/RTO (§115–§116) | **ADD (DEFER to pre-production)** | — | Neon PITR + restore drill | Medium | absent |

**Matrix roll-up:** KEEP 9 · MODIFY 22 · REPLACE 5 · ADD 18 (of which 6 deferred by phase) · DEFER explicitly marked 4. The single most consequential MODIFYs are #5 (tenancy), #12–#14 (registry/tools/permissions), #17–#21 (orchestration), #37–#38 (gateway), #41–#44 (security). The REPLACEs are narrow and none of them discards a subsystem wholesale.

---

## 5. DATABASE GAP ANALYSIS

Current schema: 11 tables (`lib/migrations.ts:9-120`), all `CREATE TABLE IF NOT EXISTS`, no version registry, no RLS. Target model: ~40 tables (Master Arch §13). **No migration was performed in this audit**; everything below is analysis.

### 5.1 Existing table → target entity mapping

| Current table | Closest target entity | Verdict | Detailed analysis |
|---|---|---|---|
| `tenants` | `business_units` | **REUSABLE — migrate in place** | Column-compatible core (id, slug, name, status, created_at). Missing target fields: domain, description, industry, market, jurisdictions[], languages[], audience (currently in tenant_config), brand_voice (ditto), business_goals, autonomy_level, updated_at (§9). Migration is additive: `ALTER TABLE tenants RENAME TO business_units` + add columns, or create `business_units` and copy with `tenants.id` preserved. **Do not simply rename without adding websites** — the target's meaning of BU is "a business that owns 1..n websites" (§10). Danger: external references (widget config accepts tenant slug/id; seeded live tenant id=491) must keep resolving during transition. |
| `tenant_config` | folds into `business_units` | **MIGRATE — then retire** | brand_voice/persona/audience move to BU columns. `content_system_prompt` is **dead code** (loaded in `dispatch.ts:13`, never read by any prompt builder — grep-verified). Decide: wire it into the target's prompt-config model or drop it. Retiring a 1:1 satellite table is low-risk. |
| `channels` | `social_accounts` (+ partial `website_integrations`) | **MIGRATE + RENAME** | Structure (tenant/kind/token_encrypted/status, unique pair) maps well to social_accounts. Missing vs target: platform account identity (e.g. LinkedIn author URN, X handle), per-tenant email recipient, capability linkage, integration health history (§12, §34, §62). Known functional defect: no target/author column → LinkedIn publish falls back to `urn:li:person:unknown` (`publishers/index.ts:58`). Add `target`/`account_ref` + `metadata jsonb` during migration. |
| `content_sources` | `knowledge_sources` | **MIGRATE + RENAME** | Has tenant_id/kind/ref/last_synced_at; target adds url, title, authority_level (tiers 1–5), jurisdiction, language, refresh_frequency, status (§17–§18). kinds currently sitemap/upload/api; target adds rss/api/github/db. Low-risk additive migration. |
| `documents` | `knowledge_documents` | **REUSABLE — extend** | tenant_id/source_id/title/url/checksum is sound. Target adds jurisdiction, language, document_type, access_level, ingestion status, dates (§15–§17). Checksum dedup logic is worth preserving (tested). |
| `chunks` | `knowledge_chunks` | **REUSABLE — extend with care** | Core (document_id, tenant_id, content, embedding vector(1536)) + ivfflat index is the crown jewel. Two target conflicts: (a) dimension lock — `vector(1536)` bakes in one embedding model; target's multi-provider gateway (§42) implies either dimension-parametric columns per model or a `chunk_embeddings` child table keyed by model; (b) scoping — needs jurisdiction/language/access columns or join-through documents for §16 filtering. **Dangerous assumption to avoid:** "just change the model later" requires re-embedding every chunk and possibly a table rebuild — plan the dimension strategy now. |
| `agent_runs` | `agent_runs` (same name, richer) | **MIGRATE — extend** | Current: tenant_id, agent (text), trigger, status ∈ {pending,completed,failed} (always written completed post-hoc), prompt_hash (misused as raw topic), output_ref (§69 wants run_id/agent_id/task_id/business_unit_id/workflow_id/model/status/cost/error/timestamps). Additive ALTERs are safe. Rename `prompt_hash` semantics or add a real `prompt_hash` + `prompt_version`. |
| `drafts` | `content_items` + `content_versions` | **MIGRATE — restructure** | drafts conflates "content item" and "current content version" in one row (content TEXT mutable only via review_notes; no version history — target §61 forbids overwriting). Preserve the 6-state FSM semantics during transition by mapping: pending→DRAFT, approved→APPROVED, scheduled→SCHEDULED, posted→PUBLISHED, failed→(publication failure record), rejected→REVIEW(rejected). `channel` has no CHECK/FK — garbage values are insertable at DB level. |
| `approvals` | `approvals` + `approval_actions` | **MIGRATE — extend** | Missing reviewer identity, risk_level, requested_action, decision_reason, task linkage (§48). Currently `ON DELETE CASCADE` from drafts — deleting a draft **deletes the approval history**, which is contrary to audit immutability (§72). Make approvals reference content items with no cascade (or archive). |
| `leads` | `leads` | **REUSABLE — extend** | Stages differ: current new/contacted/responded/converted/dead vs target NEW/QUALIFIED/CONTACTED/FOLLOW_UP/CONVERTED/LOST (§63). Missing score, website_id, assigned_agent, human_owner, inquiry linkage. Stage rename needs a data migration (map responded→CONTACTED or FOLLOW_UP; dead→LOST). |
| `outbox` | `content_publications` (+ job queue) | **REPLACE** | Outbox is a *result log* (status ok/failed written after the fact), not a queue: no claim semantics, no attempts, no scheduled_at of its own (schedule lives on drafts), no idempotency key. Target needs content_publications (publication records) AND a job table (§28). Keep outbox rows as historical archive during migration; stop writing new publishes there once publications+jobs exist. |

### 5.2 Missing target entities (ADD list, grouped by phase)

- **Phase 1 foundation:** `users`, `roles`, `permissions` (+ user_roles), `websites`, `website_integrations`, `website_capabilities`, `system_settings`, `audit_logs`, `notifications`.
- **Phase 2 registry:** `agents`, `agent_versions`, `agent_tools`, `agent_permissions` (+ BU↔agent enablement table implied by "enableable per BusinessUnit" §21).
- **Phase 3 engine:** `tasks`, `task_steps`, `workflows`, `workflow_runs`, job/queue table, event table (§95 event bus storage).
- **Phase 4 gateway:** usage/cost records (per §44) — either columns on agent_runs or a dedicated `llm_requests` table (recommended: dedicated, keyed by run_id).
- **Phase 5–6 knowledge/research:** jurisdiction/agent-scope structures (may be columns + a `jurisdictions` reference table), `research_items`, `competitors`, `competitor_events`.
- **Phase 7–11 workforce:** `content_items`/`content_versions`/`content_publications` (evolved from drafts), `social_posts`/`social_campaigns`, `inquiries`, `conversations`.
- **Phase 14–16 autonomy:** `goals`, `goal_progress`, `recommendations`, `approval_actions`, policy tables.

### 5.3 Tenancy / isolation problems

1. **Application-level only.** Every query filters `tenant_id` by convention (verified consistent across `lib/`), and tests assert scoping (`tests/approval-tests.ts:99-108`, `tests/dispatch-tests.ts:124-141`), but nothing stops a future query from forgetting the filter. Master Arch §73 asks for "row-level security where applicable". RLS on Neon is feasible (per-request `SET LOCAL app.tenant_id` with a policy per table) and should be evaluated in Phase 1 — but note the tradeoff: pg RLS + connection pooling requires transaction-scoped GUCs; the existing `transaction()` helper (`lib/db.ts:11-30`) is the right hook.
2. **`ON DELETE CASCADE` on tenant** deletes drafts, runs, channels, chunks — convenient for tests (all suites rely on it) but catastrophic as an admin footgun in the target; audit records must not cascade.
3. **No per-website concept** — the target's "customer data stays with its BusinessUnit" (§101) currently has no place to even record which website a lead/inquiry came from (`leads` has only a free-text `source`).
4. **Cross-tenant aggregate reads** (target §99 allows owner-level cross-BU analytics) are trivially possible today via the shared password — which is itself the problem: identity must come first.

### 5.4 Dangerous migration assumptions to avoid

- **Renaming `tenants` → `business_units` alone is NOT the migration.** Without `websites`, capability grants, and re-keyed FKs, you get a renamed table that still behaves like a website. The safe sequence is: add `business_units` (+ `websites`) → backfill one BU + one website per existing tenant → add `business_unit_id`/`website_id` columns (nullable) alongside `tenant_id` → dual-write → flip readers → make `tenant_id` generated/derived → eventually fold `tenants` into a compatibility view.
- **ID stability:** the live tenant (id 491) and any embedded `data-tenant` attributes on real websites must keep resolving; widget config accepts slug or numeric id (`lib/widget.ts:15-22`) — keep both resolvable through the transition.
- **Embedding dimension:** decide the multi-model strategy before Phase 4, not after data accumulates (see chunks row above).
- **Cascades:** strip `ON DELETE CASCADE` from audit-path tables (approvals, agent_runs, outbox) in the new model; keep them only on true child data (chunks→documents).
- **`drafts.channel` / `leads.stage` / `channels.kind` CHECK constraints** will reject new target values (e.g. new social platforms, new lead stages) — plan constraint replacements, not just data updates.

### 5.5 Future extensibility notes

- All tables are `BIGINT GENERATED ALWAYS AS IDENTITY` — good for the target scale.
- No `updated_at`/trigger hygiene exists; add during Phase 1 while touching every table anyway.
- `system_settings` (target) is the natural home for feature flags and emergency switches (§79, §112) — currently absent, which is why the audit classifies emergency controls as ADD with high risk attached to their absence.

---

## 6. AGENT ARCHITECTURE AUDIT

### 6.1 How agents actually work today (mechanics)

- **Registration:** a compile-time array of 5 constants (`lib/agents/catalog.ts:5-11`). Adding an agent = editing TypeScript + redeploying. Master Arch §83 explicitly requires enabling/configuring agents *without source changes*.
- **Instantiation:** none — there are no agent objects at runtime. `dispatch()` (1) routes, (2) loads `tenant_config`, (3) calls `generateDraft()` with a role template (4) records a run row. `customer_service` short-circuits to chat (`dispatch.ts:31-46`).
- **Instruction storage:** role sentence + brand interpolation hardcoded in `generators.ts:8-25`; per-channel style hints in `generators.ts:27-36`; chat grounding template in `chat.ts:5-8`. No DB storage, no versioning, no per-BU overrides (beyond 3 brand fields). The `content_system_prompt` DB column exists but is never consumed.
- **Versions:** none. `agent_runs.prompt_hash` receives the raw topic string (`dispatch.ts:29`) — even if hashing were intended, no prompt content is hashed, so no execution can be attributed to a prompt revision.
- **Tool assignment:** none. No tool abstraction exists. The design spec's promised toolsets per agent (`docs/specs/2026-09-09-agentos-design.md:36-42`) were not implemented; the only "tool-like" capability (RAG retrieval) is wired exclusively into customer_service chat, not into research/marketing generation.
- **Permission enforcement:** none. Agents cannot do anything dangerous directly (they only write drafts via `createDraft`), which is the *safest possible default* — but it also means publish capability lives outside the agent model entirely (sweep publishes whatever is scheduled, with no agent identity attached).
- **Knowledge scopes:** implicit only — customer_service sees the whole tenant corpus (`retrieve` has no other filter); generators see none. Target's per-agent knowledge authorization (§16, §20) is absent.
- **Model selection:** global env default gpt-4o-mini; `opts.model` override exists in the LLM client but is unused by agents.
- **Budgets/timeouts:** none. A hung OpenAI call hangs the request; there is no abort/timeout wrapper around `fetch`.
- **Run logging:** success-only, post-hoc, always 'completed', no duration/cost/error (§2.7). Failed dispatches leave no trace except the HTTP 500.
- **Failure handling:** none — no retry, no classification (target §71), no escalation.

### 6.2 Existing agents vs the target registry

| Current agent | Target registry counterpart (§21) | Fit assessment |
|---|---|---|
| research | Research Agent (+ Intelligence Agent later) | Partial. Today it is a *copywriter* producing an "intel brief" from a topic string with no sources, no retrieval, no verification — target's Research contract (§52) requires findings + sources + confidence + relevance/importance scores. Its TS function shell is reusable; its implementation is not the target agent. |
| marketing | Marketing Agent / Content Agent | Good behavioral seed: brand-voiced, channel-aware copy → pending draft (matches §91 autonomy: draft AUTO). Reusable nearly as-is once prompts become config and context can include retrieved knowledge. |
| sales | Sales Agent (+ Lead Agent) | Partial. Drafts outreach and inserts a lead row when a `prospect` is passed (`generators.ts:58-64`) — but the only caller passing prospect is none (route does not accept it: `run/route.ts:20-24` ignores `prospect`). Target contract (§55) needs classification, lead_score, next_action, escalation. |
| ambassador | (closest: Social Media Agent / Marketing) | Ambassador is not in the target's 18-agent list; its awareness-copy behavior folds into Content/Social. Keep the generator as a *prompt variant*, not a registry agent, or justify keeping it as a BU-specific persona. |
| customer_service | Customer Inquiry Agent / Customer Support Agent | Strongest fit: retrieval-grounded, citation-returning, refuses to invent (`chat.ts:5-8`, tested). Missing: conversation persistence, escalation path, lead capture. |

**Registration target state:** 5 code agents → seeded rows in `agents`/`agent_versions` with model, instructions, tools, permissions, knowledge scopes, autonomy_level (conservative default 1–2), budget_limit, timeout. The existing functions become the *executors* bound by agent `slug` — i.e., the registry references implementations, implementations never reference the registry. This preserves the framework-free philosophy while meeting §20–§21.

### 6.3 Should the rule-based orchestrator be kept, extended, replaced, or supplemented?

**Verdict: keep the router as a deterministic component *inside* the future Workflow Engine; do not let it remain the orchestrator.**

- Master Arch §7 *mandates* deterministic workflows for predictable sequences; `routeAgent()` is precisely a deterministic routing function, tested (`tests/agents-routing-tests.ts:14-33`), cheap, and transparent. Killing it would be waste.
- But it cannot be the top-level orchestrator for the target: keyword matching over 4 term-lists cannot express priorities, deadlines, budgets, retries, or multi-step plans, and it silently defaults unknown goals to marketing (`core.ts:24`) — acceptable for a v1 demo, unacceptable for an operations platform.
- Recommended disposition (matches Master Arch phases):
  1. **Phase 3 (Task/Workflow Engine):** `routeAgent()` becomes one step — "classify objective → select workflow/agent" — implemented as a workflow with the current function as the classifier, with explicit FALLBACK/ESCALATE outcomes instead of silent marketing default.
  2. **Phase 14 (Supervisor):** an LLM-driven Supervisor proposes *plans* (task graphs); the workflow engine remains the deterministic executor; `routeAgent` remains available as the cheap classifier for single-intent goals. This is the "converted into deterministic workflow routing + supplemented by the future Supervisor" option from the audit brief — the evidence supports exactly that combination, **not** a full replacement by an autonomous agent framework.
- An agent framework (LangGraph / OpenAI Agents SDK) is **not required** by any current evidence. The target (§6) allows "may use" and requires isolation behind an internal agent interface; the existing `LLMClient` seam + registry plan satisfies that at far lower complexity. Revisit only when multi-step tool-using agents actually exist.

### 6.4 Reuse safety verdict

Agents **can** be safely reused in the target architecture as executors, with four non-negotiable upgrades before Phase 6+: (1) prompts from versioned registry rows; (2) run rows opened at start and closed with real status/error/cost; (3) optional retrieval context injection for research/marketing; (4) budget/timeout wrappers around every LLM call. None of these requires touching the agent functions' signatures — all are wrappers, consistent with the current DI style.

---

## 7. ORCHESTRATION / WORKFLOW GAP

### 7.1 Current mechanisms vs target requirements

| Capability | Target (Master Arch §) | Current AgentOS | Gap verdict |
|---|---|---|---|
| Deterministic workflows | §7, §25 — mandatory for predictable sequences | Only implicit: sweep loop is a fixed sequence; dispatch is a fixed 3-step function | **ADD** (engine), with sweep + dispatch as the first two workflows |
| Agent-based reasoning | §7, §22 — Supervisor plans | None | **ADD** (Phase 14; router is a stop-gap classifier) |
| Task execution | §24 — tasks with status machine | `agent_runs` post-hoc log only; no task object | **ADD**; reuse `agent_runs` extension |
| Event-driven triggers | §26 — event, webhook, goal triggers | None (manual HTTP + 1 cron) | **ADD**; cron already proves scheduler mechanics |
| Background jobs | §27 — browser must not stay open | Everything runs in-request; only sweep is server-side scheduled | **ADD** (job queue) |
| Scheduling | §26 — schedule trigger | Vercel cron daily `30 3 * * *` (`vercel.json:2-4`) | **KEEP** as trigger mechanism (Hobby limits noted) |
| Retries | §29 — configurable attempts | None anywhere; a failed publish marks the draft failed terminally (`approval.ts:61-69`, `publishers/index.ts:97-101`) | **ADD** |
| Backoff | §29 | None | **ADD** |
| Cancellation | §24 — CANCELLED status | None (drafts cannot be un-scheduled; runs have no lifecycle) | **ADD** |
| Idempotency | §88 — publish/send must not double-fire | Absent. Sweep selects *all* scheduled drafts each run; FSM terminality prevents *successful* duplicates only if exactly one sweep runs; two concurrent sweeps (manual GET + cron, or multi-region) can both decrypt and both POST before either marks posted — the read-then-write transition (`approval.ts:18-25`) is not atomic | **ADD** (claim rows with `FOR UPDATE SKIP LOCKED` or status CAS) |
| Duplicate protection | §89 — compare pending drafts / near-duplicates | Absent (checksum dedup exists only for RAG documents) | **ADD** |
| Escalation | §24 — ESCALATED status | None | **ADD** |
| Workflow runs | §25 — workflow_runs records | None | **ADD** |
| Task steps | §13 — task_steps | None | **ADD** |
| Event bus | §95 — decoupled reactions | None | **ADD** |
| Supervisor delegation | §22–§23 — logged handoffs | None | **ADD** (Phase 14) |

### 7.2 What is genuinely reusable

1. **The sweep loop as Workflow #1.** `sweepDue(ctx)` is already shaped like a workflow step-runner: pure input (scheduled set), injected side-effect (`publish`), result counts. Give it row-claiming and retry bookkeeping and it becomes the reference implementation for the job runner.
2. **The FSM as the approval stage of any workflow.** `STATUS_FLOW` is explicit and tested; the target's content lifecycle (§60) is a superset — extend rather than replace.
3. **`dispatch()` as a task executor.** Its signature (ctx with injectable LLM + config loader, goal input, result with run/draft IDs) maps 1:1 onto "execute task step T with agent A". Wrap it in a job runner; keep the body.
4. **`recordRun()` as the run-event writer's first cut** — after column additions and start-time insertion.
5. **Cron infrastructure** (Vercel config + secret-guarded GET alias, `sweep/route.ts:27-28`) — the scheduler trigger exists and works; on Hobby it is frequency-limited, and the roadmap should assume Pro or an external scheduler (e.g. Vercel Pro cron / GitHub Actions schedule / Neon pg_cron) for sub-daily workflows.

### 7.3 Required additions (design notes, not implementation)

- **Job table** with `job_id, type, priority, status, attempts, max_attempts, run_after, locked_at, error` (§28) + claim loop (`FOR UPDATE SKIP LOCKED`), triggered by cron polling or Neon pg_cron. This single table converts sweep + dispatch into a reliable background system.
- **Idempotency:** publish operations keyed by `draft_id` (natural key) with a unique claim — a retry after timeout must consult `content_publications.external_id` before re-POSTing. X/LinkedIn/Resend are not naturally idempotent; the platform must enforce it.
- **Events:** start with a DB `events` table + in-process listeners (target §95 names are good: `approval.requested`, `agent.failed`, `lead.created`); notifications can subscribe. Avoid message-broker adoption until scale demands it — consistent with the framework-free philosophy.
- **Error classification** enum (§71) on jobs/runs to drive retry-vs-escalate decisions.

---

## 8. AI GATEWAY AUDIT

### 8.1 Current LLM implementation assessed against gateway duties (Master Arch §41)

| Gateway responsibility | Current state (`lib/llm.ts`, 57 lines) | Classification |
|---|---|---|
| Provider abstraction | `LLMClient` interface (`complete`, `embed`) + `makeLLM(fetchImpl)` — a real seam, but only one OpenAI implementation exists; URL hardcoded `api.openai.com` (`llm.ts:22,40`) | **MODIFY** — keep interface as the adapter contract; add provider adapters behind it |
| Model abstraction | model per call via `opts.model`/env; no reasoning-level/temperature policy, no token limits, no fallback model (§43) | **MODIFY** |
| OpenAI-compatible calls | yes, raw REST, no SDK | **KEEP** (raw fetch is a feature: zero deps, fully testable) |
| Model routing | none (no per-agent model config; env-global) | **ADD** |
| Token tracking | none — response `usage` field is discarded (`llm.ts:35-36` parses only `choices[0].message.content`) | **ADD** |
| Cost tracking | none | **ADD** (§44) |
| Request logging | none | **ADD** |
| Rate limiting | none | **ADD** |
| Fallback | none (single attempt, single provider) | **ADD** |
| Retries | none (throws on any non-200; 429s are fatal) | **ADD** with TRANSIENT/MODEL error classification (§71) |
| Timeout handling | none — no AbortController; a hung call hangs the serverless function | **ADD** (critical on Vercel, where the function timeout kills the request) |
| Streaming | not implemented (not required by §42's `stream()` forever — but note for later UX) | **ADD (DEFER)** |
| Structured outputs / schema validation | none — all agents parse free-form strings | **ADD** (§86–§87) |
| Moderation | none (`moderate()` in §42's abstraction) | **ADD (DEFER to content safety pipeline §90)** |
| Embedding model lock | `vector(1536)` column + `text-embedding-3-small` default | **MODIFY** (see §5.1 chunks row) |

### 8.2 Verdict

**MODIFY, not REPLACE.** The 57-line client is the correct *innermost layer* of a gateway: injectable, dependency-free, fully stubbed in tests (`tests/llm-tests.ts` verifies request shape, headers, error paths — 20+ checks). What is missing is everything *around* it: a `runCompletion()` gateway wrapper that (1) resolves agent/BU model policy, (2) enforces budgets + rate limits, (3) applies timeout/abort, (4) retries transient failures with backoff and model fallback, (5) captures `usage` into cost records, (6) logs request→run correlation. Because every caller already goes through `ctx.llm` (checked: `dispatch.ts:33,45` via generators; `chat.ts:16`), inserting the wrapper is non-invasive. Evidence that the seam holds: `tests/dispatch-tests.ts:144-176` swaps real HTTP through the same interface without touching call sites.

---

## 9. KNOWLEDGE / RAG AUDIT

### 9.1 Current implementation quality

| Aspect | State | Evidence |
|---|---|---|
| Vector store | pgvector, ivfflat (lists=100), cosine `<=>` | `lib/migrations.ts:64-65`, `retrieve.ts:22` |
| Embeddings | `text-embedding-3-small` (1536-d), batched per document; count-guarded | `ingest.ts:45-48`, `llm.ts:38-52` |
| Chunking | fixed 800 chars after whitespace collapse; no overlap, no sentence/heading awareness; empty text → one empty chunk (tested) | `ingest.ts:6-16`, `tests/rag-tests.ts:110-120` |
| Deduplication | sha256 per tenant + identical-text reuse without re-embed (tested incl. embed-call counting) | `ingest.ts:31-42`, `tests/rag-tests.ts:73-84` |
| Retrieval | top-K cosine, tenant filter only; K default 5 (chat) | `retrieve.ts:8-26`, `chat.ts:13` |
| Metadata filtering | none | — |
| Grounding / citation | retrieved-only system prompt; sources returned with title+documentId; "no passages retrieved" path; fabrication guard asserted in tests | `chat.ts:5-24`, `tests/chat-tests.ts:55-58,106-108` |
| Tenant isolation | `WHERE tenant_id = $1` on every read; cross-tenant leak tests (question aimed at tenant B answered from A's corpus must not contain B's passage) | `tests/chat-tests.ts:99-103`, `tests/rag-tests.ts:65-71` |
| Source management | content_sources rows created but no fetcher for any kind; last_synced_at never updated by code | `ingest.ts:18-26` (only INSERT), grep-verified |
| Ingestion surfaces | programmatic `ingestText` only (seed CLI/endpoint); no UI, no upload route, no sitemap reader | repo-wide grep |
| Refresh/monitoring | none | — |

### 9.2 Comparison against the target hierarchical model (Global → Business → Website/Jurisdiction → Agent)

The current model has exactly **one scope level: tenant**. The target needs four (§15) plus per-document metadata (jurisdiction, language, document_type, access_level, authority tier §17–§18) and per-agent retrieval authorization (§16). Mapping strategy:

- **Tenant ≈ Business level** — exists, keep.
- **Global level** — absent. Add `scope_level`/`business_unit_id NULL = global` semantics (target §14 explicitly defines NULL as intentionally shared) + explicit per-BU authorization for global corpora (§128).
- **Jurisdiction level** — absent. Add jurisdiction column(s) on documents/chunks (or a join table) + filter plumbing.
- **Agent level** — absent. Add `agent_scopes` (which agents may retrieve which docs/types).
- **Website level** — the target's BU→Website hierarchy implies website-scoped knowledge for multi-site BUs; currently impossible (no websites).

### 9.3 What must be preserved (high confidence)

1. **Checksum dedup + embed guards** — saves cost and prevents phantom writes; directly reusable for the larger corpus model.
2. **Retrieval-isolation test discipline** — the leak tests (`tests/chat-tests.ts:99-103`) are the template for the target's much stricter scope tests; extend the pattern to jurisdiction/agent scopes.
3. **Grounding prompt + citation shape** — `{answer, sources[]}` matches the target's customer-facing contract (§65: no internal reasoning exposure; citations only).
4. **pgvector + ivfflat** — fine at target scale (10+ websites); revisit HNSW and partitioning when chunks exceed low millions.
5. **Injectable embed context** (`ctx.embed`) — already provider-agnostic; survives the gateway unchanged.

### 9.4 What must evolve (prioritized)

1. **Scope columns + filtered retrieval** (jurisdiction/language/access/agent) — the §16 rule "agents must NEVER automatically receive every document" is currently *unimplementable* at any level finer than tenant.
2. **Hybrid retrieval** — add a tsvector leg + metadata filters; today a keyword-exact query that isn't semantically close fails silently (no keyword path at all).
3. **Real source fetchers** (sitemap, RSS, URL, PDF/DOCX/CSV) with refresh scheduling — currently declared, not built; target §17 requires them.
4. **Chunking upgrade** — 800-char blind slicing splits sentences/headers; for legal-domain knowledge (target domain focus) this materially harms retrieval. Add structure-aware chunking with overlap.
5. **Embedding dimension strategy** — multi-model gateway implies per-model embedding storage or re-embedding pipeline; decide before Phase 4/5.
6. **Authority tiers + date filtering** — needed by the research workforce's source-quality requirements (§18) and legal accuracy constraints (§50–§51).

---

## 10. SECURITY AUDIT

Classifications: **Critical** = exploitable now with material impact; **High** = serious weakness requiring planned remediation; **Medium** = defense-in-depth gap; **Low** = hygiene. Nothing was fixed.

### 10.1 Findings

| ID | Severity | Finding | Evidence | Target requirement violated |
|---|---|---|---|---|
| S1 | **Critical** | Channel wire-up is unauthenticated: anyone on the internet can store or silently overwrite the publishing token of any tenant (id enumerable), i.e. plant attacker-controlled credentials and later publish as that brand | `app/api/v1/channels/route.ts:10-44`; README admits "auth-free by design in v1" (`README.md:160-164`) | §73 (least privilege), §76 (internal API validation) |
| S2 | **Critical** | Unauthenticated agent execution: anyone can invoke `POST /api/agents/run` for any tenantId → unbounded OpenAI spend (no rate limit, no budget, no auth) + arbitrary pending-draft injection into any tenant's approval queue | `app/api/agents/run/route.ts:8-29` | §44 (cost control), §76, §78 (rate limits) |
| S3 | **Critical** | Unauthenticated chat: anyone can burn embedding+completion quota for any tenant by enumerating integer tenantIds; also an answer-oracle for tenant knowledge (information disclosure of RAG corpus phrasing) | `app/api/v1/chat/route.ts:9-33`; widget needs it public, so mitigation must be per-site binding + rate limits, not auth | §78, §77 (signed integration) |
| S4 | **High** | Single shared `ADMIN_PASSWORD` is simultaneously the login credential, the API bearer, and the OPS fallback; stored plaintext-equivalent in `sessionStorage`; no expiry, no rotation, no lockout; one password = power over every tenant | `app/admin/login/page.tsx:13-16`, `app/admin/page.tsx:6-9`, `lib/admin.ts:5-19` | §73, §74 (role model), §75 (agent identity separation) |
| S5 | **High** | No users/roles/permissions anywhere; no per-tenant scoping of admin; OPS_TOKEN is equal-trust to ADMIN_PASSWORD by explicit design (`admin.ts:15-19`) | `lib/admin.ts`, schema (no users table) | §74 |
| S6 | **High** | No audit log: administrative approvals record no reviewer identity (`approvals` has no reviewer column); migrate/seed/env-check calls are unaudited; agent actions attributable only to agent name | `lib/migrations.ts:89-95`; all admin routes | §72 |
| S7 | **Medium** | No rate limiting on any endpoint (login brute-force possible; timing-safe compare mitigates online timing leaks but not volume) | absence repo-wide | §78 |
| S8 | **Medium** | Sweep secret is a static env shared value (`x-cron-secret`); no rotation story, no request signing/timestamp/replay protection | `sweep/route.ts:13-16` | §77 |
| S9 | **Medium** | Tenant enumeration: widget config distinguishes known vs unknown tenants (404) and chat accepts any integer id — acceptable UX tradeoff but combined with S3 it enables targeted abuse | `lib/widget.ts:15-25` | §78 |
| S10 | **Medium** | Isolation is convention-only: no RLS; a single unscoped query or a future admin aggregate leaks across tenants; `ON DELETE CASCADE` from tenants can wipe audit-adjacent history | `lib/migrations.ts` (all FKs cascade); no RLS objects | §73 (RLS where applicable) |
| S11 | **Medium** | Admin API lacks CSRF hardening for cookie-based flows — currently moot (bearer headers), but the login endpoint sets no cookie; if sessions are added in Phase 1 without CSRF, this becomes live | `login/route.ts` | §73 |
| S12 | **Medium** | Encryption key management: single global `CHANNEL_ENC_KEY` env; no rotation (AES-GCM payload format has no key-id field), no envelope encryption; compromise of one env var compromises all channel tokens | `lib/channels.ts:3-26` | §73 (encrypted secrets, rotation) |
| S13 | **Low** | `rejectDraft` writes `review_notes` *before* inserting the approvals row and neither is transactional; a crash mid-way leaves inconsistent audit state | `approval.ts:41-45` | §72 (auditability) |
| S14 | **Low** | Info-hygiene positives worth noting: 5xx bodies are generic; env-check exposes presence/length only (host for DATABASE_URL); widget config brand-safe; admin auth precedes body parse; widget CSP-safe — all test-enforced | `README.md:148-166`; `tests/security-tests.ts:84-106`; `tests/widget-tests.ts:43-44` | compliant with several §73 items |
| S15 | **Low** | `prompt_hash` stores raw topic text — if topics ever contain sensitive content they sit un-hashed in a log table | `dispatch.ts:29` | §72 |

### 10.2 The auth-free channels endpoint (explicitly requested focus)

Confirmed as described: `POST /api/v1/channels` performs **no authorization of any kind** — no bearer, no origin check, no tenant ownership proof (`channels/route.ts:10-33`). It validates only payload shape and channel kind, then upserts an encrypted credential. The code comments and README present this as a deliberate v1 decision ("post-T13 architecture keeps v1 public", `README.md:161`) with a documented recommendation to move it behind admin auth. Attack chain: attacker enumerates tenantId (widget config / chat probing) → wires attacker's own X/LinkedIn/email token → waits for tenant to approve+schedule a draft → sweep publishes attacker-authored content from attacker's account, or exfiltrates draft content via attacker-controlled email. Severity **Critical**; must be closed before any real tenant onboarding, not deferred to a later phase.

### 10.3 Positive security assets to preserve

Timing-safe comparison utility with length-mismatch rejection (`lib/security.ts:3-9`, tested `tests/security-tests.ts:76-79`); AES-256-GCM with random IV + tamper tests (`tests/channels-tests.ts:12-27`); uniform generic 5xx bodies (test-enforced); auth-before-parse ordering on the FSM route (test-enforced `tests/security-tests.ts:62-63`); strict tenantId format validation incl. hex/scientific-notation rejections (`tests/security-tests.ts:66-73`).

### 10.4 Prioritized remediation order (for the roadmap, not executed here)

1. Close S1/S2/S3 minimally (admin bearer or per-site signed widget keys + per-IP/per-tenant rate limits + spend caps).
2. Introduce users/sessions/roles (S4/S5) in Phase 1 as the target already mandates.
3. Add `audit_logs` + reviewer identity (S6) with the first schema extension.
4. RLS evaluation + cascade audit (S10) during the Phase 1 schema work.
5. Key-id envelope format for channel tokens (S12) before tenant count grows.

---

## 11. DEPLOYMENT / OPERATIONS BASELINE

Findings are separated into **A. repository/code**, **B. deployment/configuration**, **C. operational/environment**, each classified as architectural / configuration / environmental / implementation / unknown-unverified.

### 11.1 A. Repository/code findings

| # | Finding | Classification | Status |
|---|---|---|---|
| A1 | Cron route originally exported only POST while Vercel cron sends GET → guaranteed 405 on every scheduled sweep. Code now defines `export const GET = POST` with explanatory comment | implementation (fixed in code) | **Verified fixed in source** (`app/api/agents/sweep/route.ts:26-28`); runtime cron execution NOT VERIFIED in this audit (no cron invocation was triggered) |
| A2 | `vercel.json` cron was `*/15` (violates Hobby 1/day limit) → now `30 3 * * *` | configuration (fixed in code) | Verified (`vercel.json:2-4`); platform acceptance verified in prior ops session |
| A3 | Schema DDL duplicated risk eliminated by extraction to `lib/migrations.ts` consumed by both CLI and API runner | implementation | Verified (`scripts/migrate.ts:1-7`, `migrate/route.ts:3`) |
| A4 | Seed endpoint undefined-param bug (explicit `undefined` clobbering defaults) fixed via filter | implementation | Verified (`lib/demo-seed.ts:50-52`); behavior covered by commit `52f32e6` message; live re-seed NOT VERIFIED (blocked on OpenAI quota, C2) |
| A5 | No CI pipeline; no lint config; tests are not wired into any automated gate | implementation | Verified (no `.github/`, no lint script in `package.json`) |
| A6 | LinkedIn publish path cannot succeed as coded without target plumbing (author URN fallback) | implementation | Verified statically (`publishers/index.ts:58,84-85`); end-to-end NOT VERIFIED |
| A7 | Missing `target` in `sweepDue` SELECT despite row-type declaration — latent type-integrity bug | implementation | Verified (`publishers/index.ts:84-85`) |

### 11.2 B. Deployment/configuration findings

| # | Finding | Classification | Status |
|---|---|---|---|
| B1 | Vercel project `masteragent` had **zero deployments** — GitHub webhook never fired; first deploy achieved via CLI (`vercel link` + `deploy --prod`) | configuration | Verified in prior ops session; current deployment serves traffic (this audit's live probes) |
| B2 | Original 11 env vars existed in dashboard but were absent at runtime (bulk-import path never injected values) → runtime `DATABASE_URL` undefined → pg fell back to localhost:5432 → ECONNREFUSED → **FUNCTION_INVOCATION_FAILED on every route including static assets** | environmental/configuration | Diagnosed and remediated in prior ops session by recreating all vars via Vercel API (`POST /v10`, encrypted, prod+preview targets); env-check then reported 12/12 present. NOT re-verified in this audit (no authenticated env-check call made), but indirect live evidence (widget config returns DB-backed data) confirms runtime env health today |
| B3 | First redeploy after env re-entry served stale env from build cache; `--force` redeploy required | configuration (Vercel behavior) | Verified in prior ops session; procedural note for future deploy docs |
| B4 | Hobby plan constraints: daily cron only; no teams/preview protections | environmental (plan) | Verified against plan in prior ops session; constrains Phase 3 scheduling ambitions |
| B5 | Deployments are manual CLI operations; GitHub↔Vercel integration still not proven to auto-deploy on push | configuration | NOT VERIFIED — no push was made in this audit; remains an open operational risk (drift between repo HEAD and deployed build cannot be ruled out) |

### 11.3 C. Operational/environment findings

| # | Finding | Classification | Status |
|---|---|---|---|
| C1 | Live app healthy at audit time: `/` 200, `/admin/login` 200, widget config 200 with real tenant (`acme-homes`, id 491), unauthenticated admin API correctly 401 | environmental | **Verified this audit** (GET probes, attestation table) |
| C2 | Configured OpenAI key has **no quota** — `429 insufficient_quota` on any LLM path; demo seeding of a real draft blocked | environmental (billing) | Verified in prior ops session; NOT re-verified (no LLM call made). Remains the sole functional blocker for end-to-end demo |
| C3 | Single production Neon database doubles as test target — all 14 suites create/delete rows in the *production* DB when run | environmental/architectural (env model) | Verified by test code inspection (`tests/*-tests.ts` all use `lib/db` → `DATABASE_URL`); violates target §111 (env separation) |
| C4 | No backups/DR definition, no monitoring/alerting beyond `env-check`, no cost telemetry | environmental | Verified absent |
| C5 | Secrets shared in plaintext in earlier chat sessions (GitHub PAT, Vercel token, OpenAI key) with rotation advised | operational hygiene | Prior session record; rotation status NOT VERIFIED |

### 11.4 FUNCTION_INVOCATION_FAILED — explicit disposition

The historical failure was **environmental/configuration (B2)**, not architectural and not an implementation defect in the Next.js app: the same repo built and served correctly locally with zero env vars (pages 200), while the deployed function crashed on first DB access because runtime env was empty. Remediation (env re-entry + `--force` redeploy) was verified working in the prior ops session, and this audit's live probes (200s + real DB-backed widget payload) constitute independent evidence that the failure mode is currently resolved. It is **not claimed as "fixed forever"**: the recurrence vector (any future env-var edit not followed by a cache-bypassing redeploy, or any secret rotation mistake) remains, and B5 (no CI/CD) keeps deploys manual.

---

## 12. MULTI-TENANT → MULTI-BUSINESS → MULTI-WEBSITE MIGRATION

### 12.1 Why "rename tenants" fails

The target's `BusinessUnit` (§8–§9) is an *organization* owning brand, market, jurisdictions, goals and one-or-more `Websites` (§10) which in turn own integrations/capabilities. AgentOS's `tenant` is simultaneously organization, website, brand, channel set and knowledge scope. Evidence of conflation: `channels.tenant_id` (credentials per website), `chunks.tenant_id` (knowledge per brand), `leads.tenant_id` (customers per website), `tenant_config` (brand per organization) — all keyed on the same id. A rename preserves this conflation; the hierarchy must be introduced *around* it.

### 12.2 Safest migration architecture (target end-state, additive)

```
Phase 1 (additive):
  business_units(id, slug, name, domain?, status, autonomy_level, brand_voice, audience, jurisdictions[], languages[], …)
  websites(id, business_unit_id → business_units, slug, domain, environment, framework, cms, api_endpoint, integration_status, status)
  -- existing rows: 1 BU per existing tenant; 1 website per BU; tenants.id preserved as bu.id

Phase 2 (coexistence):
  -- every business table gains nullable website_id (leads, inquiries later; channels stay on website level)
  -- tenant_id columns remain, derived: tenant_id ≡ business_units.id (compat shim: VIEW tenants AS SELECT id, slug, … FROM business_units)
  -- lib/widget.ts + widget data-tenant continue resolving (slug-or-id) against the view or a lookup shim

Phase 3 (flip readers):
  -- new code paths key on website_id / business_unit_id
  -- knowledge scoping gains scope columns (§9.2) while tenant_id filter remains as the BU-level filter

Phase 4 (cleanup):
  -- tenant_config folded into business_units; tenants table becomes a compatibility view or is dropped after widget/seed shims are gone
  -- channels re-homed as website_integrations / social_accounts with website_id
```

Sequencing rules that make this safe:

1. **Identity first** (users/roles) — BusinessUnit administration without authentication multiplies S4's blast radius.
2. **Never break the widget contract** during transition: `data-tenant` slug/id must keep resolving at every intermediate step (live deployments already embed it; `lib/widget.ts:15-22`).
3. **Dual-key window:** new writes carry both `tenant_id` (derived) and `website_id`; readers migrate one endpoint at a time with the tenant-isolation test suite extended to website scope — the existing suites (`tests/approval-tests.ts:99-108`, `tests/dispatch-tests.ts:124-141`) become the regression net.
4. **Arbitrary-future-BU test as an acceptance gate:** the definition of done for this migration is the Master Arch §121–§123 test — adding "AI News Platform" as a new BU+website with agents/knowledge/integrations **requires configuration rows only, zero code**. The current code fails this by construction (agent catalog is code; routing keywords are code; channel kinds are an enum check) — the roadmap must include de-hardcoding those three points (registry rows, classifier config, integration adapters keyed by data).

### 12.3 Seed businesses (WakeelyPro, Mokhamen, Almizan, LegalWakeely)

They enter as 4 `business_units` rows + ≥1 `websites` row each — configuration, not code. The demo seeder (`lib/demo-seed.ts`) generalizes: seed BU → website → agent enablement → knowledge → widget binding. Nothing in the target architecture may special-case their slugs; the audit found no current code hard-coding the existing demo tenant beyond `DEMO_DEFAULTS` (seed data only, `demo-seed.ts:7-27`) — acceptable, and it must stay data-only.

### 12.4 Isolation implications

With websites as the customer-facing unit, `leads`/`inquiries`/`conversations` must carry `website_id` (customer came from a specific site) while `business_unit_id` carries ownership; knowledge may be BU-wide or website-scoped; channel credentials move to website scope (one site may have its own social accounts). RLS policies (§10, S10) should then be expressible per BU with website as a refinement. This is the natural place to adopt RLS — before multi-BU data exists, not after.

---

## 13. EXISTING CUSTOMER-SERVICE / RAG WIDGET

### 13.1 Assessment

The widget is the closest thing AgentOS has to the target's "customer-facing AI as a controlled interface" (§40): a website-embedded script → platform chat API → authorized tenant context → grounded retrieval → cited answer. It is dependency-free, CSP-safe, test-asserted (`tests/widget-tests.ts:75-86`), and its config endpoint deliberately exposes the minimum (`{tenantId, brand}` — test-asserted brand-safety).

### 13.2 Verdict: **PRESERVE + ADAPT + EXTRACT into the Website-Integration model**

- **Preserve** the vanilla-JS approach and grounding contract; nothing in the target contradicts it.
- **Adapt** for the target model: (1) bind the widget to a **website** registration, not a bare tenant id — issue a per-site public key/embed token so the platform can rate-limit per site (S3/S9) and verify origin (§77 signed-requests spirit); (2) persist **conversations** server-side (target §65 requires customer-facing conversation records; today nothing is stored — no continuity, no quality data, no escalation trail); (3) route unanswered/low-confidence questions into `inquiries` + human escalation (target §139 use case); (4) support brand/theme config from the website record rather than script attributes only.
- **Extract** the widget+chat pair into the platform's integration layer as the *first WebsiteConnector capability*: `chat.answer` — proving the capability-grant model (§12) on the integration that already exists. This is the cleanest way to satisfy "agents access websites through registered connectors" without forcing any workforce into the site.
- **Do not redesign around it:** the widget must remain one consumer of the AI Gateway/Workforce, not the center of the architecture. Concretely: `/api/v1/chat` should become a thin façade over the same task/run machinery the Command Center uses (currently it is a separate code path — `run/route.ts` vs `chat/route.ts`).

---

## 14. EXISTING PUBLISHING SYSTEM

### 14.1 Component-by-component against the target Social/Marketing Workforce (§62, §92, §133)

| Component | Reusable under target? | Analysis |
|---|---|---|
| Email (Resend) | **Yes — MODIFY** | Publisher body is correct and tested (`tests/publishers-tests.ts:39-51`). Gaps: recipient is global `EMAIL_TARGET` fallback (`publishers/index.ts:48`), no per-tenant/per-lead routing, no template/model separation, no unsubscribe/branding — required before marketing use. |
| X | **Yes — MODIFY** | Endpoint + payload correct (`publishers/index.ts:63`); token is a pasted long-lived credential — target expects managed social accounts (§62) and eventually OAuth + rotation (§73). Media/threads/scheduling-time semantics absent (schedule is a queue position, not a time — `scheduled_at` doesn't exist; sweep posts *everything* scheduled at cron time). |
| LinkedIn | **Partially — MODIFY with blocking fix** | Payload shape correct per tests, but `author` falls back to an invalid URN and no schema storage exists for the member/org URN (§11.1 A6) — the live path is broken until `channels`/`social_accounts` gains the account ref. |
| Instagram | **Stub — DEFER** | Draft-only by design; publisher rejects (`publishers/index.ts:19-21,64`). Test-asserted as never auto-posted. Fits target's approval-first principle; real Graph-API adapter is a Phase 9 item. |
| TikTok | **Stub — DEFER** | Same as Instagram (`publishers/index.ts:65`). |
| Approval FSM | **Yes — KEEP core, MODIFY** | The strict FSM (§2.11) implements exactly the target principle that public actions require human approval; extend with reviewer identity, risk level, edit-before-approve, transactional transitions. |
| Outbox | **No — REPLACE** | It is a post-hoc log, not a queue: no claim/idempotency/attempts; concurrency can double-publish (§7). Target's content_publications + job queue supersede it. |

### 14.2 The approval-control principle

The audit brief highlights: *"AI Workforce may prepare content automatically, but high-risk/public publishing must remain approval-controlled until the autonomy policy explicitly permits otherwise."* AgentOS already honors this **by construction**: agents can only `createDraft()` (`generators.ts:52-57`); the *only* path to a public channel is human-driven FSM transitions to `scheduled` plus the sweep (`sweep/route.ts`, `approval.ts:5-12`); instagram/tiktok cannot publish at all; and the sweep refuses unhealthy channels. This invariant — **generation autonomous, publication human-gated** — is the single most important behavioral asset in the codebase and must be preserved verbatim into the target's Policy Engine (as the Level ≤ 2 default of §45 and the initial social/marketing autonomy matrix of §91–§92). The one caveat: the FSM's integrity currently rests on non-transactional read-then-write checks and an unguarded scheduling route (admin password), so the *policy* is right while the *enforcement* needs the hardening in §10.

### 14.3 What the Social/Marketing Workforce still needs beyond today's system

Social posts as first-class records linked to source content (currently a draft is the post), platform-specific variants from one content item (§62), campaigns (§13 social_campaigns), scheduled-time semantics (a calendar, not a cron pile), metrics ingestion after publish (§133), per-platform rate limits, and OAuth account lifecycle. None of these exists; all are additive on top of the preserved publisher-adapter pattern.

---

## 15. TESTING AND QUALITY AUDIT

### 15.1 Inventory and genuine coverage

14 suites (`tests/run-all.ts:3`), ≈1,856 LOC, executed as separate `tsx` processes with `.env.local`. This is **not** a mocked-only suite: most suites run against the live Postgres (creating uniquely-slugged fixtures and deleting them in `finally`), with only the LLM/fetch seams stubbed via the DI interfaces. Genuine coverage by area:

| Suite | What is genuinely verified (highlights) | Evidence |
|---|---|---|
| smoke | node version, scaffolding sanity | `tests/smoke-tests.ts` |
| db | 11 tables exist; pgvector present; vector cosine works; unique constraint; **transaction commit/rollback paths of `lib/db.ts`** | `tests/db-tests.ts:15-83` |
| llm | request shape, headers, model/temperature override, malformed-JSON rejection, missing-key errors — 20+ checks against stubbed fetch | `tests/llm-tests.ts` |
| channels | AES-GCM: random IV, roundtrip, wrong-key failure, tamper failure, env-key resolution | `tests/channels-tests.ts` |
| agents-routing | keyword routing incl. chat-beats-keywords precedence; catalog contract; `recordRun` persistence + append-only | `tests/agents-routing-tests.ts` |
| approval | full FSM: all legal transitions; illegal transitions rejected and leave state untouched; double-approve writes no second audit row; reject persists comment; outbox rows on success/failure; **tenant-scoping of draft lists** | `tests/approval-tests.ts` |
| rag | tenant A never sees tenant B content; checksum dedup skips embedding; embed-count guards; empty-text behavior; chunk-size/ordering; no chunk without embedding | `tests/rag-tests.ts` |
| generators | system-prompt contract (brand/persona/audience/guardrails injected); channel hints; content preservation for long/short/empty outputs; sales lead insert only with prospect; **cross-tenant config non-leakage** | `tests/generators-tests.ts` |
| dispatch | run+draft creation; config injection per tenant; chat guard before generators; **HTTP route behavior incl. 400 validation making zero LLM calls** | `tests/dispatch-tests.ts` |
| chat | grounding prompt ("Never invent facts"); sources; empty-retrieval path; **cross-tenant leak test targeting tenant B's secrets**; 400 paths make zero LLM calls | `tests/chat-tests.ts` |
| publishers | per-channel endpoint+payload correctness; decrypted-token-as-bearer; IG/TikTok reject; sweep posts only scheduled; failed publish → failed draft + failed outbox + unhealthy channel; route 401s leave zero side effects; **ciphertext-only-at-rest assertion through the route** | `tests/publishers-tests.ts` |
| widget | slug/numeric resolution; brand-safe minimal payload; suspended-tenant invisibility; injection-shaped tenant param handled; **static analysis of widget.js: no eval/inline handlers/external URLs** | `tests/widget-tests.ts` |
| admin | auth helper matrix; route 401s with no side effects; FSM-through-API; **static analysis of admin pages (sessionStorage gate, bearer flow, no eval/script injection)** | `tests/admin-tests.ts` |
| security | token never stored plaintext; malformed JSON → 400 JSON; tenantId coercion strictness; safeEqual matrix; wrong cron secret 401; FK→404 vs 500 distinction without internal echo | `tests/security-tests.ts` |

### 15.2 What is only stubbed / simulated

- LLM behavior: all suites stub `LLMClient`/`fetch` — no test asserts real model output quality, prompt-version behavior, or token/cost extraction (nothing to assert — features absent).
- Publishers: endpoints verified via injected `fetchImpl`; **no test performs a real network publish** (correct choice) — meaning contract drift vs live X/LinkedIn/Resend APIs is undetectable by CI.
- Cron: the GET alias and secret gate are tested as functions; actual Vercel cron delivery is not (environmental).

### 15.3 Critical untested paths

1. **Concurrency & idempotency** — no suite runs two overlapping sweeps or two simultaneous FSM transitions; the at-least-once hazards (README's own admission, `README.md:167-173`) are therefore *unquantified*.
2. **Auth-free endpoints under abuse** — no test simulates unauthenticated flooding of `/api/agents/run` or channel overwrites; the security suite tests *shape*, not *authorization* (there is none to test on those routes).
3. **Failure-branch run logging** — dispatch/generation failures leave no run row; no test asserts observability of failures (the assertion would fail today — correct signal of the gap).
4. **Email/LinkedIn per-recipient routing** — no test can pass a real target because the schema lacks one; blind spot mirrors the R4 defect.
5. **Ops endpoints** — `migrate`/`seed`/`env-check` have **no tests at all** (added post-plan in the ops session); the Bearer guard on schema-changing DDL is untested.
6. **Multi-tenant admin boundaries** — the admin route accepts any tenantId with the one password; no test expresses the *intended* boundary because none exists.

### 15.4 Security / integration / workflow / database / deployment gaps

- **Security gap:** no suite covers rate limiting, lockout, session expiry (nonexistent), or RLS (nonexistent). The strong tenant-isolation tests are the exception, not the rule.
- **Integration gap:** no contract tests against provider OpenAPI specs; no webhook receivers to test (absent).
- **Workflow gap:** nothing tests scheduled triggers, retries, or long-running behavior — the engine doesn't exist.
- **Database gap:** no migration test (apply-to-empty-DB and apply-twice idempotency is exercised only manually / via db-tests introspection); no RLS tests; no constraint-rejection tests for `drafts.channel`.
- **Deployment gap:** no CI to run the suites at all (A5); "all tests pass" has historically been a local, manual claim — the handoff's own status line depends on someone remembering to run `npm test`.

### 15.5 Verdict

"ALL SUITES PASS" (HANDOFF.md:19) is **true and meaningful for what the suites cover** — this is honest, high-signal integration testing, unusually rigorous for a v1, and the isolation tests in particular deserve preservation as the template for target-scoped tests. It is **not** evidence of production readiness: the untested list above is precisely the list of behaviors the Master Architecture demands (idempotency §88, observability §68, RBAC §74, rate limits §78, env separation §111).

---

## 16. DOCUMENTATION AUDIT

| Document | Verdict | Contradictions with code / issues |
|---|---|---|
| `README.md` | **Largely accurate — best doc** | API table matches handlers incl. auth-free admission; security notes match code (verified point-by-point). One real bug: the embed example puts `data-tenant` on a **div** (`README.md:123-126`) but `widget.js` reads attributes **only from `document.currentScript`** (`public/widget.js:5-8`) — the documented div+script pattern yields an unconfigured widget. Minor: "decisions write an approvals audit row" is right, but README omits that no reviewer identity exists. |
| `HANDOFF.md` | **Historical snapshot, now stale** | Claims cron "every 15 min" (§4 table) — now daily; claims HEAD `30c1387` — now `52f32e6`; lists sweep as `GET` — now POST+GET alias; omits the 3 ops endpoints and `OPS_TOKEN` added after it. Its "limitations" section (§8) remains accurate and candid. |
| `AGENTOS-RUNBOOK.md` | **Operationally excellent, internally inconsistent** | §1 diagram says "cron sweep (every 15 min)" while §8 correctly says Hobby allows daily — contradiction within one doc. §6 chat example uses body key `message` — the API requires `question` (`chat/route.ts:16`); the documented curl would 400. §6 cheat-sheet says `PATCH /api/admin/drafts/[id]` — the route is POST only. §6 says force-sweep with `GET /api/agents/sweep` — correct only post-1946bcb (alias exists). Deployed URL stated as `agentos-nine.vercel.app` (§ header) vs actual production alias `masteragent-nine.vercel.app` — the doc predates the alias discovery; confusing but explained by history. |
| `AGENTS.md` / `CLAUDE.md` | Boilerplate (Next.js agent rules pointer); no product content; no contradiction. | — |
| `docs/specs/2026-09-09-agentos-design.md` | **Design intent — several promises unimplemented** | vs code: publisher files "linkedin.ts, x.ts, email.ts, tiktok.ts, instagram.ts" (§3) are actually one `publishers/index.ts`; `approvals.approved_by` (§4) doesn't exist in schema; "Arabic-safe normalization" (§8) not implemented; per-tenant admin sessions (§5) not implemented; rate limiting + circuit breakers per channel (§7) — only a boolean unhealthy flag exists; "request ids, rate-limit headers" (§9) absent; orchestrator "scans for open approval items" (§2) absent. |
| `docs/superpowers/plans/2026-09-09-agentos.md` | **Implementation plan (2,289 lines)** — checkboxes remain unticked in the file even though the work shipped; useful as the rationale record for every test's existence; matches code where spot-checked (DDL, suite list, security suite shape). | Stale as a tracker; accurate as a spec-of-record for v1 mechanics. |

**Meta-observation:** documentation quality is good at describing *what was built* and honest about limitations, but there is **no living architecture document** — the design spec froze on 2026-09-09 and the runbook accumulated hotfix notes. The Master Architecture now becomes the target-of-truth; the rebaseline should explicitly retire/supersede `docs/specs/2026-09-09-agentos-design.md` to prevent two competing "architecture" claims.

---

## 17. TARGET ARCHITECTURE GAP MAP

Complete mapping across the whole target (not only existing features). Phase = Master Arch build phase where the capability belongs. Class: KEEP / MODIFY / REPLACE / ADD / DEFER.

| # | Target capability | Existing implementation | Gap | Class | Future phase |
|---|---|---|---|---|---|
| 1 | Five-layer architecture | Layers present in embryo: UI(1 page) / API / agents / knowledge / publishers — but no distinct orchestration or gateway layers | Layer boundaries must be formalized | MODIFY | 1–4 |
| 2 | Business Units | `tenants` flat | hierarchy + fields | MODIFY | 1 |
| 3 | Websites | none | entity + per-site config | ADD | 1 |
| 4 | Central AI Workforce | 5 code agents | registry-hosted workforce | MODIFY | 2,6+ |
| 5 | Agent Registry | code const catalog | DB registry, enable-per-BU | REPLACE | 2 |
| 6 | Agent Versions | none | versions + per-run attribution | ADD | 2 |
| 7 | Tool Registry | none | tools with schema/permissions/limits | ADD | 2–3 |
| 8 | Permissions (agent + user) | none | RBAC + agent_permissions | ADD | 1–2 |
| 9 | Task Engine | none | tasks/steps/status machine | ADD | 3 |
| 10 | Workflow Engine | sweep loop + dispatch function | general engine + triggers | ADD | 3 |
| 11 | AI Gateway | `lib/llm.ts` client | gateway wrapper: routing/cost/limits/fallback | MODIFY | 4 |
| 12 | Knowledge System (4-level) | single-tenant RAG | scopes: global/jurisdiction/agent | MODIFY | 5 |
| 13 | Research Workforce | research copywriter (no sources) | real retrieval+verification+scoring pipeline | MODIFY/ADD | 6 |
| 14 | Content Workforce | marketing generator + FSM drafts | strategy→content→fact-check chain, versioning | MODIFY | 7 |
| 15 | SEO Workforce | none | — | ADD (DEFER) | 8 |
| 16 | Social Workforce | publishers + draft queue | social records, variants, calendar, metrics | MODIFY/ADD | 9 |
| 17 | Marketing Workforce | marketing generator | campaigns/audience/performance | ADD | 10 |
| 18 | Sales/Customer Workforce | sales generator + leads row | inquiry→classification→scoring→escalation chain; conversations | MODIFY/ADD | 11 |
| 19 | Analytics/Strategy | none | — | ADD (DEFER) | 12 |
| 20 | Website Connectors | widget embed only | WebsiteConnector interface + adapters | ADD | 13 |
| 21 | Supervisor | keyword router | planner/delegator w/ bounded rights | ADD (DEFER) | 14 |
| 22 | Controlled Autonomy | approval-always (good default) | levels 0–5 + policy engine + risk classes | ADD | 15 |
| 23 | Approval & risk engine | drafts FSM | task-level approvals, risk levels, reviewer identity | MODIFY | 3,7 |
| 24 | Goals | none | — | ADD (DEFER) | 16 |
| 25 | Budgets | none | per-agent/task cost caps + tracking | ADD | 4 |
| 26 | Auditability | approvals rows only | audit_logs everywhere | ADD | 1 |
| 27 | Emergency controls | none | kill-switches | ADD | 2–3 |
| 28 | Multi-website isolation | tenant row-scoping (tested) | website-level scoping + RLS evaluation | MODIFY | 1 |
| 29 | Auth & sessions | shared password | users/sessions/roles | REPLACE | 1 |
| 30 | Notifications | none | — | ADD | 3 |
| 31 | Event bus | none | — | ADD | 3 |
| 32 | Feature flags | none | — | ADD | 2 |
| 33 | CI/CD | none | GitHub Actions gate | ADD | 1 |
| 34 | Environments (dev/staging/prod) | prod-only (+prod-as-test-DB) | staging + ephemeral test DB | ADD | 1 |
| 35 | Observability/monitoring | env-check only | logs/metrics/health/cost dashboards | ADD | 1–4 |
| 36 | Backups/DR | none | PITR + RPO/RTO definition | ADD (DEFER to pre-prod) | pre-Phase 13 |
| 37 | Multilingual architecture | none (chunking is language-blind) | language fields + translation relationships | ADD | 5+ |
| 38 | Brand configuration | 3 fields + dead prompt column | full brand config incl. forbidden terms | MODIFY | 1–7 |
| 39 | Customer data isolation | tenant-scoped rows | website/BU ownership on customer records | MODIFY | 1,11 |
| 40 | Data export | none | machine-readable exports | ADD (DEFER) | 12+ |

---

## 18. DEPENDENCY ANALYSIS

Current runtime deps (4) and dev deps (6) (`package.json:17-30`); 40 packages installed total. The dependency policy implied by the code — "own the stack, raw fetch, no frameworks" — is an architectural decision the audit endorses continuing.

| Dependency | Verdict | Reasoning |
|---|---|---|
| `next` 16.3.4 | **KEEP** | Target stack names Next.js; App Router route handlers are the entire API surface; no lockfile risk. |
| `react` / `react-dom` 19.2.8 | **KEEP** | Required by Next; minimal client components today. |
| `pg` 8.23 | **KEEP** | Target DB is PostgreSQL; raw SQL is consistent with the platform philosophy and the audit's "no ORM" finding is a feature at this scale; `transaction()` helper is built on it. |
| `typescript` ^5 (dev) | **KEEP** | strict mode verified; `tsc --noEmit` exit 0. |
| `tsx` ^4.23 (dev) | **KEEP** | Test/migrate/seed runner; already the harness backbone. |
| `@types/*` (dev) | **KEEP** | Standard. |
| **Deliberately absent — correctly so** | — | No agent framework (LangGraph/CrewAI/OpenAI SDK), no ORM (Prisma/Drizzle), no auth library (NextAuth), no vector client (pgvector via raw SQL), no queue library (BullMQ etc.), no Tailwind/shadcn yet. None is required by evidence today; each adds constraints. Re-evaluate triggers: agent framework only when multi-step tool-loop agents ship (Phase 6+); auth library only if it provides sessions+RBAC without fighting the API-route model; UI kit at Command Center build (Phase 1 UI). |
| **Likely future needs (not installed now)** | — | `@vercel/*` or cron alternative for sub-daily schedules on Hobby→Pro; a PDF/DOCX text extractor when knowledge ingestion types land (Phase 5); possibly `zod`-equivalent for tool/output schema validation (§86–§87) — could remain hand-rolled given the existing validation style; an OAuth client flow for X/LinkedIn account linking (Phase 9). |

No dependency creates an architectural constraint today except one *absence-shaped* one: because tests run via `tsx` against `.env.local`, there is no test story that doesn't hit the live DB — that is a process constraint, not a package one, and Phase 1 should add an ephemeral database (branch DB / container) rather than a dependency.

---

## 19. MIGRATION STRATEGY

### 19.1 Options assessed

**A. Incremental migration in the current repository** — evolve schema additively (business_units/websites first), wrap existing modules with the new layers (gateway around `llm.ts`, task engine around `dispatch.ts`, registry around `catalog.ts`), replace the five REPLACE-class items in place.
*For:* every KEEP/MODIFY asset (§4: 31 of 57 items) survives; the test suites act as a continuous regression net; each phase ships value; no big-bang risk; repo already deploys cleanly.
*Against:* transitional complexity (dual-key window, compatibility shims); discipline required to not pile new code onto old seams (e.g., new endpoints must not skip auth).

**B. Parallel rebuild** — greenfield monorepo per Master Arch §119, port features module-by-module.
*For:* clean slate for RBAC/RLS/hierarchy; no transition shims.
*Against:* discards the working, tested core for months while the old system must still run; two systems to operate on a hobby-plan budget; the audit found nothing in the existing core that *cannot* be evolved (the only true rewrites are ≤ 5 narrow REPLACE items, each measured in days); the history of this project class (v1 → platform) shows parallel rebuilds stalling at the data-migration cutover.

**C. Partial extraction/rewrite** — keep the repo; rewrite only the platform layers (auth/tenancy/orchestration) as new packages while keeping agents/RAG/publishers.
*For:* focused effort on the actual gap.
*Against:* in practice this is Option A with more renaming upfront; the package-boundary ceremony buys nothing at 860 LOC of lib code; risks inventing abstraction before the second and third workflow exist to justify it.

### 19.2 Selection: **Option A — incremental migration**, with two strict riders

1. **Security-hardening gate before any target-phase work** (§10.4 items 1–2): close the three unauthenticated mutation endpoints and put real sessions in place. Incremental migration must not carry S1–S4 across the Phase 1 boundary.
2. **Schema evolution under versioned migrations from day one** (replaces the single DDL string): every roadmap phase lands as numbered, recorded, reversible-where-possible migrations — this is itself target §114 compliance.

### 19.3 How working capabilities stay working

- The **widget/chat path** keeps functioning through the tenancy shim (§12.2 Phase 2) — it is the live customer-facing surface and must not blink.
- The **approval FSM** keeps its semantics; new approval columns are additive; the admin UI keeps working until the Command Center replaces it screen-by-screen.
- The **sweep** keeps publishing under the daily cron; the job-queue introduction runs *alongside* it (sweep becomes the first job consumer) rather than replacing it in one cut.
- The **test suites** run at every step; any phase that breaks a suite is not done. New suites land per phase (§20 exit criteria).
- The **seed/demo tooling** is re-targeted (BU+website) early so the demo path doubles as the migration's own acceptance test.

### 19.4 Decision risks to monitor

- Transitional dual-key drift (tenant_id vs website_id) — bound it with a dated cleanup phase and lintable rule (no new `tenant_id` readers after Phase N).
- Hobby-plan ceilings (cron frequency, no preview protections) — plan the Pro upgrade decision at Phase 3, not ad hoc.
- Key-quota blocker (C2) — demo-facing phases remain blocked until the OpenAI billing issue is resolved; all infrastructure phases are unaffected.

---

## 20. REVISED PHASE 0–16 IMPLEMENTATION ROADMAP

Sequence mirrors the Master Arch phases, re-sequenced where AgentOS reality demands (security before scope; identity before hierarchy). No implementation begins now. "Reusable" = components from this audit's KEEP/MODIFY list.

**Phase 0 — Architecture rebaseline & audit (THIS DOCUMENT)**
Objective: decision-ready truth of code vs target. Deliverables: this report; risk register (S1–S15, R1–R7); readiness score; migration strategy. Dependencies: none. Reusable: all established. Modifications: none yet. New: none. Risks: findings decay if code moves (pin to HEAD `52f32e6`). Exit criteria: owner approval of target-alignment decisions and of the Phase 0.5 security gate.

**Phase 0.5 — Security hardening gate (inserted; prerequisite for everything)**
Objective: make the platform safe to expose to real tenants. Deliverables: auth (or interim bearer-scoped tokens) on channels/run/chat; per-IP+per-tenant rate limits; spend cap on LLM calls; audit rows for admin+ops calls; versioned migration runner replacing the DDL string. Dependencies: none. Reusable: `safeEqual`, AES-GCM, error contract, security suite. Modifications: 3 route guards; `admin.ts`; `migrations.ts`. New: `audit_logs` (minimal), rate-limit middleware. Risks: widget needs a public chat path — solve via per-site embed keys, not blanket auth. Exit criteria: no unauthenticated mutation endpoint remains; security suite extended and green; penetration smoke (unauth sweep of tenant ids) fails closed.

**Phase 1 — Platform foundation (users, BUs, websites, envs, CI)**
Objective: Master Arch Phase 1. Deliverables: users/roles/sessions; business_units + websites with additive migration + tenancy shim (§12.2); staging + ephemeral test DB; GitHub Actions CI (typecheck, suites, build); Command Center shell (nav skeleton) with Tailwind/shadcn baseline; feature-flag + system_settings table. Reusable: db seam, migrations, ops endpoints, demo seed (re-targeted), admin UI as interim. Modifications: auth model (REPLACE shared password), widget config resolution. New: RBAC tables, CI, staging. Risks: widget contract regression; dual-key drift. Exit criteria: administrator logs in, manages ≥2 BUs + ≥2 websites without code changes; all 14 suites + new auth/RBAC suites green in CI; widget still resolves seeded tenant.

**Phase 2 — Agent registry & versions**
Objective: agents become data. Deliverables: agents/agent_versions/agent_tools/agent_permissions + BU enablement; registry-seeded from current catalog; prompts versioned; per-run prompt-version attribution; agent dashboard (list/status/last run). Reusable: catalog as seed, generators as executors, dispatch loop, recordRun (extended). Modifications: prompt sourcing; run-row lifecycle (open at start). New: registry tables + admin screens. Risks: prompt migration changes outputs — gate with before/after golden prompts. Exit criteria: enable/disable an agent per BU in UI without deploy; every run row names its prompt version.

**Phase 3 — Task + workflow engine + events**
Objective: work happens in the background, reliably. Deliverables: tasks/task_steps/workflows/workflow_runs + job table with claims/retries/backoff; sweep refactored as Workflow #1; dispatch wrapped as task executor; event table + in-process bus; notifications v1 (dashboard+email on approval events); cron strategy resolved (Pro or external scheduler). Reusable: sweepDue shape, STATUS_FLOW, dispatch signature, cron route. Modifications: idempotent claims replace read-then-write; retries on publish failure (currently terminal). New: everything else. Risks: double-publish during cutover — mitigated by claim keys before flip. Exit criteria: a scheduled workflow executes with browser closed (Master Arch Phase 3 criterion); forced duplicate sweep produces zero duplicate posts.

**Phase 4 — AI Gateway & cost control**
Objective: one controlled doorway for every model call. Deliverables: gateway wrapper (routing policy, timeout/abort, retry+fallback, usage capture, cost records, request logging, rate limits); provider adapter interface formalizing `LLMClient`; embedding-dimension strategy decided; structured-output + validation helper. Reusable: `lib/llm.ts` as innermost adapter; llm test suite as adapter-contract template. Modifications: all `ctx.llm` call sites route through gateway (non-invasive — seam already exists). New: llm_requests/cost tables; dashboards. Risks: usage extraction varies by provider; keep per-adapter. Exit criteria: every completion records model/tokens/cost tied to run_id; budget cap demonstrably halts a runaway agent; fallback model proven on forced 429.

**Phase 5 — Knowledge system v2**
Objective: scoped, sourced, hybrid knowledge. Deliverables: knowledge_sources/documents/chunks evolution (jurisdiction/language/access/authority), fetchers (sitemap/URL/RSS first, PDF/DOCX next), hybrid retrieval (tsvector + vector + filters), scope-resolution service, knowledge admin screens. Reusable: ingest/retrieve core, checksum dedup, guards, RAG test templates. Modifications: chunking upgrade; dimension strategy. New: source fetchers. Risks: re-embedding cost; legal-domain chunking quality. Exit criteria: agent answers using only authorized website+jurisdiction knowledge (extended leak tests prove global vs BU vs jurisdiction separation).

**Phase 6 — Research workforce**
Objective: real intelligence, not copywriting. Deliverables: Research + Intelligence agents per §52–§53 contracts (sources, confidence, scores, recommendations), research_items storage, scheduled daily research workflow (Master Arch first use case §137), source authority tiers. Reusable: generator executor pattern, workflow engine, knowledge v2. Modifications: research generator rewritten against retrieval+tools. New: tool `web_search`/`fetch_url` with schemas+limits. Risks: source quality/legal accuracy — enforce tiering + citation mandate. Exit criteria: daily run produces cited, scored findings per BU without human trigger; findings visible in Command Center.

**Phase 7 — Content workforce**
Objective: research → reviewable content packages. Deliverables: content_items/content_versions migration (drafts lineage), strategy→content→fact-check chain, content lifecycle states, approval center v2 (risk levels, reviewer identity, edit-before-approve). Reusable: FSM, approval queue UI patterns, marketing generator. Modifications: drafts table restructure (§5.1). New: fact-check agent, versioning. Risks: migration of live drafts — keep FSM mapping documented. Exit criteria: a research finding becomes a versioned, fact-checked, approval-gated content package end-to-end.

**Phase 8 — SEO workforce** — Objective: keyword intelligence + gap analysis + recommendations. Reusable: research pattern. New: SEO agent + keyword store. Exit criteria: SEO recommendations appear with evidence and required-approval flags.

**Phase 9 — Social workforce**
Objective: social as first-class records. Deliverables: social_accounts (absorbing channels incl. LinkedIn account-ref fix), social_posts, campaigns; platform variants from content items; scheduling calendar; OAuth account linking; publish metrics. Reusable: publisher adapters, sweep/job machinery, approval gate. Modifications: channels migration; draft-only IG/TikTok upgraded to real adapters here. Risks: platform API variance; OAuth security (§77). Exit criteria: one approved content item yields per-platform scheduled posts; publish appears on calendar and records metrics; no post escapes approval unless policy permits.

**Phase 10 — Marketing workforce** — Objective: campaigns, audience analysis, performance monitoring. Reusable: content+social foundations. Exit criteria: campaign lifecycle (draft→approval→performance) operational per §91 autonomy defaults.

**Phase 11 — Sales + customer workforce**
Objective: inquiries→leads→escalation. Deliverables: inquiries + conversations storage (widget chat persists), classification/scoring agents (§55, §63 stages), escalation paths, lead pipeline UI. Reusable: leads table (stage migration), chat grounding, widget (adapted, §13). Modifications: widget becomes website-registered; sales generator becomes classification+draft chain. Risks: customer-data isolation — enforce website ownership (§101). Exit criteria: website inquiry flows to classified, scored lead with human escalation path; conversations never expose internal reasoning (§65).

**Phase 12 — Analytics + strategy** — cross-business dashboards, reporting agent (daily/weekly/monthly), recommendation engine. Exit criteria: owner-level cross-BU reporting with per-BU privacy respected (§99).

**Phase 13 — Website connectors**
Objective: connect the initial sites; make Add Website a repeatable config workflow. Deliverables: WebsiteConnector interface + first adapters (dedicated-endpoint + webhook for the four seed sites), signed inbound webhooks (§77), capability grants per site (§12), Add-Website wizard. Reusable: widget integration as connector #1; integration credentials model. Exit criteria: onboarding a new site = configuration only (Master Arch §121–§123 test); failing one site does not affect others (§144).

**Phase 14 — Supervisor**
Objective: bounded planner/delegator. Deliverables: Supervisor agent (§57 contract) producing task graphs consumed by the Phase 3 engine; handoff logging (§23); escalation rules; keyword router demoted to classifier step. Reusable: dispatch, tasks, events. Risks: over-delegation — hard budget/permission ceilings. Exit criteria: a stated goal decomposes into delegated, logged, approval-respecting tasks.

**Phase 15 — Controlled autonomy**
Objective: graduated autonomy on evidence. Deliverables: autonomy levels 0–5 per agent/BU, policy engine (§49–§50 incl. legal-safety hierarchy), evaluation datasets + metrics (§105–§109), progression gates (§110). Exit criteria: a proven workflow moves from approval to automatic under policy, with rollback switch.

**Phase 16 — Autonomous business operations**
Objective: goal loop (§66–§67, §134). Deliverables: goals/goal_progress, recommendation-driven planning, budget-bounded loops, full emergency-controls verification. Exit criteria: Master Arch §160–§162 definition-of-done checklist passes; "knowing when to stop and ask a human" demonstrated.

**Dead-end prevention notes:** (1) identity+audit land before any multi-BU data exists; (2) embedding-dimension and content-versioning decisions land before data volume makes them migrations-from-hell; (3) the approval-gate invariant survives every phase — no phase may add an autonomous public publish path; (4) every phase's DB change is a versioned migration, never a hot DDL.

---

## 21. RECOMMENDED FIRST IMPLEMENTATION PHASE

Per this audit, the first implementation move is **Phase 0.5 — the security hardening gate** (§20 above, §10.4 order): close S1–S3, introduce minimal audit logging, and convert schema management to versioned migrations. Rationale: it is small, it unblocks every later phase (nothing may safely ship to real tenants while three mutation endpoints are open), it does not depend on the OpenAI quota blocker, and it creates the migration machinery all subsequent phases require. Phase 1 (identity + BusinessUnit/Website foundation) follows immediately after, per §19.2's riders.

> ### PHASE 0 COMPLETE — WAIT FOR OWNER APPROVAL
>
> No implementation work is authorized by this document. The repository remains at HEAD `52f32e6` with the audit performed strictly read-only. Next action belongs to the owner: approve (or amend) the classifications, the security-gate insertion, and the Option-A migration strategy. Only then may Phase 0.5 begin.

---

## 22. FINAL DECISION

**Decision: Option 3 — use AgentOS as the foundation and rebaseline it against the Master Architecture.**

Why not Option 1 (start from scratch): the reusable core — RAG engine, approval FSM, publisher adapters, crypto, DB seam, widget, test discipline — is exactly the set of mechanics the target needs, already built and already tested. The audit found no structural defect that a rewrite would avoid and an evolution would not; the five REPLACE items are narrow (auth model, channel wire-up endpoint, outbox-as-queue, agent-definitions-as-code, one-page UI), each replaceable in place without disturbing the rest. A rebuild would re-purchase, at higher risk, the ~43% that already works.

Why not Option 2 (continue unchanged): the current system is architecturally incapable of becoming the target by accretion alone — three unauthenticated mutation endpoints, no identity, no hierarchy, no run lifecycle, no gateway, no audit. Its security findings (S1–S3 Critical) are disqualifying for real tenants, and its tenancy model cannot express the target's central BusinessUnit→Website concept.

Option 3 captures both truths: keep and evolve what is proven (9 KEEP + 22 MODIFY items), replace the narrow conflicts (5 REPLACE items), and build the missing platform layers (18 ADD items) in the Master Architecture's own phase order — with a security gate first and versioned migrations from day one. This is the lowest-risk path that ends at the target instead of at a nicer social-media scheduler.

---

## APPENDIX A — EVIDENCE INDEX (primary sources)

- **Schema:** `lib/migrations.ts:9-125` (11 tables, DDL, table list)
- **DB seam:** `lib/db.ts:1-30` · **Crypto:** `lib/channels.ts:1-26` · **Auth guards:** `lib/admin.ts:5-19`, `lib/security.ts:3-9`
- **LLM client:** `lib/llm.ts:1-55` · **RAG:** `lib/rag/ingest.ts:1-63`, `lib/rag/retrieve.ts:1-26` · **Chat:** `lib/agents/chat.ts:1-24`
- **Agents:** `lib/agents/catalog.ts:5-17`, `types.ts:1-10`, `core.ts:4-40`, `dispatch.ts:11-47`, `generators.ts:8-66`, `approval.ts:3-81`, `publishers/index.ts:1-104`
- **Widget:** `public/widget.js:1-106`, `lib/widget.ts:1-25` · **Seed:** `lib/demo-seed.ts:1-103`, `scripts/seed-demo.ts`, `scripts/migrate.ts`
- **Routes:** `app/api/agents/run/route.ts`, `app/api/agents/sweep/route.ts`, `app/api/v1/chat/route.ts`, `app/api/v1/channels/route.ts`, `app/api/v1/widget/config/route.ts`, `app/api/admin/{login,drafts,drafts/[id],migrate,seed,env-check}/route.ts`
- **UI:** `app/page.tsx`, `app/admin/page.tsx`, `app/admin/login/page.tsx`, `app/layout.tsx`
- **Tests:** `tests/run-all.ts` + 14 suites (per-suite citations in §15.1)
- **Config/deploy:** `package.json`, `vercel.json`, `.env.example`, `tsconfig.json`, `next.config.ts`, `.gitignore`
- **Docs audited:** `README.md`, `HANDOFF.md`, `AGENTOS-RUNBOOK.md`, `AGENTS.md`, `CLAUDE.md`, `docs/specs/2026-09-09-agentos-design.md`, `docs/superpowers/plans/2026-09-09-agentos.md`
- **Target:** *Master Technical Architecture & Build Specification — Multi-Website AI Workforce & AI Command Center* v1.0 (§1–§167, Phases 0–16)
- **Ops history:** `AGENTOS-RUNBOOK.md` §2–§8 + prior-session worklog (deployment remediation of 2026-09-11)

## APPENDIX B — EXPLICIT NOT-VERIFIED REGISTER

1. End-to-end live publishing to X/LinkedIn/Resend (never attempted in audit; LinkedIn statically broken per R4).
2. OpenAI quota status today (prior session: 429 insufficient_quota).
3. Vercel cron actually invoking `/api/agents/sweep` in production.
4. GitHub→Vercel auto-deploy behavior on push (no push performed).
5. Test-suite execution result on current HEAD (excluded as DB-writing; last known all-pass was prior session, pre-`52f32e6`).
6. Env-check/authenticated admin endpoints at runtime (requires the admin password over the network; deliberately not exercised).
