# Phase 12 Implementation Report — Sales + Customer Workforce

**Roadmap target:** PHASE-0.5 §P11 (roadmap §467–470, audit §909, §55, §139, §101, §65, §13).
**Status:** COMPLETE — CI green (49 suites), production migrated (ledger 46), live acceptance **44/44 PASS**.
**Commits:** `6973cbf` (feat, 25 files +3345), `21bf898` (leads extension fix), `49c3c9c` + `5321398` (test hardening), `b61cf96` (acceptance tenantId fix).

## 1. What shipped

MVP use case #3 — **inquiry → classified, scored lead with human escalation** — is live:

- **Conversation persistence**: every widget chat turn is stored (`conversations` + `messages`). The widget round-trips `conversationId`; visitors keep threads across reloads. Only visitor/assistant roles are ever persisted — the system prompt never touches the DB (§65: conversations never expose internal reasoning).
- **Inquiries**: structured records from the widget follow-up form (`POST /api/v1/inquiries`, public) or manual intake (admin API). FSM `new → classified → escalated → resolved | dismissed`, row-locked transitions.
- **§55 contract leads**: `lead_score` 0-100, `score_band` (cold/warm/hot), `next_action`, funnel stage FSM `new → qualified → engaged → proposal → won | lost`. Dedup = partial UNIQUE `(business_unit_id, lower(contact_email))` with a **score-ratchet upsert** (scores never regress; stages never demoted by automation; humans own stage moves).
- **Escalation law**: urgency=high OR hot band → inquiry FSM → `escalated` + `sales.escalated` event which **pages ops** (the §55 human loop). Drill-verified live.
- **Registry agents**: `customer_inquiry` (classification), `lead` (scoring), `customer_support` (support-answer twin) activated from the migration-012 placeholder rows — status flip + **max+1 versioned prompts** (M_038 pattern; no placeholder prompt leaks into the live workforce).
- **Widget = website-registered connector #1** (§13): a presented `x-agentos-site-key` resolves to exactly one active widget integration → website → BU; conversations/inquiries bind to the site that emitted them (§101 isolation). Key-only embeds are supported (tenant derived from key); legacy key-less embeds keep working. Invalid keys → 401, cross-BU/cross-website conversation continuation → 403 (audited).
- **Chat route = façade over task machinery**: the route is a thin adapter over `handleChatAnswer` (lib/sales/chat-pipeline.ts); the same function runs as the `chat_answer` task handler (async pathway for the supervisor era). Sync widget UX preserved.
- **/sales Command Center screen**: pipeline summary cards, inquiry queue (classify/escalate/resolve/dismiss), lead funnel (stage moves + score badges), conversation transcripts, manual inquiry/lead intake, widget site-registration card (masked keys).
- **Events**: `sales.inquiry_created` (silent), `sales.lead_scored` (silent), `sales.escalated` (**pages ops**).
- **widget.js**: conversation continuity, random `visitorId` (no fingerprinting, SEC-C3), `data-site-key` support, follow-up request form with honeypot.

## 2. Data model (migrations 043-045, additive; legacy 11/11 intact)

