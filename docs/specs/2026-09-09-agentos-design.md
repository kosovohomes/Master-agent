# AgentOS — Multi-Tenant AI Agent Platform (Design Spec)

**Date:** 2026-09-09
**Status:** Approved (design agreed in chat; intent: independent product)

## 1. Purpose

AgentOS is a standalone, SaaS multi-tenant platform that lets any website or
app adopt a team of AI agents by embedding one script tag. The platform is
independent of LKC (the Jordanian legal-knowledge platform) but reuses its
proven patterns: deterministic orchestration, hand-rolled SQL, strict audit
trails, and no framework dependencies in the agent core.

Each adopting site becomes a **tenant** with its own:

- brand voice, persona, target audience, and content sources
- social channels and publishing tokens (LinkedIn, X, Instagram/TikTok, email)
- agent approval inbox (human-in-the-loop gate before anything is published
  or contacts a person)
- per-tenant ingestion pipeline powering a customer-service chat that answers
  only from that tenant's own content

Nothing is published and nobody is contacted without an explicit human
approval. Chat answers are grounded in the tenant's retrieved corpus, never a
model's freeform guess.

## 2. Agents

**Orchestrator** — the only entry point for agent work. Deterministic router
(no LLM in the routing path, mirroring LKC's Phase 10 orchestrator): reads a
tenant goal, selects one or more specialists by topic and channel, scans for
open approval items, dispatches, and appends an audit row per run.

Five specialist agents. Each is an LLM call plus a fixed toolset:

| Agent | Responsibility | Tools |
|---|---|---|
| Research | Gather legal-news/industry intel, summarize, produce briefs | web search, tenant corpus retrieval |
| Marketing | Turn briefs into per-channel copy drafts | brief store, channel formatters |
| Sales | Build prospect lists, draft outreach/partnership emails, record leads | lead store, email formatter |
| Ambassador/Promoter | Awareness content, testimonial/event mentions, replies-to-mentions drafts | tenant corpus, channel formatters |
| Customer Service | Live chat answers from tenant RAG (no approval needed; verified pipeline) | tenant RAG only |

Customer-service answers are the exception to the approval gate on purpose:
the pipeline is deterministic retrieval + citation, same trust model as LKC's
verified answers.

## 3. Architecture

Custom agent core — not LangGraph/CrewAI/OpenAI Agents SDK. Focused files in
`lib/`, matching the codebase philosophy of owning the stack.

```
agentos/
  app/
    api/
      v1/chat/            POST — widget chat; tenant-scoped RAG answer
      v1/widget/config    GET  — serves tenant config to widget.js
      agents/sweep        POST — Vercel Cron: publish approved drafts, check channels
      agents/run          POST — on-demand agent dispatch from admin dashboard
    admin/                per-tenant approval dashboard + agent controls
  lib/
    agents/
      core.ts             orchestrator router + run/audit wiring
      approval.ts         draft state machine
      catalog.ts          five agent definitions (persona, tools, defaults)
      publishers/         linkedin.ts, x.ts, email.ts, tiktok.ts, instagram.ts
    rag/ingest.ts         tenant content ingestion (sitemap/upload/API) → pgvector
    rag/retrieve.ts       tenant-scoped retrieval only
    llm.ts                thin OpenAI client wrapper (provider-swap point)
    db.ts                 shared pg pool (Neon serverless)
  public/widget.js        vanilla JS embed (no framework), one script tag
  tests/                  node/tsx harness, same discipline as LKC
```

## 4. Data model (Neon/Postgres + pgvector)

- `tenants` — id, slug, name, status (active/suspended), created_at
- `tenant_config` — tenant_id, brand_voice, persona, audience, content_system_prompt
- `channels` — tenant_id, kind (linkedin|x|instagram|tiktok|email), tokens (encrypted), status
- `content_sources` — tenant_id, kind (sitemap|upload|api), url/ref, last_synced_at
- `documents` / `chunks` — tenant_id-scoped rows + embeddings (pgvector), source ref, checksum
- `agent_runs` — append-only audit: tenant_id, agent, trigger, status, prompt_hash, output_ref, created_at
- `drafts` — tenant_id, agent, channel, content, status (pending|approved|rejected|scheduled|posted|failed), review_notes
- `approvals` — draft_id, approved_by, decision, comment, decided_at
- `leads` — tenant_id, company/name, contact, channel, stage, source, notes, created_at
- `outbox` — draft_id, channel, posted_at, external_id, status

Hard rule: every read/query is tenant-scoped via tenant_id or join key. No
cross-tenant query paths.

## 5. Approval gate

Publish and contact actions only ever happen from drafts. State machine:

```
pending → approved → scheduled → posted
       → rejected (with comment)       → failed (retryable)
```

- Admin approves/rejects/edits in `/admin` (tenant-scoped login).
- `/api/agents/sweep` (Vercel Cron) publishes approved+scheduled drafts
  through the channel publisher, records the outbox row, and the draft's
  status transitions to `posted` or `failed`.
- Rejected drafts keep the reviewer's comment so agents can learn from it
  (comment surfaced into the next run's context for that agent).

## 6. Embeddable widget

```html
<script src="https://agentos.example.com/widget.js"
        data-tenant="acme" data-brand="Acme Legal"></script>
```

- Vanilla JS, no framework, no dependencies.
- Loads tenant config from `/api/v1/widget/config` (public, tenant-scoped,
  brand-safe fields only — never tokens).
- Renders a chat bubble; messages POST to `/api/v1/chat`; answers render
  with a source citation link when available.

## 7. Publishing connectors (v1 scope)

| Channel | v1 behavior |
|---|---|
| LinkedIn | live post via OAuth app token |
| X / Twitter | live post via OAuth token |
| Email | live send via SMTP/Resend, per-lead templated outreach |
| Instagram | drafts only — approved content queued for manual publish |
| TikTok | drafts only — same reasoning (platform API friction) |

Rate limiting and circuit breakers per channel: on repeated failures the
channel is marked unhealthy and the sweep stops sending to it until an admin
re-enables it.

## 8. Tenant content → chat knowledge

Tenant plugs one of: sitemap URL, document upload, or API hook.
Pipeline: fetch → normalize → chunk → embed → insert tenant-scoped
`documents` + `chunks` rows (same RAG approach as LKC Phase 5, including
Arabic-safe normalization where the tenant feeds Arabic content).

Chat retrieval is hard-scoped to the tenant's own chunks. No leakage
between tenants ever.

## 9. Security

- Channel tokens encrypted at rest (AES-256-GCM; key from env).
- Tenant auth: admin sessions per tenant; widget reads only public config.
- Envelope/error/logging shape mirrors LKC API (`{ data, meta, errors }`,
  request ids, rate-limit headers) for consistency and easy auditing.
- No secrets committed; `.env.local`-style via environment on Vercel.

## 10. Testing & verification

Same model as LKC (`tests/*.ts` run with `tsx`, live DB where needed):

1. approval state machine — legal/illegal transitions
2. orchestrator routing — correct agent chosen per goal/channel
3. RAG tenant isolation — retrieval never crosses tenant boundaries
4. channel payload builders — correct contract per publisher
5. rate-limit/circuit-breaker — channel fails safe
6. widget config — public endpoint leaks no secrets

## 11. In scope / out of scope (v1)

**In:** custom agent core, five agents + orchestrator, multi-tenant foundation,
approval dashboard, chat + RAG, LinkedIn/X/email live publishers, IG/TikTok
drafts-only, embeddable widget, Vercel Cron sweep.

**Out:** lead CRM integration, multi-tenant agent isolation beyond row scoping,
auto-reply to all mentions, white-label theming of the admin UI, billing.

## 12. Build order & effort

1. Scaffold repo (Next.js + TS + Neon pool + `lib/llm.ts`) — 0.5 day
2. Multi-tenant foundation (tables, auth, admin shell) — 2 days
3. Agent core (orchestrator + 5 agents + catalog) — 4 days
4. Approval queue + admin UI — 2 days
5. Chat + RAG (ingest pipeline + retrieval) — 3 days
6. Publishers (LinkedIn/X/email live, IG/TikTok draft-only) + cron sweep — 3 days
7. Embeddable widget — 1.5 days
8. Test suite + security pass — 2 days

Total ≈ 3 weeks at current pace.