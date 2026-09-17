# Phase 11 Implementation Report — Marketing Workforce

**Target milestone:** Phase 10 in roadmap numbering ("Marketing workforce — campaigns, audience analysis, performance monitoring"; audit §789 row 17, build sequence §908), implemented as **Phase 11** in report numbering (5–8 = knowledge v2/connectors/research/content, 9 = SEO, 10 = social).

**Commits:** `73ffa8f` (feature), `aa86634` + `00ef4f6` (live-acceptance script). Production deploy READY at `73ffa8f`; migrations 040–042 applied to production (ledger 43 versions, legacy 11/11 intact).

## 1. What shipped

A marketing workforce with a **campaign lifecycle that is operational end-to-end under §91 autonomy defaults**: brief generation is the AUTO leg (agent may draft), launch is the APPROVAL leg (only a human session user can activate, identity immutably stamped), performance monitoring is append-only.

| Capability | Where | Contract |
|---|---|---|
| Campaign FSM | `lib/marketing/types.ts` | `draft → active ⇄ paused → completed/cancelled`; `completed`/`cancelled` terminal; row-locked transitions |
| Approval law (§91) | `lib/marketing/service.ts` `transitionCampaign` | INTO `active` REQUIRES `approverUserId`; first approver + `approved_at` immutable via `COALESCE`; relaunch re-stamps `activated_at` only |
| Audience segments | `audience_segments` (M_040) | per-BU UNIQUE name; FK-linked optional on campaigns; BU-scoped validation |
| Metrics | `campaign_metrics` (M_040) | append-only snapshots; rollups SUM; `source ∈ (manual, provider, derived)` |
| Brief pipeline | `lib/marketing/pipeline.ts` | evidence gathering (BU profile + content titles + segments + connected platforms) → LLM v2 brief (marketing agent, purpose=`marketing`) → honest-refusal→`null`→deterministic fallback; channel allowlist; clamps (offset 0–30, duration 7–90) |
| Lifecycle sweep | `lib/marketing/tasks.ts` | Workflow #3 `scheduled_marketing_sweep`: flag fail-closed skip → auto-complete `active` campaigns past `ends_at` (time semantics — expiry is NOT a launch decision) → events |
| Control surface | `/marketing` + `/api/admin/marketing*` | 9 routes, permission-gated (`marketing.manage` / `audit.read`), audited; transition route is the ONLY launch doorway |
| Events | `marketing.campaign_completed` / `campaign_activated` / `sweep` | observable on the bus; none page ops in v1 |

## 2. Autonomous-vs-human boundary (the invariant)

- Agents (or the deterministic leg) can produce **briefs** and **draft campaigns** — nothing more.
- There is **no code path to `status='active'` without a human approver identity**: the service enforces it, the only caller is the audited transition route, and the session user is stamped server-side (verified live: `approvedBy=1`).
- Approval history is immutable: relaunch after pause preserves the original approver and `approved_at` (verified live).
- The sweep may only **end** a campaign (time expiry), never start one.

## 3. Degradation discipline (no funded LLM required)

- Brief generation degrades to a **deterministic, evidence-grounded brief** on ANY LLM failure (quota/budget/timeout) or honest refusal. Deterministic briefs carry `degraded=true` + a note; live acceptance verified `degraded=true` on production with the unfunded OpenAI key.
- Nothing is invented: thin evidence produces a thin-but-honest brief (generic brand-safe message, channels floored to `blog`); the LLM's channel output is allowlisted to `blog|email|linkedin|x|instagram|tiktok`.
- When the Gemini key is set (`LLM_PROVIDER=gemini`, pending from owner), the LLM leg lights up with **zero code changes** and rides the gateway ledger at purpose=`marketing`.

## 4. Verification evidence

- **Unit/integration (staging DB, `agentos_staging`):** `tests/marketing-tests.ts` — **57/57 PASS**: FSM math + runtime (illegal transitions, launch-without-approver blocked, immutable approver on relaunch, terminal edit refusal), segment dedup/BU-isolation, window validation, append-only rollup sums, exhausted-campaign selection, sweep flag drill (OFF skip / ON auto-complete / idempotent re-run), brief legs (deterministic incl. thin, LLM parse/allowlist/clamp, refusal→null, failure→deterministic).
- **CI:** GREEN on `73ffa8f` — 48 suites (+ typecheck + build) against an ephemeral pgvector container. (One auxiliary failure on `aa86634` was the acceptance script's own missing `tick` symbol — fixed in `00ef4f6`.)
- **Production:** migrations 040–042 applied (61 public tables, legacy 11/11 untouched); **live acceptance 41/41 PASS**: 401 fail-closed, surface+flag, segment dedup 409, cross-BU segment guard 400, brief (deterministic, honest provenance), draft→launch with approver stamp, pause→relaunch preserves identity, append-only rollup (2500/100/7/$10/2 snapshots), flag drill (OFF: active campaign NOT auto-completed; ON), terminal edit 409, audit rows for 7 `marketing.*` actions with zero secret leakage, 8 screens + widget regression.
- **Bugs caught by staging runs before commit** (the reason staging evidence matters): transaction callback is `q(sql, params)` not `client.query` (4 sites); `$3` bound only in the launch branch (08P01 "supplies 3 parameters, requires 2"); schema-valid refusal stubs; thin-evidence check needed a virgin BU.

## 5. Rollback & safety

- `marketing` flag OFF → sweep skips fail-closed (verified live), brief API 423s, dashboard shows OFF. Zero deploys to disable.
- Migrations are strictly additive (3 new tables + workflow seed + prompt row + flag/permission). No legacy table touched.
- Rollup/metrics are append-only — no destructive path.

## 6. Owner actions pending (unchanged)

1. **Free Gemini API key** (https://aistudio.google.com/apikey, starts `AIza…`) — activates the LLM leg of briefs + the full RAG loop platform-wide via `LLM_PROVIDER=gemini` + `GEMINI_API_KEY` on Vercel; zero code changes.
2. Real OpenAI credits (optional) — rollback path `LLM_PROVIDER=openai`.
3. Resend domain verification (email notifications still suppressed).

## 7. Next per roadmap

**Phase 12 — Sales + customer workforce** (audit §909): inquiries→leads→escalation; conversations storage (widget chat persists), classification/scoring agents (§55), escalation paths, lead pipeline UI; widget becomes website-registered (§13).