- **043 `sales_workforce`**: `conversations`, `messages`, `inquiries` (new tables) + **legacy `leads` EXTENDED, never recreated** (the roadmap's "leads extension + stage migration"): ADD COLUMN for the §55 contract fields, stage CHECK becomes a **superset** (legacy `contacted/responded/converted/dead` rows stay legal; the workforce FSM only writes §55 states), `tenant_id` NOT NULL relaxed. The writer back-fills the legacy NOT NULL columns (`contact` = email/phone/name, `channel` = source) and maps `name` → `contact_name` in the response shape (`toLead` strips legacy internals).
- **044 `sales_agents`**: placeholder trio activation (UPDATE + new version rows).
- **045 `sales_flag_permissions`**: `sales` flag + `sales.manage` permission (owner, administrator).

## 3. Degradation discipline (unfunded LLM proven live)

The LLM classification/scoring legs ride the gateway (`purpose="sales"`, budget-enforced, ledgered) behind the `sales` flag. The deterministic floor (keyword classification, signal-arithmetic scoring) labels EVERY inquiry honestly — `classified_by` records which leg ran (`llm` | `deterministic`), and responses carry `degraded=true` provenance. Schema-invalid LLM payloads are rejected at the structured-output layer (`completeJSON` enums); gateway failures (quota/budget/timeout) degrade per-leg and never block intake. Flag OFF → classify API returns **423 FLAG_DISABLED** (fail-closed for an operator-requested LLM leg), while public intake, chat, and persistence keep working.

## 4. Security envelope

- Public intake: per-IP rate limit (5/10min), per-tenant daily LLM cap, `stop_all_agents`, input caps, **honeypot discard** (silent, audited), site-key resolution, denied results audited (public-volume convention).
- §101 isolation: conversation verification (BU + website binding) — cross-BU → 403 `CONVERSATION_FORBIDDEN` (audited), unknown → 404; invalid site key → 401.
- §65: transcripts expose visitor/assistant only; assistant turns carry public citations.
- All admin mutations audited (`sales.inquiry.create/transition`, `sales.lead.create/transition/update`, `sales.classify`, `sales.conversation.close`); zero secrets in audit entries (live-verified).
- RBAC: `sales.manage` gates mutations; reads allow `audit.read`. Unauthenticated probes → 401 (fail-closed).

## 5. CI evidence

Ephemeral pgvector container, **49 suites** green on `5321398` (run-all now includes `sales-tests`). New suite: **78 checks** — FSM math + runtime, dedup/ratchet, §65 sanitization, classification/scoring floors + LLM legs (stub) + degradation, escalation law, chat isolation, site-key resolution. Updated suites: registry (Phase 12 trio + 19-row composition), migrations (flags seed 11→12), widget (12 source assertions incl. conversationId round-trip, random visitorId, honeypot, site-key, CSP-safe).

**CI iterations (each fixed forward):** ① `column contact_email does not exist` — M_043 originally `CREATE TABLE IF NOT EXISTS leads`, silently no-op against the Phase-1 legacy table → rewrote as the sanctioned additive extension. ② sales test expected downstream clamping of schema-invalid payloads — `completeJSON` rejects them first; test now asserts the rejection contract. ③ chat stub double-encoded plain text (`JSON.stringify` of a string) — added raw mode.

## 6. Live acceptance (44/44 PASS on production, `b61cf96` drill)

Owner-session driven: fail-closed 401s (3) → surface + flag + shape → legacy tenantId resolved from widget config (**491**, not 1) → **public intake classified at 200** (`classification=sales`, `classified_by=deterministic`, honest degraded provenance) → **auto-lead with §55 fields** → **high-urgency intake → escalated=true + FSM persisted** → honeypot discard (no record) → **chat persistence under LLM outage**: 500 CHAT_FAILED yet conversation + visitor turn persisted and sanitized (the widget core survives until the LLM lands; answers activate with it) → invalid site key 401 → ghost conversation 404 → lead dedup/ratchet/409-skip/human move → escalate→resolve→terminal 409 → **flag drill** (OFF: classify 423 + intake still 200; ON: classify runs degraded) → audit rows present, zero secrets → cleanup (drill artifacts terminal/closed) → screen sweep (sales/marketing/dashboard/operations/websites) + widget 200.

## 7. Rollback

`sales` flag OFF → LLM legs skip (423), intake/chat/persistence unaffected — verified live. Schema is additive; `disable_agent:lead` / `disable_agent:customer_inquiry` / `disable_agent:customer_support` kill-switches disable the agents per-BU platform-wide without deploys. No destructive migration was used; legacy 11/11 tables verified intact post-migration.

## 8. Owner actions pending

1. **Free Gemini API key** (https://aistudio.google.com/apikey — starts `AIza`): activates the LLM legs (classification, scoring, chat answers, RAG loop) with zero code changes via `LLM_PROVIDER=gemini` + `GEMINI_API_KEY`.
2. **Vercel token scope**: the stored API token now hits `403 forbidden — scope "koso-s-projects"` (projects moved to a team scope). Mint a fresh token at vercel.com/account/tokens to restore programmatic env management (needed to set the Gemini key); deploys via GitHub remain unaffected.
3. Resend domain verification (notifications, incl. escalation pages, materialize as suppressed rows until then).
