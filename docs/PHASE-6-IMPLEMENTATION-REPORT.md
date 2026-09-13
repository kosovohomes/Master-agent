# Phase 6 — Website Connectors: Implementation Report

**Phase:** 6 (execution numbering; roadmap P13 pulled forward per Phase 5 report §18)
**Governance authority:** PHASE-0.5-Final-Architecture-Reconciliation.md §11 P13, §12 (capability grants), §77 (SEC-L4 signed webhooks), §121–§123 (onboarding acceptance), §144 (site failure isolation), §394, §406, §411
**Commit:** a6dc303 (feat) — docs commit follows live acceptance
**Owner standing order:** "proceed to next phase" / "proceed to Phase 6"

---

## 1. Executive summary

Phase 6 delivers the **website connector strategy**: the first inbound integration surface of the platform. External sites can now authenticate to AgentOS with HMAC-signed webhooks, and the platform acts on their events strictly inside capability grants enforced server-side. The headline capability — **site content sync** — reuses the Phase 5 knowledge machinery end to end: a signed `content.sync` event from a website ensures a website-scoped knowledge source and spawns a durable `knowledge_fetch` task; the existing fetch → ingest → status machine does the rest.

Everything is additive (migrations 027–028, no renames, no drops), fully flag-rolled (`connectors` flag → the webhook endpoint 404s when off, zero deploys), and every security property required by SEC-L4 is enforced in code and proven by test: constant-time signature comparison, timestamp tolerance, DB-backed replay cache, zero-downtime secret rotation, and secrets that exist in plaintext exactly once (the admin response) and in ciphertext at rest — never in logs, never in audit.

The full test matrix grew to **37 suites** (+4: crypto, service, events, route) and the Command Center gained a **Connectors** screen for lifecycle, capability grants, and the delivery receipt log.

## 2. Scope decisions (tech lead)

