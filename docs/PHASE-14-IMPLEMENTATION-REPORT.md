# PHASE 14 — IMPLEMENTATION REPORT

**Phase:** 14 (execution numbering; roadmap **P13 — Website connectors** per PHASE-0.5-Final-Architecture-Reconciliation.md §11)
**Governance authority:** PHASE-0.5-Final-Architecture-Reconciliation.md §11 (P13), §12 (capability grants live), §77 (SEC-L4 webhook security), §120–§123 (one platform + configuration + connectors; Add-Website wizard; config-only acceptance), §144 (website independence), §394/§406/§411 (capability catalog, fetch reuse, connector #1)
**Baseline:** `881bba8` (Phase 13 + Phase 1 conformance addendum), CI green, local full-suite green (55 suites / 1521 checks on ephemeral Postgres 17 + pgvector 0.8.0)
**Date:** 2026-10-12

---

## 1. Executive summary

Roadmap P13 ("Website connectors — connect the seed sites, then Add-Website wizard") was partially landed early in implementation Phase 6 (WebsiteConnector contract, HMAC crypto with rotation, delivery replay cache, capability grant store, webhook event router, connectors admin API + screen). Phase 6 report §17 deferred exactly two items to P13: the **Add-Website wizard** and the **chat.answer / widget re-keying**. Phase 14 closes the remaining P13 scope:

1. **Widget connector type** — `integration_type='widget'` is now creatable/rotatable through the connectors service, admin API, and UI (generated `wgt_<48hex>` site key, reveal-once). This is the "connect the seed sites" piece that was missing: widget integrations existed in production only as hand-inserted rows.
2. **`chat.answer` becomes a live, enforced capability (§12/§13/§411)** — promoted from the reserved list into the grantable catalog; the public chat and inquiry routes REQUIRE it (and `CREATE_LEAD` for intake) whenever a site key is presented. Migration **049** seeds both grants for every active widget integration so existing embeds keep working unchanged. Keyless legacy embeds remain accepted (documented transition contract).
3. **Add-Website wizard (§121–§123)** — `lib/connectors/onboard.ts` + `POST /api/admin/websites/onboard` + a 7-step wizard UI on `/websites`: information → agents → integrations → knowledge → permissions → autonomy → activate, executed as **pure configuration** in one guarded call, with per-step manifest, validate-before-write, idempotent resume, per-step audit events, and reveal-once credentials.
4. **Channels endpoint permanently retired (P13 roadmap sentence)** — `POST /api/v1/channels` now answers audited, rate-limited **410 ENDPOINT_RETIRED**; the legacy publisher read path keeps working for pre-existing rows.
5. **Acceptance evidence** — new `tests/onboarding-tests.ts` (42 checks): config-only onboarding, reveal-once on resume, live capability enforcement (403s), §144 isolation via the real signed-events route, retirement contract.

## 2. Data model (migration 049)

**049_connector_capability_seed** (additive; no schema change):
- Seeds `chat.answer` + `CREATE_LEAD` capability grants (enabled) for every **active** `integration_type='widget'` row, `ON CONFLICT DO NOTHING`. Production effect: the existing hand-registered widget integration is auto-granted; zero embed behavior change. Ledger after apply: **50 versions** (verified locally; production apply pending the usual `POST /api/admin/migrate`).

No other migrations. The wizard writes only configuration rows (business_units, tenants 1:1 identity, websites + metadata, website_integrations, website_capabilities, knowledge_sources).

## 3. The onboarding orchestrator (`lib/connectors/onboard.ts`)

- **Validate first**: the entire payload (BU reference, website fields, agent slugs against the active registry, connector types, knowledge kinds/refs, capability names, autonomy value) is checked before the first write — a rejected onboarding touches nothing (M0 fail-closed bias).
- **Resumable**: every step is find-or-create keyed on natural identity (BU slug, website slug, connector type, knowledge `(website, kind, ref)`, capability upsert). A re-submitted payload reports `existing` per step instead of duplicating or failing.
- **Reveal-once**: webhook signing secret / widget site key are returned ONLY on the call that created the connector; resumed runs reveal nothing (admin rotates instead). Credentials never enter audit metadata (verified by test).
- **§11 configuration fields** (business type, jurisdiction, market, language, audience, brand) + agent selection + autonomy are recorded on `websites.metadata.onboarding` — configuration P14/P15 can consume; no behavior is invented.
- **Tenant identity provisioning**: a newly created BU receives a 1:1 `tenants` row (inverse of the migration-007 backfill) so tenant-keyed surfaces — the daily LLM cap (`tenant_usage_daily` FK), `getTenantConfig`, widget-by-tenant, RAG legacy fallback — work for pure-config BUs without touching any consumer.
- **Permission model**: `website.manage` required; creating a NEW business unit additionally requires `bu.manage` (enforced in the route — a website.manage-only role is rejected with 403, tested).
- **Failure containment (§144)**: a failed knowledge step reports `failed` per-step and does not poison connectors/grants.

## 4. Surfaces

- `POST /api/admin/websites/onboard` — the wizard endpoint (audited per step + `onboard.complete` with the step manifest).
- `POST /api/admin/connectors` / `POST /api/admin/connectors/[id]` (rotate) — now type-aware (`webhook` → signingSecret, `widget` → siteKey, both reveal-once).
- `/websites` — OnboardWizard client component (7 §121 steps, manifest + copyable reveal-once credentials).
- `/connectors` — type dropdown (webhook/widget), credential-kind-aware reveal panel, `chat.answer` in the grants toggle list.
- `POST /api/v1/chat` + `POST /api/v1/inquiries` — capability enforcement inserted between site-key resolution and processing (403 `CAPABILITY_NOT_GRANTED`, audited with `reason=capability_not_granted`).
- `POST /api/v1/channels` — 410 ENDPOINT_RETIRED with replacement pointers; body never parsed; attempts audited.

## 5. Verification (all real, all local unless noted)

- **New suite** `tests/onboarding-tests.ts` — **42/42 PASS**: validation-first (zero rows written on rejection), unauth 401, website.manage-only BU escalation 403, §121 happy path (201; every step; metadata; grants; knowledge; audit), tenant identity provisioning, encrypted webhook secret at rest, `wgt_` site key format, `resolveSiteKey` cross-module resolution, resume idempotency + no secret re-reveal, chat 403/`pass-through` and inquiry 403/200 around `chat.answer`/`CREATE_LEAD`, §144 isolation through the real signed-events route (A malformed → 400 failed delivery; B valid → 202 sync; per-connector 24h stats prove isolation), channels 410 + audit + garbage-body robustness, site-key-never-audited.
- **Existing suites updated where the contract intentionally changed** (each documented above): `security-tests.ts` (channels → retirement contract), `publishers-tests.ts` (credential rows now originate pre-retirement; sweep read path proven unaffected), `connectors-service-tests.ts` (`chat.answer` grantable; unknown capability still rejected), `connectors-route-tests.ts` (typing only).
- **Full run at final state: ALL 55 SUITES PASS — 1559 checks** (pristine ephemeral DB, ledger 50).
- **`tsc --noEmit --incremental false`** — clean. **`npm run build`** — clean (75/75 pages, all new routes in output).
- CI on `main` was green at the baseline commit (`881bba8`); the Phase 14 commit re-triggers CI (remote gate — see §7).

## 6. Rollback

- Migration 049 is a grant seed — rollback = `UPDATE website_capabilities SET enabled=false WHERE capability IN ('chat.answer','CREATE_LEAD')` (disables enforcement for key-bearing embeds; keyless embeds unaffected) or the ledger-wide restore procedure in AGENTOS-RUNBOOK.
- Capability enforcement is two `if (!ok) 403` blocks in the chat/inquiry routes — revert is a two-line change per route.
- The wizard endpoint is additive; disabling it = remove the route file (nothing else depends on it). The connectors admin API degrades to the Phase 6 shape if `type` is ignored.

## 7. Known limitations & outstanding

- **CI/deploy for THIS commit are remote gates**: the push succeeds with the owner-provided token (used via a non-persisted credential helper); CI run and Vercel deploy must be watched/verified after push. No production migration has been applied for 049 yet (apply via `POST /api/admin/migrate` with OPS_TOKEN, as for 046–048).
- **Site keys at rest** are plaintext by equality lookup (`config->>'siteKey'`) — pre-existing model, kept deliberately (revocable, rate-limited public surface). Hardening option (hash-at-rest) recorded as a recommendation, not bundled into P13.
- **Autonomy levels** (§45) and per-website agent execution binding arrive at P14 (Supervisor) / P15 (controlled autonomy); the wizard records selections as configuration only.
- The `channels` table remains readable by legacy publishers (documented); its last write path is gone.
- Rate limiter remains per-instance (documented §27.1 of the Phase 1 report).

## 8. Deviations from Phase 0.5

None beyond those already ratified in Phase 6 report §28 (connector subsystem pulled forward). The tenant-identity provisioning inside onboarding implements the existing 1:1 mapping law in the reverse direction; it introduces no new architecture.

## 9. Status

**STOP — Phase 14 (roadmap P13) is code complete, locally verified (55 suites / 1559 checks, tsc, build), and submitted for owner review. Production steps pending: apply migration 049 via the admin migrate endpoint, verify CI green on the push, confirm Vercel deploy. Phase 15 (roadmap P14 — Supervisor) has NOT been started.**
