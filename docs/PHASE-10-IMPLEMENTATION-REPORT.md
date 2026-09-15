# Phase 10 Implementation Report — Social Workforce

**Commit:** `9321d75` (feature) · acceptance script `bddbe23`+ · production verified live
**Roadmap:** PHASE-0.5-Final-Architecture-Reconciliation.md §11 P9, §38, §197, §219, §466; SEC-L5
**Predecessor:** Phase 9 (SEO workforce, `1238fc4`) · **CI:** 46 suites green · **Production:** READY, migration ledger 40 versions, legacy 11/11 tables intact

---

## 1. What shipped

The social workforce — the system's publishing arm. One approved content item becomes
per-platform scheduled posts, on a real calendar, published by a durable sweep with the
same zero-duplicate publication contract as the legacy drafts pipeline. Nothing publishes
without approval: the gate is structural (FK to content_items + lifecycle check at
creation AND at publish time), not a UI convention.

Per roadmap §466, delivered in full:

| §466 deliverable | Status |
|---|---|
| social_accounts (absorb channels + LinkedIn account-ref fix) | ✅ migration 037 + §197 backfill + account_ref REQUIRED for linkedin |
| social_posts linked to content items | ✅ content_item_id NOT NULL + APPROVED/SCHEDULED gate |
| campaigns | ✅ social_campaigns (BU-scoped, UNIQUE name, status) |
| platform variants | ✅ per-platform rows; social_media agent LLM leg + deterministic fallback |
| scheduling calendar (time semantics, not cron pile) | ✅ scheduled_at TIMESTAMPTZ + UTC-day calendar API/screen |
| OAuth linking (SEC-L5) | ✅ signed-state authorize URL, code exchange, refresh, expiry/health lifecycle |
| metrics ingestion | ✅ social_post_metrics + provider pull in sweep + manual endpoint |
| IG/TikTok real adapters | ✅ real API flows implemented, policy-gated draft-only (§38 invariant) |

**Acceptance criterion (§466):** *"one approved item → per-platform scheduled posts;
nothing publishes without approval unless policy later says so"* — **proven live on
production** (see §8): DRAFT item → `409 CONTENT_NOT_APPROVED`; APPROVED item → scheduled
post → sweep drove it through the adapter boundary to a terminal state with the
publication ledger row and full attribution.

## 2. Migrations (037–039, additive-first, idempotent)

- **037 `social_workforce`** — `social_campaigns`, `social_accounts` (dedup identity =
  expression UNIQUE `(business_unit_id, platform, COALESCE(account_ref,''))` — plain
  UNIQUE would allow unbounded NULL-ref duplicates), `social_posts` (FSM CHECK,
  partial UNIQUE one-active-post per `(content_item, platform) WHERE status <>
  'cancelled'`, partial index on due posts), `social_post_metrics`,
  `content_publications.social_post_id` + `draft_id` nullable (additive; the §88
  idempotency contract untouched), `scheduled_social_sweep` workflow seed.
  Includes the §197 channels absorption backfill: social-kind channels copied with BU
  resolved via `business_units.legacy_tenant_id`; re-run safe (bare ON CONFLICT).
- **038 `social_agent`** — `social_media` registry activation + versioned v1 prompt
  (platform character budgets, no-fabrication rule, JSON output, honest-refusal escape).
- **039 `social_flag_permissions`** — `social` flag (platform kill switch) +
  `social.manage` permission (owner, administrator).

Legacy `channels` is **not** dropped or renamed (additive-first, §5). The legacy drafts
sweep keeps reading it; the social workforce writes `social_accounts` only.

## 3. Architecture decisions (tech lead)

1. **Structural approval gate.** A social post cannot exist without an approved content
   item — enforced in the DB (FK) and the service (creation + publish-time checks).
   Posts whose item is ARCHIVED are auto-cancelled by the sweep: withdrawal after
   approval must reach the calendar.
2. **Same publication ledger, second consumer.** The social sweep claims publications
   in `content_publications` (key `social:<post>:<scheduled-at>`) BEFORE the external
   call — two concurrent sweeps produce exactly one publish per scheduled attempt
   (§88, now proven for both the legacy and social legs).
3. **Publishing precision bound by cron cadence — mitigated.** Vercel cron fires daily
   ( Hobby plan constraint), so the social sweep is additionally triggered with a
   5-minute bucket idempotency key (raising the cron cadence later improves precision
   with zero code change), and the /social surface spawns the sweep on demand
   (durable task). Time semantics live in `scheduled_at`, never in cron expressions.
4. **IG/TikTok draft-only is policy, not absence.** Real adapter flows exist (IG
   two-step container→publish; TikTok content-init); the `social_publish_ig_tiktok`
   flag (default OFF) gates them, checked BEFORE the idempotency claim so a skipped
   platform consumes nothing.
5. **Auth-shaped failures poison the credential, not the machinery.** Adapter errors
   normalized to `http_<status>`; 401/403 mark the account unhealthy + oauth error
   (next sweep skips it, dashboard shows reconnection needed); 5xx leave the account
   healthy (transient). The detection regex matches `http_40x` — a `\b401\b` pattern
   never matches `http_401` (underscore is a word char) — caught by test.
