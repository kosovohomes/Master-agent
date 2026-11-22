# AgentOS

AgentOS is a social-media and customer-service assistant for small businesses. It is built with Next.js (App Router), Postgres + pgvector, and an OpenAI-compatible LLM client. There is no agent framework: the agents are plain TypeScript functions.

In plain terms, it does four things:

1. **Turns a goal into a draft.** You tell it what you need (for example, "write a LinkedIn post about our webinar"). It routes the request to one of five agents and generates a draft.
2. **Waits for a human.** Drafts sit in an approval queue until someone approves or rejects them.
3. **Publishes on a schedule.** A cron job picks up approved, scheduled drafts and publishes them to email, X, or LinkedIn.
4. **Answers website visitors.** An embeddable chat widget answers questions using only content that belongs to that specific customer ("tenant"), and shows its sources.

Around that core there is a durable task queue, an AI gateway with spending limits and a cost ledger, role-based permissions, an audit trail, webhook connectors, social-platform OAuth, and an operations dashboard.

---

## Quickstart

Requires **Node 20+** and **Postgres with the pgvector extension**.

```bash
cp .env.example .env.local      # then fill in real values
npm ci                          # install dependencies
npm run migrate                 # create/update the database schema
npm run dev                     # start the app on http://localhost:3000
```

Then:

- Open `/login` and sign in. The first owner is created either with `POST /api/admin/bootstrap` (using `OPS_TOKEN` or `ADMIN_PASSWORD`) or by signing in with Google when that email is listed in `OWNER_EMAILS`. See `docs/ACCESS.md` for the full recovery and access runbook.
- The dashboard lives at `/dashboard`, with separate pages for approvals, research, content, marketing, SEO, social, sales, analytics, knowledge, connectors, websites, supervisor, and settings.
- The public widget configuration endpoint is `GET /api/v1/widget/config?tenant=<id-or-slug>`.

Verify before shipping:

```bash
npm test        # 57 suites, each in its own process; needs a live test database
npm run build   # type-check + production build
```

`npm test` refuses to run against a database whose URL contains the production marker; point `DATABASE_URL` at an ephemeral Postgres instance.

---

## Environment variables

Required for a working install:

| Variable | Purpose |
| --- | --- |
| `DATABASE_URL` | Postgres connection string (pgvector enabled) |
| `CHANNEL_ENC_KEY` | 32-byte hex key used to encrypt publishing tokens (AES-256-GCM) |
| `ADMIN_PASSWORD` | Bearer secret for the ops/bootstrap endpoints |
| `CRON_SECRET` | Bearer secret protecting `/api/agents/sweep` and `/api/agents/engine/tick` |

Commonly needed:

| Variable | Purpose |
| --- | --- |
| `OPENAI_API_KEY` | LLM provider key |
| `OPENAI_MODEL`, `OPENAI_EMBEDDINGS_MODEL` | Default chat and embedding models |
| `RESEND_API_KEY`, `EMAIL_FROM`, `EMAIL_TARGET` | Email publisher |
| `NEXT_PUBLIC_APP_URL` | Public base URL (also used as the OpenRouter HTTP-Referer) |
| `OPS_TOKEN` | Optional separate ops key; same trust level as `ADMIN_PASSWORD` |
| `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `OWNER_EMAILS`, `GOOGLE_OAUTH_STATE_SECRET` | Optional "Sign in with Google" |

Optional tuning and providers: `LLM_PROVIDER` (openai/gemini/groq/openrouter/custom), `LLM_BASE_URL`, `LLM_CHAT_MODEL`, `LLM_EMBED_MODEL`, `LLM_FALLBACK_MODELS`, `LLM_TIMEOUT_MS`, `LLM_RATE_PER_MIN`, `DAILY_TENANT_LLM_CAP`, `SEARCH_PROVIDER`, `BRAVE_SEARCH_API_KEY`, `SUPERVISOR_MAX_PLAN_BUDGET_USD`, `CHANNEL_ENC_KEY_ID`, `CHANNEL_ENC_KEY_PREVIOUS`, `CHANNEL_ENC_KEY_PREVIOUS_ID`.

Secrets are never committed. `.env.local` is gitignored and `.env.example` contains placeholders only.

---

## How the pieces fit together

```
  POST /api/agents/run  ──►  Orchestrator (lib/agents/dispatch.ts)
                                  │  routes a goal to one agent
        ┌──────────┬──────────┬──────────┬─────────────┬───────────────┐
     research   marketing    sales    ambassador   customer_service
      (briefs)   (copy for   (leads)  (awareness)   (chat only, no
                  channels)                         drafts)
        └──────────┴──────────┴──────────┴─────────────┴───────────────┘
                                  │
                    Approval queue (drafts table + dashboard)
                    pending → approved|rejected → scheduled → posted|failed
                                  │
              Cron sweep (POST /api/agents/sweep, header x-cron-secret)
              publishes due drafts through the email / X / LinkedIn publishers
                                  │
              Chat widget (POST /api/v1/chat) → tenant-scoped RAG → answer + sources
