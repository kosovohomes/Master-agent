# AgentOS

AgentOS is a framework-free agent orchestration core for small-business social/media
operations. It turns a goal ("cover the FALCON launch", "draft a LinkedIn post about the
webinar") into agent-generated drafts, runs them through a human approval queue, and
publishes approved drafts to live channels on a cron sweep. It also powers an embeddable
customer-service chat widget grounded strictly in each tenant's retrieved content (RAG).

All five agents are plain TypeScript functions — no agent framework dependency. The stack
is Next.js 16 (App Router) + Postgres/pgvector + the OpenAI-compatible `lib/llm` client.

## Quickstart

1. Copy the example env and fill in real values:

   ```bash
   cp .env.example .env.local
   # DATABASE_URL       → your Postgres (pgvector enabled)
   # OPENAI_API_KEY     → LLM + embeddings provider key
   # CHANNEL_ENC_KEY    → 32-byte hex string (AES-256-GCM) for channel tokens
   # ADMIN_PASSWORD     → bearer secret protecting /api/admin/*
   # CRON_SECRET        → bearer secret protecting /api/agents/sweep
   # RESEND_API_KEY, EMAIL_FROM, EMAIL_TARGET → email publisher
   ```

2. Create the schema:

   ```bash
   npm run migrate
   ```

3. Run the app:

   ```bash
   npm run dev
   ```

   - Admin dashboard (approve/reject/schedule drafts): `/admin`
   - Widget config endpoint: `GET /api/v1/widget/config?tenant=<slug-or-id>`

4. Run the full test suite (all 14 suites, each in its own process):

   ```bash
   npm test
   ```

5. Verify production build before shipping:

   ```bash
   npm run build
   ```

Requires Node 20+.

## Architecture

```
                    ┌────────────────────────────────────────────┐
                    │ Orchestrator  POST /api/agents/run          │
                    │   routes a goal to one of five agents       │
                    └────────────────────────────────────────────┘
                                          │
        ┌─────────────────┬──────────────┼──────────────┬─────────────────┐
   research           marketing        sales       ambassador      customer_service
   (intel briefs)   (per-channel copy) (outreach,  (awareness copy)  (chat, RAG-grounded,
                                           leads)                          no drafts)
        └─────────────────┴──────────────┼──────────────┴─────────────────┘
                                          │
                    ┌────────────────────────────────────────────┐
                    │ Approval queue  (drafts table + admin UI)   │
                    │   pending → approved → scheduled            │
                    └────────────────────────────────────────────┘
                                          │
                    ┌────────────────────────────────────────────┐
                    │ Cron sweep  POST /api/agents/sweep (x-cron- │
                    │   secret) publishes scheduled drafts via    │
                    │   publishers (email / x / linkedin live;    │
                    │   instagram / tiktok draft-only in v1)      │
                    └────────────────────────────────────────────┘
```

- **Orchestrator** — `lib/agents/dispatch.ts` + `lib/agents/core.ts`. Routes each goal by
  topic/channel heuristics, calls the right generator, records an `agent_runs` row.
- **Five agents** — `lib/agents/catalog.ts`, `lib/agents/generators.ts`.
- **Approval queue** — `lib/agents/approval.ts`. A strict FSM:
  `pending → approved|rejected`, `approved → scheduled`, `scheduled → posted|failed`,
  `rejected/posted/failed` are dead ends. Every decision writes an `approvals` audit row.
- **Sweep** — `lib/agents/publishers/index.ts`. Finds `scheduled` drafts, decrypts the
  channel token, publishes, then marks `posted` + writes an `outbox` row.
- **Chat** — `lib/agents/chat.ts` + `lib/rag/retrieve.ts`. Embeds the question, retrieves
  the tenant's chunks by cosine distance, and instructs the LLM to answer **only** from
  those passages, citing them as `sources`.

## Embedding content for a tenant

`lib/rag/ingest.ts` exposes `ingestText(ctx, { tenantId, sourceId, title, text })`. Give
tenants an internal endpoint (or script) that sends their sitemap/uploaded text:

```ts
import { llm } from "./lib/llm";
import { addContentSource, ingestText } from "./lib/rag/ingest";

const src = await addContentSource({ embed: (t) => llm.embed(t) }, {
  tenantId: 42,
  kind: "sitemap",
  ref: "https://client.site/sitemap.xml",
});

await ingestText({ embed: (t) => llm.embed(t) }, {
  tenantId: 42,
  sourceId: src.sourceId,
  title: "About",
  url: "https://client.site/about",
  text: "…markdown or plain text…",
});
```

Text is chunked (~800 chars), embedded, and stored as `chunks.embedding` (pgvector).
Duplicate `sha256` content is skipped. Only the tenant's own chunks are ever retrievable.

## Widget embed

```html
<div data-agentos-widget data-tenant="acme-co"></div>
<script src="https://your-host/widget.js" defer></script>
```

`public/widget.js` is a self-contained, CSP-safe vanilla-JS widget (no `eval`, no inline
handlers, no network calls beyond `POST /api/v1/chat`). It renders the answer plus its
`sources`.

## API surface

| Endpoint | Auth | Body / params | Purpose |
|---|---|---|---|
| `POST /api/v1/chat` | none (public) | `{ tenantId, question }` | RAG-grounded answer + sources |
| `GET /api/v1/widget/config` | none (public) | `?tenant=<slug-or-id>` | Public widget config: `{ tenantId, brand }` |
| `POST /api/v1/channels` | none — **auth-free by design in v1** (see security notes) | `{ tenantId, kind, token }` | Wire up a channel token (stored AES-256-GCM encrypted) |
| `POST /api/agents/run` | none (demo/API) | `{ tenantId, topic, channel?, context? }` | Orchestrate goal → draft (or chat) |
| `POST /api/agents/sweep` | `x-cron-secret` | — | Publish due scheduled drafts (run from a cron job) |
| `POST /api/admin/login` | — | `{ password }` | Exchange `ADMIN_PASSWORD` for a session flag |
| `GET /api/admin/drafts` | `Authorization: Bearer <ADMIN_PASSWORD>` | `?tenantId=<digits>` | List a tenant's drafts |
| `POST /api/admin/drafts/[id]` | `Authorization: Bearer <ADMIN_PASSWORD>` | `{ action: approve\|reject\|schedule, comment? }` | Drive the approval FSM |

The agreed error contract is `{ errors: [{ code, detail? }] }` with 400/401/404/409/500
semantics per route. Malformed JSON bodies return `400 INVALID_JSON`.

## Security notes

- **No secrets in the repo.** `.env.example` is placeholders only; `.env.local` is
  gitignored. Channel tokens are **never** stored in plaintext — `lib/channels.ts`
  encrypts them with AES-256-GCM (`CHANNEL_ENC_KEY`) and the sweep decrypts only at
  publish time.
- **Timing-safe compares.** `x-cron-secret` (sweep) and `ADMIN_PASSWORD` (admin auth +
  login) are compared with `crypto.timingSafeEqual` (`lib/security.ts`), which rejects on
  length mismatch.
- **Admin API is behind a bearer token**; the admin UI holds the password in
  `sessionStorage` for the page session only. `POST /api/admin/drafts/[id]` authorizes
  **before** parsing the body.
- **v1 channel wire-up is auth-free by design.** The `/api/admin/*` surface carries the
  admin bearer; the v1 channel endpoint does not (post-T13 architecture keeps v1 public).
  **Production should move channel wire-up behind admin auth.** The endpoint does,
  however, distinguish unknown tenants (FK violation → `404 UNKNOWN_TENANT`) from real
  failures (`500`, generic `detail: "internal error"`), and never echoes internals.
- **Internal error details are never echoed** in API responses — 5xx bodies carry a fixed
  generic `detail`.
- **Idempotency / at-least-once sweep semantics.** `markPosted`/`markFailed` plus the
  channel-health flip are not atomic, `approveDraft` does a non-transactional
  read-then-write transition, and `generateDraft` writes the draft and (for sales) the
  lead separately. These are intentional "at-least-once / retry-safe leftovers" shapes:
  a crash can duplicate a lead or a publish attempt, never lose data. A future hardening
  pass may wrap the FSM transitions and lead insert in transactions and/or make the
  sweep claim-rows idempotent.
- **Instagram/TikTok are draft-only.** `sweepDue` skips their scheduled drafts, so they
  stay `scheduled` until channels go live — they are tracked in `outbox` only once
  posted/failed. This is plan-mandated for v1 (`lib/agents/publishers/index.ts`).
- **RAG isolation is tenant-column driven.** Retrieval always filters by
  `tenant_id`; suspended tenants are not resolvable via the widget endpoint.

## Roadmap

- **v1 (done):** orchestrator + 5 agents, approval queue + admin dashboard, cron sweep,
  live publishing for email / X / LinkedIn, draft-only for Instagram / TikTok,
  embeddable chat widget grounded in tenant RAG, public widget-config endpoint,
  14 integration/security test suites, ENC/DB wiring.
- **Future:** live Instagram/TikTok publishing, CRM sync (leads → pipeline), auto-reply to
  mentions/comments, white-labeling the dashboard and widget, tenant upload portal,
  retry/backoff for failed publishes, transactional FSM + idempotent sweep claims,
  moving v1 channel wire-up behind admin auth.