6. **OAuth degrades cleanly.** Without platform app credentials (today's state),
   `buildAuthorizeUrl` returns `CONFIG_MISSING 409` and the surface shows
   manual-connect; signed state (HMAC-SHA256, 10-min TTL, constant-time verify) and
   PKCE are ready when credentials arrive. Manual tokens are first-class
   (source=manual, same SEC-L2 encryption envelope).

## 4. Code surface

- `lib/social/` — `types.ts` (platforms, FSM `SOCIAL_POST_FLOW`, budgets), `service.ts`
  (single writer: accounts/campaigns/posts/calendar/metrics/FSM/due-selection),
  `oauth.ts` (SEC-L5), `adapters.ts` (linkedin/x/instagram/tiktok + metrics),
  `pipeline.ts` (variant LLM leg + deterministic fallback, purpose="social"),
  `tasks.ts` (`social_sweep` handler, adapter seam for tests).
- API: `/api/admin/social` (GET surface), `/accounts`(+`[id]`), `/campaigns`(+`[id]`),
  `/posts`(+`[id]`), `/metrics`, `/sweep`, `/oauth/[platform]` — guarded
  (social.manage / audit.read), audited, secrets never in responses or audit.
- Dashboard: `/social` screen (accounts + connect form, campaigns, 14-day calendar,
  post queue with FSM badges + errors, metrics cards, on-demand sweep, flag banner).
- Engine: `social_sweep` registered in `registerBuiltins`; `/api/agents/sweep` triggers
  Workflow #2; `TaskCancelledError` moved to `lib/tasks/types.ts` (instanceof contract
  without import cycles); new events `social.posted` / `social.failed` (pages ops) /
  `social.sweep` (silent).

## 5. Tests — 46 suites, all green (CI `9321d75`)

- **social-service (47 checks):** approval gate, BU isolation, past-schedule rejection,
  healthy-account pre-check, per-platform budgets (x ≤ 280), one-active-post dedup,
  row-locked FSM incl. terminal states and reschedule path, calendar grouping + BU
  isolation, metrics ingest/summary, account semantics (linkedin account_ref REQUIRED,
  encryption at rest + round-trip, reconnect upsert, NULL-ref dedup), workforce sync
  (all posted → item PUBLISHED), archived-item auto-cancel.
- **social-sweep (21):** flag-off fail-closed skip, idempotency claim (pre-claimed key →
  adapter never called), happy path (posted + publication + event + item sync), adapter
  failure (failed + failed publication + event; 5xx does NOT poison the account), 401
  poisons the account, IG draft-only skipped BEFORE the claim (no publication consumed),
  provider metrics refresh (changed ingested, identical skipped), account_ref reaches
  the linkedin adapter.
- **social-oauth (27):** state round-trip/tamper/expiry/key-isolation, authorize URL
  (CONFIG_MISSING, PKCE for x/tiktok), exchange/refresh over injected fetch (coded
  errors, body contracts), all four adapters (real request shapes, draft-only gates,
  IG two-step, best-effort metrics).
- Regression: registry suite updated (7 placeholders remain disabled); migrations suite
  flag count 10.

## 6. Live acceptance — production, 40/40 PASS

Run: `scripts/phase10-live-acceptance.ts` (owner session). Highlights:
fail-closed 401s; surface + flags; **structural gate live** (DRAFT item → 409
CONTENT_NOT_APPROVED); IDEA→…→APPROVED via the content FSM; x account connected
(response/audit never echo the token); approved item scheduled — **LLM variant leg
degraded deterministically (OpenAI still unfunded), 159-char platform-native body**;
item auto-synced to SCHEDULED; **sweep drove the post through the adapter boundary**:
real call to the X API → `http_403: Forbidden` (test token — expected), publication row
`social:3:<ts>` failed with the provider error, post → failed, **account poisoned
(unhealthy + oauth error)**, `social.failed` event emitted; metrics ingest + summary;
campaign duplicate → 409; OAuth CONFIG_MISSING → 409; flag drill OFF→skip/ON; audit
rows present (8 distinct social.* actions) with zero secret leakage; screens + widget
regressions 200.

Interpretation: every layer up to the provider boundary is proven **on production**.
The last hop (a real `posted` state) requires a real platform credential — the same
class of owner action as the OpenAI top-up.

## 7. Security review

Unauthenticated mutations fail closed (401 verified live); RBAC social.manage
(owner/admin) on every mutation; audit records all 8 social.* action types without
secrets; credentials only in the SEC-L2 key-id envelope; provider errors truncated +
coded (no URL/token echo); OAuth state MAC'd, TTL'd, constant-time compared; flag is
the kill switch (sweep skips fail-closed, verified).

## 8. Owner actions & what's next

**To unlock real posting:** connect one real credential per platform (manual connect on
/social, or add `<PLATFORM>_CLIENT_ID/SECRET` for the OAuth path) — then reschedule any
failed post. **Still blocked elsewhere:** OpenAI credits (variant generation degrades
deterministically until funded; LLM-quality variants return instantly when it is).
Resend domain verification remains open for notification delivery.

**Next per roadmap:** P10 marketing workforce (§467) — marketing agent as BU-persona
prompt variant, campaign orchestration across content+social, attribution to leads.