- **Pulled forward from roadmap P13** (recorded in the Phase 5 report §18 before this phase began): connectors land NOW because (a) Phase 5's fetch/ingest machinery gives them an immediately useful payload (content sync) with zero LLM credits required, and (b) every later workforce phase (P7 content, P9 social, P11 sales/widget re-keying) assumes the contract this phase establishes.
- **Roadmap P6 "Research workforce" is NOT this phase** despite sharing the roadmap number: it requires a funded OpenAI key for live verification (standing owner blocker) and depends on the connector content pipeline this phase delivers. It remains the next phase in execution order (as "Phase 7" in the owner's numbering).
- **Outbound connector operations** (platform → site: READ_LEADS, SEND_NOTIFICATION, PUBLISH_CONTENT...) are **designed but not executed** — the capability catalog and the §394 dual-gate check exist and are enforced for inbound events; wiring them to agent dispatch lands with the phases that actually emit those operations.

## 3. Architecture: the connector contract

A connector is a `website_integrations` row (`integration_type='webhook'`, one per website — UNIQUE constraint from migration 008) with:

| Element | Where it lives | Notes |
|---|---|---|
| Signing secret | `credentials_encrypted` (AES-256-GCM v2 envelope, `lib/channels.ts`) | generated 32-byte base64url; returned to the admin exactly once |
| Previous secret | `previous_credentials_encrypted` + `rotated_at` | valid inside the 24h rotation window only |
| Signing algorithm | `signing_algo` (default `hmac-sha256`) | forward-compatible marker |
| Liveness | `last_event_at` | refreshed on every authenticated delivery |
| Status | `status` active/disabled/error | disabled ⇒ endpoint 404s |
| Capabilities | `website_capabilities` (per WEBSITE, migration 008) | §394 grants, enforced at the webhook |

Capability catalog (§394, `lib/connectors/types.ts`): `READ_CONTENT, CREATE_CONTENT, UPDATE_CONTENT, PUBLISH_CONTENT, READ_LEADS, CREATE_LEAD, READ_ANALYTICS, SEND_NOTIFICATION, READ_PRODUCTS` — plus `chat.answer` **reserved** (§411: the widget re-keying lands in P11/13 and is deliberately not grantable through the Phase 6 admin surface).

## 4. Data model (migrations 027–028, strictly additive)

**027 `website_connectors`**
- `ALTER TABLE website_integrations ADD COLUMN IF NOT EXISTS` — signing_algo, previous_credentials_encrypted, rotated_at, last_event_at, display_name.
- `CREATE TABLE connector_deliveries` — the signed-webhook receipt log **and** replay cache:
  - `UNIQUE (website_id, delivery_id)` — the replay guarantee is a database constraint, not application logic;
  - `status ∈ received | accepted | rejected | failed`, `signature_valid`, `rejection_reason`, `payload`, `task_id` (link to the spawned knowledge_fetch);
  - indexes on `(website_id, created_at DESC)` and `integration_id`;
  - FK to websites CASCADE, integration_id SET NULL on connector deletion (receipts outlive connectors).

**028 `connectors_flag_permissions`** — feature flag `connectors` (ON, rollback = single flip) + permission `connectors.manage` (owner + administrator), the exact seed pattern of migrations 022/026.

Verified on a throwaway Neon database: apply-to-empty reaches ledger 29; re-run is a no-op; production keeps the 11 legacy tables untouched.

## 5. Cryptography (`lib/connectors/crypto.ts`)

Wire format (Stripe-style, verified against the RAW request body):

```
X-AgentOS-Signature: t=<unix_seconds>,v1=<hex>
X-AgentOS-Delivery:  <opaque sender-chosen id>
signed payload = HMAC_SHA256(secret, `${t}.${rawBody}`)
```

- **Constant-time comparison** via `crypto.timingSafeEqual` on fixed-length hex buffers; no secret ever touches a string comparison.
- **Timestamp tolerance**: ±300s (`SIGNATURE_MAX_AGE_SEC`) — bounds the replay horizon on top of the DB cache; `parseSignatureHeader` rejects malformed/non-hex/non-numeric headers outright.
- **Rotation window**: the previous secret verifies only while `now - rotated_at ≤ 24h` (`ROTATION_WINDOW_HOURS`); verification tries current first, previous second, order-independent.

## 6. Secret lifecycle

- **Create**: `generateSigningSecret()` → encrypted → stored → returned **once** in the POST /api/admin/connectors response with an explicit "shown only once" warning. The UI renders it in a reveal-once panel with copy-to-clipboard and a confirm button.
- **Rotate** (`POST /api/admin/connectors/[id]`): current → previous (encrypted), new secret generated, `rotated_at = now()`. Zero downtime: senders cut over at their leisure inside the window; a leaked previous secret ages out automatically after 24h.
- **Never**: logged, audited (`connector.create` / `connector.rotate` audit rows deliberately omit the secret), present in subsequent GET responses, or exposed by the route handler error paths.

## 7. Replay semantics (`connector_deliveries`)

`recordDelivery` implements two distinct conflict modes:

| Path | Conflict behavior | Rationale |
|---|---|---|
| **Rejection recording** (invalid signature / bad JSON / missing type / capability denied) | `ON CONFLICT DO NOTHING` | rejected attempts must never overwrite a row a validly signed delivery claimed, and their ids need not be unique |
| **Acceptance recording** (post-verification) | `ON CONFLICT DO UPDATE … WHERE status IN ('failed','rejected')` | sender retries with the SAME delivery id must be **processed, not lost** (a previously failed delivery is retryable); a conflict with a `received`/`accepted` row returns `recorded=false` → **409 DELIVERY_REPLAY** |

Result: replay protection is exact (DB-enforced), while delivery liveness survives both processing failures and attacker-poisoned delivery ids (a valid signature can always re-claim an id).

## 8. Capability grants enforcement (§394)

`EVENT_CAPABILITIES` maps inbound event types to their required grant:

| Event | Capability | Phase 6 behavior |
|---|---|---|
| `content.sync` / `content.updated` / `sitemap.updated` | `READ_CONTENT` | **executed** — sync machinery below |
| `lead.created` | `CREATE_LEAD` | accepted + recorded (pipeline = P11) |
| `analytics.ping` | `READ_ANALYTICS` | accepted + recorded (pipeline = P12) |
| `heartbeat` | — | liveness stamp only |
| anything else | — | accepted + recorded (forward compatible, §411: a site evolving never requires a platform redeploy) |

Enforcement is deterministic and server-side: `websiteHasCapability(websiteId, capability)` reads the grant; ungranted ⇒ **403 CAPABILITY_NOT_GRANTED** with the missing capability named, delivery recorded as rejected. The §394 dual gate ("website granted AND caller authorized") is satisfied for inbound events by (grant) + (valid HMAC); the agent-permission leg activates when outbound operations arrive in the workforce phases — the seam (`types.ts` catalog + grant helpers) is already in place.

## 9. Event routing & site content sync (`lib/connectors/events.ts`)

`handleConnectorEvent` runs only after signature, timestamp, capability, and replay checks pass:

1. Refreshes `last_event_at` (liveness).
2. **Sync events** (`content.sync` family): extracts fetchable targets — `data.sitemapUrl` → sitemap source, `data.url` → url source, `data.urls` → capped at 5 per event, non-`http(s)` refs rejected (`SYNC_TARGET_REQUIRED`) — then per target:
   - **ensure** a `knowledge_sources` row scoped to the sending website (`website_id` + `business_unit_id` stamped, `access_level='public'` — site-published content, P5 backfill parity; `refresh_frequency='manual'` — the site drives refresh, not the cron);
   - **spawn** a durable `knowledge_fetch` task with idempotency key `knowledge_fetch:<sourceId>:connector:<deliveryId>` — per-delivery idempotent, so webhook retries never double-spawn, and the Phase 3 queue's retry/backoff owns transience;
   - **emit** `connector.content.sync` on the event bus (Operations screen observable; deliberately non-paging — failures surface via `task.failed`/`knowledge.source.failed` which DO notify).
3. Repeat events reuse the same source (no registry duplication) while each new delivery id gets a fresh fetch task.
4. **Isolation property**: the same URL synced by two different websites creates TWO sources, each correctly scoped — scope-safe dedup semantics inherited from Phase 5 (§9.1).

The actual fetch → ingest → chunk → retrieve work is **entirely Phase 5 machinery** (`runSourceFetch` + `knowledge_fetch` handler) — zero duplication, exactly the "P5 machinery reused" contract from the Phase 5 report.

## 10. The webhook endpoint (`POST /api/integrations/:siteId/events`)

Verification order — fail closed, generic errors, no probing oracle:

| Step | Check | Failure |
|---|---|---|
| 1 | `connectors` flag | 404 (endpoint "does not exist") |
| 2 | numeric siteId → website exists + active → active webhook connector | 404 |
| 3 | rate limit `connector:<siteId>` 60/min (DB-backed, global) | 429 + Retry-After |
| 4 | `X-AgentOS-Delivery` present, ≤200 chars | 400 |
| 5 | HMAC signature + timestamp (rotation-aware) | 401 (malformed/invalid) / 400 (stale) — delivery recorded rejected |
| 6 | JSON parses; `type` non-empty | 400 — recorded |
| 7 | capability granted (§394) | 403 — recorded |
| 8 | replay cache | 409 DELIVERY_REPLAY |
| 9 | event router | **202** `{received, action, taskId, sourceIds}` / 500 on processing error (delivery stays retryable) |

Every attempt — successful or not — lands in `connector_deliveries` with its verdict. The receipt log is simultaneously the operator's debug surface (screen below) and the security audit of the endpoint.

**Failure containment (§144):** processing errors are scoped to a single delivery row of a single website (status `failed`, reason recorded, id retryable). There is no shared mutable state between sites anywhere on the path — one site failing cannot affect another by construction.

## 11. Admin API surface (all session-guarded, RBAC-enforced, audited)

| Route | Permission | Behavior |
|---|---|---|
| `GET /api/admin/connectors` | connectors.manage / audit.read | all connectors + grants + 24h delivery stats + flag + catalog |
| `POST /api/admin/connectors` | connectors.manage | create → **secret shown once**; audits `connector.create` (no secret) |
| `PATCH /api/admin/connectors/[id]` | connectors.manage | enable/disable; audits `connector.update` |
| `POST /api/admin/connectors/[id]` | connectors.manage | **rotate** → new secret shown once; audits `connector.rotate` |
| `DELETE /api/admin/connectors/[id]` | connectors.manage | delete (receipts keep NULL lineage); audits `connector.delete` |
| `GET /api/admin/connectors/[id]/capabilities` | manage / audit.read | grant rows for the website + catalog |
| `PUT /api/admin/connectors/[id]/capabilities` | connectors.manage | `{capability, enabled}` grant/revoke; audits `connector.capability` |
| `GET /api/admin/connectors/[id]/deliveries` | manage / audit.read | receipt log, `?limit` ≤ 200 |

## 12. Command Center screen (`/connectors`)

- Connectors table: website, type, status, capability badges, last event, 24h delivery count (failed highlighted), actions (Inspect / Rotate / Enable-Disable / Delete).
- Create form (website select + display name) → reveal-once secret panel with the exact wire-format instructions (endpoint, headers, signature computation).
- Capability grant toggles (the 9 canonical grants) for the inspected connector's website.
- Delivery log table for the inspected connector: when / event / delivery id / signature verdict / status / rejection reason / spawned task.
- Nav link gated on `connectors.manage || audit.read` — follows the established shell pattern.

## 13. Security review (SEC-L4 closure)

| §77 requirement | Implementation | Proof |
|---|---|---|
| Signature | HMAC-SHA256 over `t.rawBody`, raw-body verified | crypto suite roundtrip + route 401/400 matrix |
| Timestamp | ±300s window, both directions rejected | crypto suite edge tests (±301s rejected, ±299s accepted) |
| Replay | UNIQUE (website_id, delivery_id) + acceptance-path conflict → 409; failed/rejected rows re-recordable | service + route suites (replay 409; retry reprocessed) |
| Rotation | current→previous within 24h window, automatic expiry | crypto suite window tests + service rotate tests |
| Secret hygiene | encrypted at rest (AES-256-GCM v2), reveal-once, never in audit/logs/responses | service suite (ciphertext decrypts; row JSON contains no secret) |
| No probing oracle | every pre-auth failure is generic 404/400/401 | route suite |
| Brute force | 60/min/website global DB limiter | reuses proven Phase 2 limiter |
| Capability gate | §394 map + DB check before any side effect | route suite (403 before task spawn) |
| Isolation | everything keyed by website_id from step 2 | service + events + route isolation tests |

## 14. Test evidence

**37 suites total (+4).** New suites and their coverage:

- `connectors-crypto` — 24 checks: secret generation, signature determinism, header parsing edge cases, tamper/stale/wrong-secret rejection, rotation window (inside/outside/missing-rotated-at/order-independence).
- `connectors-service` — lifecycle (create → CONNECTOR_EXISTS, unknown website), secret-at-rest, scoping isolation, rotation, grants (toggle, invalid capability, isolation), delivery semantics (first-record, replay-suppress, failed-reprocessable, attacker-poison re-claim), delivery listing + cross-website id collision independence.
- `connectors-events` — sync ensure+spawn, scope stamps (website + BU + public + manual), per-delivery idempotency (retry deduplicated), source reuse on repeat events, 5-URL cap, SYNC_TARGET_REQUIRED, heartbeat liveness, record-only events, event-bus emission (retry re-emits), site-B isolation on identical refs.
- `connectors-route` — the full fail-closed matrix (flag/404 ×4, delivery-id 400, signature 401 ×4, stale 400, JSON 400, type 400, capability 403) plus the happy path (202 + scoped source + durable task + accepted receipt) and 409 replay.

Updated suites: `migrations-tests` (table list 11→12 with `connector_deliveries`; flags seed 5→6), `run-all` registration.

Local verification ran against a dedicated **`agentos_staging`** Neon database (STAGING.md Option B — second database in the project, never production): full run green after two test-assertion fixes (delivery row-count math; heartbeat liveness precondition) — no product-code defects found by the loop. CI re-proves everything on the ephemeral pgvector container.

## 15. Live acceptance (production) — VERIFIED

Executed against `https://masteragent-nine.vercel.app` at sha a6dc303 (`scripts/phase6-live-acceptance.ts`, owner session):

- **Migrations**: `POST /api/admin/migrate` → applied `027 website_connectors`, `028 connectors_flag_permissions`; 27 skipped (idempotent); **ledger 29**; legacy tables 11/11 intact.
- **Connector lifecycle**: connector #1 created on website #1 (Acme Homes primary site) via `/api/admin/connectors` — signing secret returned exactly once (never printed, never logged); `READ_CONTENT` granted via the capabilities endpoint.
- **Signed deliveries**: `heartbeat` → 202 `action=heartbeat`; signed `content.sync` → **202 with taskId 9 + sourceIds [3]** — knowledge source #3 created website-scoped, durable `knowledge_fetch` #9 spawned (the Phase 5 machinery handoff, live).
- **Fail-closed matrix, live**: tampered delivery → **401**; replayed delivery id → **409 DELIVERY_REPLAY**; receipt log shows the accepted row with signature verdict + task link.
- **Flag rollback drill**: `connectors` OFF → endpoint **404** (zero deploys); ON → endpoint restored (202). Single flag flip both ways.
- **Audit hygiene**: `connector.create` recorded; the signing secret appears nowhere in the audit payload (verified against the live audit API).
- **Regressions**: `/`, `/login`, `/dashboard`, `/connectors`, `/knowledge`, `/gateway`, `/operations` all 200 with an owner session.

The acceptance connector stays live on website #1 as the first production integration; the spawned fetch task's outcome is observable in Operations (its synthetic sitemap ref fails fetch — attributed, retrying, and non-scheduled, exactly the §144 containment behavior).

## 16. Rollback map

- `connectors` flag OFF → webhook endpoint 404s + admin surface reports flag-off; zero code change, ≤1-run propagation.
- Per-connector `status='disabled'` → that site's deliveries stop without touching others.
- All migrations additive; legacy 11 tables untouched; deleting a connector leaves receipts with NULL lineage.

## 17. Deferred (recorded)

- Outbound connector operations (platform → site) with the §394 agent-permission leg — lands with P7/P9/P11.
- `chat.answer` grant + widget embed-token re-keying (§411) — P11/P13.
- Deliveries retention/pruning job (receipt log grows unbounded; add a cleanup sweep when volume warrants).
- Connector-scoped event fanout rules (notifications per delivery failure) — current failure visibility rides task.failed/knowledge.source.failed.
- Add-Website wizard (§121–123 full acceptance: onboarding a new site is configuration only) — the wizard UI is the remaining piece; the connector half of that acceptance is now demonstrable.

## 18. Next per roadmap

**Phase 7 — Research workforce** (roadmap P6; MVP use case #1: daily AI/legal-AI intelligence): research/intelligence agents on the §52 contract (retrieval + web tools + sources + confidence + scores), research_items/competitors stores, scheduled research workflow, research dashboard. **Requires a funded OpenAI key for live verification** (standing owner action); the connector content pipeline from this phase is its grounding fuel.
