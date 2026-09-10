# AgentOS — Handoff Report

**Date:** 2026-09-10
**Status:** IMPLEMENTATION COMPLETE — all 14 plan tasks done, tested, verified, deployed-ready
**Repository:** https://github.com/kosovohomes/Master-agent (`main`, HEAD `30c1387`)
**Local checkout:** `C:\Users\hamad\OneDrive\Desktop\agentos`

---

## 1. What this is

AgentOS is a **multi-tenant AI agent platform** (SaaS) where each customer gets one embeddable script for their website. One orchestrator dispatches goals to 5 specialized agents. Nothing is published automatically — every outgoing post sits in a per-tenant **approval queue** where a human approves, rejects, or schedules it.

## 2. Current state

| Item | State |
|---|---|
| All 14 implementation tasks | Done, each reviewed + gated Approved |
| Test suite | **ALL SUITES PASS** — 14 suites (smoke, db, llm, channels, routing, approval, rag, generators, dispatch, chat, publishers, widget, admin, security) |
| Production build | `next build` success, 13 routes |
| Git | `main` at `30c1387`, pushed to GitHub, clean tree |
| Runtime dataset | Empty by design — **0 tenants, 0 drafts, 0 runs** (tests clean up after themselves) |
| Dev server | Running at `http://localhost:3000` on this PC |

## 3. The 5 agents

- **research** — topic deep-dives into draft reports
- **marketing** — brand-voiced social posts / email copy (default for unknown goals)
- **sales** — outreach drafts; B2B + B2C; stages a `lead` record per prospect
- **ambassador** — creator-style posts
- **customer_service** — **chat only**. Never generates; answers only from tenant-scoped RAG retrieval, never invents facts

Routing is a **deterministic rule-based router** (keyword + intent matching, explicit `chat` goal). No LLM used for routing and no agent frameworks (LangGraph/CrewAI/OpenAI SDK) — a custom core calls OpenAI over raw HTTP.

## 4. Product surface

| Route | Purpose |
|---|---|
| `POST /api/agents/run` | Dispatch a goal (`{goalType, topic, channel, prospect?}`) → records run + writes pending draft |
| `POST /api/v1/chat` | Customer-service answer with `{answer, sources}` |
| `GET /api/v1/widget/config?tenant=<id or slug>` | Public config for the embed widget |
| `POST /api/v1/channels` | Wire up a channel token (encrypted at rest) |
| `GET/POST /api/admin/drafts` + `/api/admin/drafts/[id]` | Approval queue (guard: Bearer `ADMIN_PASSWORD`) |
| `POST /api/admin/login` | Password check for the dashboard |
| `GET /api/agents/sweep` | Cron task (every 15 min via `vercel.json`) that publishes `scheduled` drafts (guard: `x-cron-secret` = `CRON_SECRET`) |
| `/admin`, `/admin/login` | Approval dashboard UI |

Channel support: **X + LinkedIn publish live**, **Instagram/TikTok are draft-only** in v1, **email via Resend**. No channel token is ever stored in plaintext (AES-GCM, key in env).

## 5. How to run

```bash
cd C:\Users\hamad\OneDrive\Desktop\agentos
npm run dev        # http://localhost:3000
npm test           # full suite (live Neon DB)
npm run build      # production build
```

## 6. Environment config (secrets live ONLY in `.env.local`, never in git)

The `.env.local` file in the local checkout holds the live values. It also exists as `.env.example` with placeholders (safe to share). A fresh clone **must not** commit `.env.local` (`.gitignore` covers it).

| Key | What it is |
|---|---|
| `DATABASE_URL` | Neon Postgres + pgvector (SSMODE `require`, pooler) |
| `OPENAI_API_KEY` | Live — set |
| `OPENAI_MODEL` | `gpt-4o-mini` |
| `OPENAI_EMBEDDINGS_MODEL` | `text-embedding-3-small` (1536 dims) |
| `CHANNEL_ENC_KEY` | 64-hex AES key for channel tokens |
| `ADMIN_PASSWORD` | Dashboard login — value in `.env.local` |
| `CRON_SECRET` | Sweep route header value — in `.env.local` |
| `RESEND_API_KEY` | Email provider — set |
| `EMAIL_FROM` / `EMAIL_TARGET` | Email sender / blast recipient |
| `NEXT_PUBLIC_APP_URL` | `http://localhost:3000` |

## 7. Data model (11 tables)

`tenants`, `tenant_config`, `channels`, `content_sources`, `documents`, `chunks`, `agent_runs`, `drafts`, `approvals`, `leads`, `outbox`.

Draft lifecycle (FSM enforced): `pending → approved → scheduled → posted | failed`, `rejected` is terminal.

## 8. Known limitations & deferred items (documented in README)

- Draft/run/outbox writes are **non-atomic** → at-least-once behavior (retry-safe, no duplicates of harm)
- IG/TikTok drafts intentionally park until channels go live
- `POST /api/v1/channels` is v1 auth-free by design (documented)
- No LinkedIn/X OAuth flow yet — tokens are pasted via the channels endpoint
- Email `EMAIL_TARGET` is static (no per-tenant target plumbing in v1)

## 9. Demo steps (next action recommended)

1. Create a tenant (name + slug) and a few content paragraphs in the DB
2. `ingestText` the content → vectors in `chunks`
3. `POST /api/agents/run` with a real marketing goal → real OpenAI draft created
4. Load that tenant ID in `/admin` → approve → schedule → sweep publishes

## 10. Safe-to-tell answers to common questions

- "Why is the widget config 404?" → that tenant doesn't exist yet; correct behavior
- "Why does the dashboard show nothing on Load?" → no data yet; see demo steps
- "Admin password?" → in `.env.local` (`ADMIN_PASSWORD`)