```

Key implementation points:

- **Agents and routing** — `lib/agents/catalog.ts`, `generators.ts`, `dispatch.ts`, `core.ts`. Each run is recorded in `agent_runs` with model, prompt version, tokens, and cost.
- **Approval FSM** — `lib/agents/approval.ts`. Transitions are checked against `STATUS_FLOW` inside a transaction with a row lock; every decision writes an `approvals` audit row.
- **Sweep and publishing** — `lib/agents/publishers/index.ts`. Instagram and TikTok are draft-only in this version; their scheduled drafts are skipped.
- **Task engine** — `lib/tasks/`. Durable queue with idempotent spawns, `FOR UPDATE SKIP LOCKED` claims, retries with backoff, visibility-timeout recovery, and workflows.
- **AI gateway** — `lib/ai/`. One controlled doorway for completions and embeddings: provider routing, fallback models, per-BU rate limits, pre-call budget hard-stops, and a `llm_requests` cost ledger.
- **RAG** — `lib/knowledge/` and `lib/rag/`. Content is chunked (~800 chars), embedded, and stored in pgvector. Retrieval filters by business unit, website, jurisdiction, agent scope, authority tier, access level, and effective date, and re-applies the filter when hydrating results.
- **Widget** — `public/widget.js`, a self-contained vanilla-JS embed (no `eval`, no inline handlers). Answers and sources are rendered as text.

---

## Sign-in and permissions

- Password login issues a server-side session cookie (only a hash of the token is stored). "Sign in with Google" is optional and hidden when not configured.
- Admin and agent routes check RBAC permissions on the server; the UI never decides access.
- Ops endpoints (`bootstrap`, `migrate`, `seed`, `env-check`, `recover`) use a bearer token (`OPS_TOKEN` or `ADMIN_PASSWORD`).
- The cron endpoints use `x-cron-secret`.
- Emergency flags in `system_settings`/`feature_flags` can stop all agent work (`stop_all_agents`), stop publishing (`disable_publishing`), or restore the legacy direct sweep (`legacy_sweep_direct`).
- `legacy_bearer_auth` allows the old ops/admin bearer on some routes during the transition; turn it off once session-based access is verified.

See `docs/ACCESS.md` and `AGENTOS-RUNBOOK.md` for operator details.

---

## Embedding the chat widget

`data-tenant` is the numeric tenant **id** (not a slug). A site key is optional but recommended; with it, conversations bind to the website that emitted them.

```html
<script
  data-tenant="491"
  data-brand="Acme Homes"
  data-site-key="wgt_…"
  data-base="https://your-host"
  src="https://your-host/widget.js"
  defer
></script>
```

Ingestion is done by admins through `/api/admin/knowledge` (source registry) and `/api/admin/knowledge/[id]/fetch`, or in code via `addContentSource` and `ingestText` from `lib/rag/ingest.ts`. Duplicate content (same `sha256`) is skipped.

---

## API surface (summary)

| Prefix | Auth | What it covers |
| --- | --- | --- |
| `/api/v1/chat`, `/api/v1/widget/config`, `/api/v1/inquiries` | Public, rate-limited | Widget chat, config, and inquiry intake |
| `/api/auth/*` | Public / session | Login, logout, current user, optional Google OAuth, provider advertisement |
| `/api/agents/run` | Session (`agents.run`) or legacy bearer | Orchestrate a goal into a draft/run |
| `/api/agents/sweep`, `/api/agents/engine/tick` | `x-cron-secret` | Publishing sweep and engine worker tick. The sweep runs daily via `vercel.json`; a GitHub Actions heartbeat ticks the engine every 15 minutes when `AGENTOS_TICK_URL` and `AGENTOS_CRON_SECRET` are configured (see `AGENTOS-RUNBOOK.md`). |
| `/api/admin/*` | Session with RBAC permissions, or ops bearer on ops routes | Drafts, users, business units, websites, settings, audit, budgets, tasks, workflows, knowledge, connectors, research, content, SEO, social, marketing, sales, analytics, supervisor |
| `/api/integrations/[siteId]/events` | Signed webhook | Connector event intake |

`POST /api/v1/channels` is **retired** and returns `410 GONE`; credentials are wired through signed webhook connectors and the social OAuth surface instead.

Errors follow `{ "errors": [{ "code", "detail?" }] }` with 400/401/403/404/409/429/500 semantics.

---

## Safety notes

- Channel tokens are stored encrypted with AES-256-GCM and decrypted only at publish time; key rotation is supported via key IDs.
- Secrets and internal error details are never echoed in API responses; 5xx bodies carry a fixed generic detail.
- Rate limits are per IP and global across serverless instances; the daily LLM cap is per tenant. AI spending limits are enforced by the gateway before each call.
- Knowledge fetchers accept only public HTTP(S) URLs. Hostnames are resolved and checked against private, loopback, link-local, and cloud-metadata ranges before every request, including every redirect hop. Reserved test domains are exempt so tests stay hermetic.
- Publishing is at-least-once: a crash after an external post but before the status write can cause a retry. A future hardening pass can add claim rows and publisher-side idempotency keys.

---

## Tests

`npm test` launches 57 suites, each in its own process, against a real Postgres database (some suites exercise migrations, FSM transitions, and RAG). It includes security suites for auth, OAuth, RBAC, rate limiting, audit, connectors, RAG isolation, publishing, and the external HTTP surfaces.

---

## Project documents

- `docs/ACCESS.md` — sign-in, owner recovery, and access model
- `AGENTOS-RUNBOOK.md` — operator runbook
- `docs/STAGING.md` — staging guidance
- `docs/specs/2026-09-09-agentos-design.md` — original design
- `docs/PHASE-*-IMPLEMENTATION-REPORT.md` — phase-by-phase implementation history
- `docs/superpowers/plans/2026-09-09-agentos.md` — original build plan

## Roadmap

Future work: live Instagram/TikTok publishing, CRM sync for leads, auto-replies to mentions/comments, white-labeling, a tenant upload portal, retry/backoff for failed publishes, transactional FSM + idempotent sweep claims.
