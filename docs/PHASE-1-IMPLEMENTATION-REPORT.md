# PHASE 1 — IMPLEMENTATION REPORT

**Project:** AgentOS → Multi-Website AI Workforce & AI Command Center (`kosovohomes/Master-agent`, branch `main`)
**Implemented:** Phase 1 — Platform Foundation, exactly as defined in §12 (Step 13) of `PHASE-0.5-Final-Architecture-Reconciliation.md`
**Commits:** `6ef9af4` (Phase 1 foundation), `eae3a95`→`ecd81dd` (route files + fix for the owner's uploaded documents), `eae3a95..ecd81dd` history clean
**Date:** 2026-09-11
**Milestones:** M0 Security Gate ✅ · M1 Identity + RBAC ✅ · M2 Business Units + Websites ✅ · M3 Ops + CI + Command Center ✅

---

## 1. Executive summary

Phase 1 transformed AgentOS from a shared-password demo into a platform foundation that can hold a multi-website AI workforce. Every one of the seven security vulnerabilities named in the mandate is closed in production, not just in code: the unauthenticated channel-wireup, agent-run, and chat endpoints are guarded/rate-limited; the shared `ADMIN_PASSWORD` no longer authenticates any dashboard; the sessionStorage password pattern is deleted; audit logging covers every administrative mutation; migrations are versioned and ledgered; and the approval FSM is transactional with recorded reviewers. On top of the security gate, the platform gained real identity (scrypt + server-side sessions + RBAC enforced server-side), the target entity hierarchy (`BusinessUnit → Website → WebsiteIntegration → Capabilities`) with a safe additive legacy mapping, feature/emergency flags, a Command Center shell (login, dashboard, websites, approvals, audit, settings), six new test suites, and green CI on ephemeral infrastructure. Nothing from Phase 2+ (agent registry, workflows, AI Gateway, knowledge v2, connectors, autonomy) was implemented. The live deployment is migrated, verified, and the widget contract never blinked: `acme-homes` (tenant 491) resolves identically before and after.

## 2. What was implemented

- **M0 — Security Gate:** versioned migration runner + `schema_migrations` ledger (11 versions, 000–010); `audit_logs` + best-effort writer with recursive secret redaction wired into every mutating route; fail-closed guards on `POST /api/v1/channels` and `POST /api/agents/run`; public-chat mitigations (per-IP rate limit, per-tenant daily LLM cap via `tenant_usage_daily`, `stop_all_agents` emergency flag, embed-token verification hook); per-IP fixed-window rate limiting (`lib/security/ratelimit.ts`) returning real 429s with `Retry-After`; audit rows on ops endpoints (migrate/seed/env-check) and the cron sweep; emergency flags v1 (`stop_all_agents`, `disable_publishing`) enforced in the execution paths.
- **M1 — Identity + RBAC:** scrypt password hashing with per-user salt (`node:crypto`, self-describing `scrypt$N$r$p$salt$hash` format); opaque 256-bit session tokens stored only as SHA-256 hashes; httpOnly + Secure + SameSite=Lax cookie with 7-day sliding expiry; logout deletes the session row; login rate limiting (10/5 min/IP) + account lockout (5 failures → 15 min); roles × permissions × role_permissions × user_roles with owner/administrator/operator/reviewer active (analyst/developer/agent seeded inactive); `requirePermission`/`requireSession`/`sessionOrLegacyBearer` guards enforced server-side; BU-scoped reads via `user_roles.business_unit_id`; transactional approval FSM (`SELECT … FOR UPDATE` inside `transaction()`) with `reviewer_user_id` recorded; `POST /api/auth/login|logout`, `GET /api/auth/me`, one-time `POST /api/admin/bootstrap`, owner-only `GET/POST/PATCH /api/admin/users`; deletion of the old sessionStorage admin surface with bookmark redirects.
- **M2 — Business Units + Websites:** `business_units` (with `legacy_tenant_id BIGINT UNIQUE` 1:1 mapping + brand-field copy from `tenant_config` inside migration 007's transaction), `websites` (1:1 default site backfill), `website_integrations` + `website_capabilities` (structure only, per spec); `lib/bu.ts` service with legacy mapping helpers (`ensureLegacyMapping`, `buForLegacyTenantId`, `legacyTenantIdForBu`, `permittedLegacyTenantIds`); `GET/POST/PATCH /api/admin/business-units` and `/api/admin/websites` (scoped reads, guarded writes, audited); demo seed re-targeted to create the BU + website mapping idempotently; widget compatibility preserved by leaving `lib/widget.ts` untouched and verifying resolution end-to-end.
- **M3 — Ops + CI + Command Center:** `lib/settings.ts` (system_settings + feature_flags), `GET/PUT /api/admin/settings`, `GET /api/admin/audit`; Tailwind v4 Command Center shell (`/login`, `/dashboard`, `/websites`, `/approvals`, `/audit`, `/settings`) with server-side session gate in `(dashboard)/layout.tsx`, permission-filtered navigation, professional dark-sidebar design, no placeholder pages for future phases; GitHub Actions CI (typecheck + 20 test suites + production build on an ephemeral `pgvector/pgvector:pg16` container — no production credentials); staging strategy (`docs/STAGING.md`) with explicit separation from the production Neon endpoint, which is hard-coded as a refusal marker in `tests/run-all.ts`; documentation pass fixing contradictions C-8 through C-12.

## 3. What was intentionally NOT implemented (Phase 2+ scope)

Agent Registry / agent versions / machine identities; Supervisor; autonomous agents or autonomy levels; the Task + Workflow Engine, job queue, and event bus; the AI Gateway (provider abstraction, budgets, cost ledger — the Phase 1 daily cap is explicitly a "crude" stand-in); Knowledge v2 (scopes, legal metadata, hybrid retrieval); Website Connectors and the Add-Website wizard; autonomous publishing (generation remains autonomous, publication remains human-gated); RLS policies (SEC-L1, scheduled for Phase 2 with real multi-BU data governance); key-id envelope encryption for channel tokens (SEC-L2, Phase 2); 2FA/device binding (SEC-L6 depth); shadcn/ui component library (see §28, deviation 3). No route pretends any of this exists — the dashboard footer states the scope note explicitly.

## 4. Every file created

**lib:** `lib/audit.ts` · `lib/settings.ts` · `lib/bu.ts`
**lib/auth/:** `password.ts` · `sessions.ts` · `rbac.ts` · `guards.ts` · `server.ts`
**lib/migrations/:** `definitions.ts` (000–010) · `runner.ts` · `index.ts`
**lib/security/:** `ratelimit.ts`
**API routes:** `app/api/auth/login/route.ts` · `app/api/auth/logout/route.ts` · `app/api/auth/me/route.ts` · `app/api/admin/bootstrap/route.ts` · `app/api/admin/users/route.ts` · `app/api/admin/business-units/route.ts` · `app/api/admin/websites/route.ts` · `app/api/admin/settings/route.ts` · `app/api/admin/audit/route.ts`
**UI:** `app/login/page.tsx` · `app/(dashboard)/layout.tsx` · `app/(dashboard)/dashboard/page.tsx` · `app/(dashboard)/websites/page.tsx` · `app/(dashboard)/approvals/page.tsx` · `app/(dashboard)/audit/page.tsx` · `app/(dashboard)/settings/page.tsx`
**Tests:** `tests/auth-tests.ts` · `tests/rbac-tests.ts` · `tests/ratelimit-tests.ts` · `tests/audit-tests.ts` · `tests/migrations-tests.ts` · `tests/bu-website-tests.ts`
**Infra/docs:** `.github/workflows/ci.yml` · `docs/STAGING.md` · `postcss.config.mjs` · (this report also mirrored into the repo as `docs/PHASE-1-IMPLEMENTATION-REPORT.md`)

## 5. Every file modified

`app/api/v1/channels/route.ts` (guard + rate limit + audit) · `app/api/v1/chat/route.ts` (rate limit + cap + flag + site-key hook) · `app/api/agents/run/route.ts` (guard + cap + flag + audit) · `app/api/agents/sweep/route.ts` (audit + `disable_publishing` flag) · `app/api/admin/migrate/route.ts` (runner + audit) · `app/api/admin/seed/route.ts` (audit + BU/website fields) · `app/api/admin/env-check/route.ts` (audit) · `app/api/admin/drafts/route.ts` (session-or-legacy + BU scoping + status filter) · `app/api/admin/drafts/[id]/route.ts` (per-action permission + reviewer + audit) · `lib/agents/approval.ts` (transactional FSM + reviewer + multi-tenant read helper) · `lib/demo-seed.ts` (BU/website mapping + new result fields) · `lib/migrations.ts` → renamed `lib/migrations-legacy.ts` (header updated; body verbatim) · `scripts/migrate.ts` (runner) · `next.config.ts` (/admin redirects) · `app/globals.css` (Tailwind + design tokens) · `app/layout.tsx` (metadata + standard children typing) · `package.json` / `package-lock.json` (tailwindcss + @tailwindcss/postcss devDeps) · `.env.example` (ops/bootstrap comments + cap tunable) · `README.md` (widget embed fix C-8, API/auth table) · `AGENTOS-RUNBOOK.md` (C-9/C-10/C-11/C-12 fixes, endpoint table, ops section restored with bootstrap flow) · `tests/admin-tests.ts` (legacy-surface assertions) · `tests/security-tests.ts` (bearer headers where M0 changed behavior) · `tests/dispatch-tests.ts` / `tests/publishers-tests.ts` (bearer headers for route tests) · `tests/run-all.ts` (6 new suites + production-DB refusal guard).

## 6. Every file deleted

`app/admin/login/page.tsx` · `app/admin/page.tsx` · `app/api/admin/login/route.ts` — the entire shared-password sessionStorage surface (SEC-C4). Also removed: stray root `seed-demo.ts` (uploaded to the repo root by the owner mid-phase; its `../lib/*` imports resolve outside the repo and broke typecheck — identical content lives at `scripts/seed-demo.ts` and in git history `651a699`).

## 7. Database migrations created

Ledger `schema_migrations(version, name, checksum, applied_at, applied_by)`; each migration runs in its own transaction with its checksum recorded; concurrent runners lose the race gracefully.

| # | Name | Content |
|---|---|---|
| 000 | agentos_legacy_baseline | The pre-Phase-1 11-table schema verbatim (no-op on live DB; completes the ledger from empty) |
| 001 | schema_migrations | The ledger table itself |
| 002 | audit_logs | + 3 indexes (created_at DESC, actor_id, action) |
| 003 | users_sessions | `users` (email UNIQUE, scrypt hash, status, lockout fields), `sessions` (token_hash UNIQUE, expiry, ip/ua) |
| 004 | rbac_seed | `roles`, `permissions`, `role_permissions`, `user_roles` + seed: 7 roles (4 active), 10 permissions, per-role grants |
| 005 | settings_flags_seed | `system_settings`, `feature_flags` + seed: stop_all_agents(off), disable_publishing(off), legacy_bearer_auth(on) |
| 006 | tenant_usage_daily | Daily per-tenant LLM counters, PK (day, tenant_id) |
| 007 | business_units_websites_backfill | `business_units` + `websites` + `user_roles.business_unit_id` + **1:1 backfill transaction** (tenants→BUs with tenant_config brand copy; one default website per BU) |
| 008 | website_integrations_capabilities | Structure only (UNIQUE website+type/capability) |
| 009 | channels_add_columns | `target`, `metadata JSONB`, `display_name` (additive, fixes LinkedIn author-URN plumbing path) |
| 010 | approvals_reviewer_user | `reviewer_user_id` → users ON DELETE SET NULL (audit-path tables carry no cascades) |

## 8. Database tables/columns/indexes changed

New tables: `schema_migrations`, `audit_logs`, `users`, `sessions`, `roles`, `permissions`, `role_permissions`, `user_roles`, `system_settings`, `feature_flags`, `tenant_usage_daily`, `business_units`, `websites`, `website_integrations`, `website_capabilities` (15). Columns added to existing tables: `channels.target/metadata/display_name`, `approvals.reviewer_user_id`, `user_roles.business_unit_id`. New indexes: `audit_logs_*` ×3, `sessions_user_idx`, `sessions_expires_idx`, `websites_bu_idx`, `website_integrations_website_idx`, `website_capabilities_website_idx`. **Nothing was renamed, dropped, or destructively altered.** The legacy `tenants` table remains authoritative for legacy readers and is untouched.

## 9. Data migration / backfill performed

Production (Neon `neondb`): migration 007's transactional backfill mapped each existing tenant to a business unit (`business_units.legacy_tenant_id`, brand fields copied from `tenant_config`) and created one default production website per BU. Tenant `491` (`acme-homes`) is now represented as BU id 1 + website id 1 in production, with `tenants` still resolving for every legacy reader. `ensureLegacyMapping()` guarantees any tenant created post-migration (e.g. by the demo seed) receives the same 1:1 treatment idempotently. No rows were deleted anywhere; no data left the database.

## 10. Authentication architecture

Email + password. Hashing: scrypt (N=16384, r=8, p=1, 64-byte key) with a 16-byte per-user random salt, verified with `timingSafeEqual`; the stored string is self-describing so parameters can evolve without a rehash migration. Sessions: `crypto.randomBytes(32)` → base64url (256-bit opaque token); only `sha256(token)` is stored; cookie `agentos_session` with `HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=604800`; server-side sliding expiry (7-day TTL, renewed when <6 days remain, throttled to ≤1 write/hour/session); logout and user-disable destroy rows. Protections: per-IP login rate limit (10/5 min → 429), per-account lockout (5 failures → 15 min, unlockable by the owner via `PATCH /api/admin/users`), generic `LOGIN_FAILED` for unknown-email vs wrong-password (no enumeration), audit rows on every attempt. First owner: `POST /api/admin/bootstrap` (OPS_TOKEN/ADMIN_PASSWORD bearer, 409 once any user exists). `ADMIN_PASSWORD`/`OPS_TOKEN` now authenticate **only** the ops endpoints (migrate/seed/env-check/bootstrap) and the flag-gated legacy path below — never a dashboard. No new auth dependency; `node:crypto` only, per §12.5.

## 11. RBAC architecture

`users → user_roles (business_unit_id NULL = global) → roles → role_permissions → permissions`. Roles seeded: owner / administrator / operator / reviewer (active); analyst / developer / agent (inactive, Phase 2+). Permissions seeded: `bu.manage`, `website.manage`, `drafts.read`, `drafts.approve`, `drafts.schedule`, `agents.run`, `users.manage`, `settings.manage`, `audit.read`, `ops.run`. Grant matrix: owner = all; administrator = everything except `users.manage` and `ops.run`; operator = `drafts.read`, `drafts.schedule`, `agents.run`; reviewer = `drafts.read`, `drafts.approve`. Enforcement is server-side only: route handlers declare `requirePermission(req, perm)` (or `requireAnyPermission` for shared reads); the drafts action route resolves the required permission from the parsed action (`drafts.approve` for approve/reject, `drafts.schedule` for schedule) so a reviewer cannot schedule and an operator cannot approve. BU scoping: `buScopeForUser()` → "all" for owner/administrator or global assignments, else the assigned-BU list; draft reads filter through `business_units.legacy_tenant_id`, and an out-of-scope `tenantId` is a 403 `BU_SCOPE_DENIED`, never a silent filter. Denials are 401 (no credentials) or 403 (insufficient permission) and are audited.

## 12. Rate-limit implementation

Two layers in `lib/security/ratelimit.ts`. (1) In-memory fixed-window buckets per key (`ip:endpoint-group`): login 10/5 min; channels 10/10 min; agents/run 5/min; chat 10/min. 429 responses carry `Retry-After`; the limiter runs **before** body parsing so attackers cannot buy parse work. (2) Persistent per-tenant daily LLM cap in `tenant_usage_daily` (UPSERT counter, default 200/day, `DAILY_TENANT_LLM_CAP` tunable) enforced on `agents/run` and `chat`; tripping it returns 429 `DAILY_LLM_CAP_REACHED`; the counter is FK-tolerant for nonexistent tenants so unknown-tenant requests keep the legacy 500-JSON path. Documented limitation: buckets are per serverless instance (they bound per-instance abuse and satisfy the acceptance criteria; a shared-visibility limiter arrives with the Phase 3 job engine), while the cost cap is DB-backed and global from day one.

## 13. Audit implementation

`audit_logs` records: `actor_type` (user/system/agent/anonymous), `actor_id`, `actor_label` (e.g. `ops:bearer`, cron, attempted email), `action` (`auth.login`, `auth.logout`, `channels.wireup`, `agents.run`, `chat.answer`, `draft.approve|reject|schedule`, `bu.create|update`, `website.create|update`, `users.*`, `settings.flag`, `settings.emergency_flag`, `ops.migrate|seed|env_check`, `publishing.sweep`), `resource`, `resource_id`, `result` (success/failure/denied), `request_id` (inbound `x-request-id` honored, else UUID), `ip`, and sanitized JSONB `metadata`. `sanitizeMetadata()` recursively redacts any key matching `(password|passwd|secret|token|api_key|authorization|cookie|credential)` before write; tests prove generated passwords never reach the table. Writes are awaited but non-fatal on failure (loud console error, business operation unaffected) — revisited with the Phase 3 event bus. Wired into: all nine guarded/admin routes, the three ops endpoints, the sweep, and denial paths of every guarded route.

## 14. BusinessUnit/Website implementation

Entity hierarchy `BusinessUnit → Website → (WebsiteIntegration, Capabilities)` with the legacy bridge `business_units.legacy_tenant_id UNIQUE REFERENCES tenants(id)` (nullable UNIQUE: legacy tenants map exactly once; **new** businesses need no tenant row — this is what makes "arbitrary future businesses" possible). `lib/bu.ts` owns CRUD + slugify + mapping helpers; APIs expose scoped reads (any staff permission among bu/website/drafts sets, filtered by BU scope) and `bu.manage`/`website.manage`-guarded writes; the UI (`/websites`) performs create/edit/status-toggle entirely through these APIs — adding "AI News Platform" tomorrow is configuration rows only. Integration/capability tables exist structurally; the widget is registered as integration type `widget` only when a site key is provisioned (Phase 11 full treatment).

## 15. API changes

New: `POST /api/auth/login`, `POST /api/auth/logout`, `GET /api/auth/me`, `POST /api/admin/bootstrap`, `GET|POST|PATCH /api/admin/users`, `GET|POST|PATCH /api/admin/business-units`, `GET|POST|PATCH /api/admin/websites`, `GET|PUT /api/admin/settings`, `GET /api/admin/audit`. Changed (guarded): `POST /api/v1/channels` (401 without session+`website.manage` or flag-gated bearer), `POST /api/agents/run` (401 without `agents.run`; rate limit → flag → daily cap), `POST /api/v1/chat` (public but rate-limited, capped, flag-gated, optional site-key verification), `GET/POST /api/admin/drafts*` (session-or-legacy; BU-scoped; reviewer recorded), `POST /api/admin/migrate|seed`, `GET /api/admin/env-check` (runner + audit; bearer unchanged). Removed: `POST /api/admin/login`. Unchanged: `GET /api/v1/widget/config` (public, untouched). Error contract `{ errors:[{code, detail?}] }` preserved everywhere; `x-request-id` echoed in `meta` where routes mint correlation ids.

## 16. UI changes

The sessionStorage admin pages are gone. The Command Center is a Tailwind v4 route group `app/(dashboard)/` sharing a server-gated layout (sidebar: Dashboard / Websites / Approvals / Audit / Settings, filtered by the signed-in user's permissions; identity + sign-out in the sidebar footer). `/dashboard` shows scoped counts (BUs, websites, pending approvals, 24h audit events) plus a BU table. `/websites` is the full BU + website management surface (create, edit domain, suspend/activate) — no code changes needed to onboard a business. `/approvals` reproduces the approval queue with a BU picker, approve/reject/schedule, and server-side reviewer recording. `/audit` is a filterable viewer (action prefix, result) with sanitized metadata rendering. `/settings` lists feature flags with emergency flags visually distinct and toggle actions that hit the guarded, audited API. `/login` is the single sign-in surface. Legacy bookmarks: `/admin → /approvals`, `/admin/login → /login` (307).

## 17. Dependencies added/removed

Added (devDependencies only): `tailwindcss@4.3.3`, `@tailwindcss/postcss@4.3.3`. Justification: the approved Phase 1 frontend direction is "Tailwind+shadcn baseline" (Phase 0.5 §11); Tailwind is the foundation half, PostCSS-integrated with zero runtime deps. shadcn/ui itself was **not** added (see §28.3). No runtime dependencies added; authentication uses `node:crypto` per the no-new-dependency directive; removed: none.

## 18. Environment variables added/changed

Added optional: `DAILY_TENANT_LLM_CAP` (default 200) — per-tenant daily LLM-call ceiling. Changed: none. Removed: none. `ADMIN_PASSWORD`/`OPS_TOKEN` semantics narrowed (ops endpoints + flag-gated legacy path only) but the variable names are unchanged, so no deployment env surgery was required. `.env.example` documents the new optional var.

## 19. CI configuration

`.github/workflows/ci.yml`: on push/PR → `pgvector/pgvector:pg16` service container → `npm ci` → `tsc --noEmit --incremental false` → `npx tsx scripts/migrate.ts` (applies the ledger to the ephemeral DB) → full suite via a generated `.env.local` (fake constants only; production credentials never enter CI) → `npm run build`. Verified live: run for `ecd81dd` completed **success** (typecheck, 20 suites, build). The first run failed on the incomplete commit and was fixed by `ecd81dd`; the failure and fix are part of the record.

## 20. Staging configuration

`docs/STAGING.md` defines the isolation model (production Neon endpoint fragment `aui4sh0g` is a hard refusal marker in `tests/run-all.ts` — the suite exits 2 rather than touching production), two options for the separate staging database (Neon branch or second database), the Vercel second-project procedure with staging-scoped secrets, a refresh checklist, and the local ephemeral-Postgres recipe used during this phase. Activation of the actual Vercel staging project is a 15-minute owner action from that document (it requires creating the Neon branch and a Vercel project — account-level actions, documented step-by-step).

## 21. Tests added

Six suites, all standalone `tsx` scripts matching the existing house style (direct route-handler invocation, per-check PASS/FAIL, strict cleanup): `auth-tests` (18 checks: scrypt properties, login cookie flags incl. exact `Max-Age=604800`, no-enumeration, lockout 423, expiry 401, sliding renewal, logout semantics) · `rbac-tests` (role × route denial matrix: anon 401s, owner vs reviewer vs operator vs administrator, per-action draft permissions, BU-scoped narrowing + `BU_SCOPE_DENIED`, reviewer recorded) · `ratelimit-tests` (bucket semantics, login/run/chat floods → 429, DB-backed daily cap incl. authenticated over-cap 429) · `audit-tests` (system vs user actors, resource/id/request-id capture, denied-write rows, recursive secret redaction at write time) · `migrations-tests` (ledger order/checksums, re-run noop, **apply-to-empty on a throwaway database via subprocess**, second-run all-skipped, seed assertions) · `bu-website-tests` (1:1 mapping idempotency, brand copy, widget slug+numeric resolution, two-BU/two-website coexistence, cross-BU denial).

## 22. Existing tests status

All **14 existing suites remain green** (448 total PASS checks across 20 suites, exit 0). Where M0 deliberately changed behavior, tests were updated to the new intended contract — nothing was weakened: `security-tests` (unauthenticated channels/run now assert 401; authenticated calls use the fake ops bearer), `admin-tests` (deleted-surface assertions replace deleted-page assertions), `dispatch-tests`/`publishers-tests` (route tests now authenticate with a fake bearer). The approval FSM, RAG, widget, channels crypto, publishers, and routing tests are untouched in substance.

## 23. Typecheck status

`npx tsc --noEmit --incremental false` — **clean** locally and in CI. (The `LayoutProps<"/">` app/layout typing was replaced with the standard `{ children: React.ReactNode }` because the former only exists after a `next build`, which broke fresh-checkout typecheck.)

## 24. Build status

`npm run build` — **passes** locally and in CI; 27 routes generated; `/login` static, all dashboard + API routes dynamic. Tailwind v4 PostCSS integration verified in the compiled output.

## 25. Security verification

Live `curl` sweep against production (`masteragent-nine.vercel.app`): unauthenticated `POST` to channels → **401**, agents/run → **401**, admin routes → 401/403/405 (fail closed); public chat flood → 429 at request 11; legacy bearer still honored on drafts (flag-gated transition) but **not** on the new audit API (session + `audit.read` only); `stop_all_agents` toggled ON → `agents/run` returns 503 `AGENTS_STOPPED` → toggled OFF. Local: sessionStorage/Bearer-password patterns provably absent from `app/` (test-enforced); cookie flags asserted character-exact in `auth-tests`; lockout, expiry, and sliding behavior asserted against the real tables; audit rows carry the authenticated actor for every administrative mutation (test-enforced + spot-checked live). On production: `POST /api/admin/migrate` re-run is `noop:true` with ledger size 11; widget resolves tenant 491 by slug **and** numeric id post-migration.

## 26. Migration idempotency verification

Verified at three levels: (1) `migrations-tests` asserts ledger order/checksums and a no-op second run, and performs a true **apply-to-empty** on a throwaway database via subprocess (applies 000–010 from zero, asserts 11 ledger rows, 11 Phase 1 tables, backfill no-op on zero tenants, RBAC/flags seeds, then a second all-skipped run); (2) the ephemeral CI database is migrated by the runner on every CI run; (3) production was migrated once (`applied: 11, ledger: 11`) and immediately re-run (`noop: true, skipped: 11`) — the live system is reproducible from empty.

## 27. Known limitations

1. In-memory rate-limit buckets are per serverless instance (§12); global visibility arrives with Phase 3's DB-backed job engine. 2. The chat embed-token hook verifies presented keys but does not yet *require* them (legacy embeds predate keys; full site binding is Phase 11 per SEC-C3). 3. BU deletion is intentionally absent from Phase 1 UI/API (suspension is the provided control) — deletion semantics are a Phase 2+ data-governance decision alongside RLS (SEC-L1). 4. `legacy_bearer_auth` remains ON (Phase 1 transition posture per §12.4); the final cutover to sessions-only is a documented flag flip, not a code change. 5. The daily LLM cap counts dispatch/chat invocations, not tokens — token-accurate accounting is the Phase 4 Gateway's job. 6. OpenAI quota is still unfunded from the earlier phase, so LLM-touching paths were verified with stubs/429-cap paths; the acceptance run of the full demo seed still awaits credits (operational, not architectural).

## 28. Deviations from Phase 0.5 (each with rationale)

1. **Command Center home at `/dashboard`, not `/`** — `app/(dashboard)/page.tsx` at `/` would collide with the existing public landing page; relocating the landing page would churn the public URL for zero Phase 1 value ("preserve existing functionality"). The route group and all shell mechanics match the spec.
2. **`business_units.legacy_tenant_id` is `UNIQUE` + nullable, not `UNIQUE NOT NULL`** — `NOT NULL` would make it impossible to create any *new* business unit (the spec's own acceptance criterion 3 and the "arbitrary future businesses" invariant). Legacy mapping integrity is preserved by the UNIQUE constraint.
3. **shadcn/ui deferred** — its Radix dependency tree is a real dependency cost with no Phase 1 capability gain; Tailwind (the foundation half of the approved direction) shipped, and the CSS design tokens are named/shaped so shadcn can adopt them later without rework.
4. **`PATCH /api/admin/users` added** beyond the §12.4 `GET/POST` — the same section requires "invite/**disable**"; disabling (with immediate session destruction) and unlock need an update verb.
5. **`agents.run` permission added to the seed** — §12.6's permission list was "e.g." (non-exhaustive); guarding `agents/run` required a named permission rather than overloading `website.manage`.
6. **`agents.read`-style convenience was avoided; GET business-units readable by review-facing roles** — reviewers need the BU picker for the approvals queue; reads are scope-filtered, writes stay `bu.manage`.
7. **Migration 000 (legacy baseline)** added ahead of the specified 001–010 so the ledger is complete on databases provisioned from empty; the specified numbering is otherwise preserved exactly.
8. **Docs**: the owner's mid-phase upload replaced `AGENTOS-RUNBOOK.md` with a stale copy (removing the ops-endpoints section) and added a stray root `seed-demo.ts` that broke typecheck; the stray file was removed (content preserved in history and at `scripts/seed-demo.ts`) and the ops section restored, updated for Phase 1 (bootstrap flow). The uploaded `PHASE-0*.md` documents remain untouched at the repo root.

## 29. Unresolved issues

1. **Production owner account**: `POST /api/admin/bootstrap` is ready and audited, but the owner must choose their own password — run:
   `curl -X POST https://masteragent-nine.vercel.app/api/admin/bootstrap -H "Authorization: Bearer $OPS_TOKEN" -H "Content-Type: application/json" -d '{"email":"<your-email>","password":"<your-password ≥10 chars>"}'`
   then sign in at `/login`. 2. **OpenAI billing** still blocks the LLM-touching acceptance demo (draft generation); everything else is verified live. 3. **Staging activation** requires the owner's Neon-branch + Vercel-project actions per `docs/STAGING.md`. 4. **GitHub branch protection** recommended: require the CI check before merges. 5. **Credential rotation** (standing from earlier phases): `ADMIN_PASSWORD` and the pasted tokens remain due for rotation.

## 30. Recommended next phase

**Phase 2 — Agent Registry & versions**, exactly per the approved roadmap (§11 P2): agents become data (`agents`, `agent_versions`, `agent_tools`, `agent_permissions`, `business_unit_agents`, machine `agent_identities`), the five current agents map into the registry (research survives, marketing forks to content+marketing, sales specializes, ambassador folds to a prompt variant, customer_service splits at Phase 11), a generic LLM executor replaces the hardcoded dispatch binding, per-run attribution adds real `prompt_hash`/`prompt_version`, key-id envelope encryption lands for channel tokens (SEC-L2), and flags gain `DISABLE-AGENT` granularity. Phase 2 must **not** include: tools with side effects, the task/workflow engine, or supervisor autonomy (Phase 3+). RLS (SEC-L1) should land early in Phase 2, before multi-BU data accumulates.

---

**STOP — Phase 1 is complete. Phase 2 has not been started and awaits owner review and approval.**
