# AgentOS — Deployment Fix & Usage Runbook

**Date:** 2026-09-11 · **Repo:** `kosovohomes/Master-agent` · **Deployed at:** `masteragent-nine.vercel.app` (canonical production alias)

---

## 1. Mental model — how AgentOS actually works

Think of it as a **factory with a quality gate**, not a chatbot:

```
                 ┌──────────────┐
  GOAL ────────► │  ORCHESTRATOR │──► research    → draft report
  (topic +       │  (rule-based  │──► marketing   → social/email copy
   channel)      │   router)     │──► sales       → outreach draft + lead
                 └──────────────┘──► ambassador  → creator-style post
                                   └─► customer_service → chat ONLY (RAG answers)
                        │
                        ▼
                 PENDING DRAFT in approval queue   ← nothing is published ever
                        │                            without a human clicking
                        ▼                            approve
                 /admin: approve → schedule
                        │
                        ▼
                 cron sweep (daily, 03:30 UTC) → publishes to X / LinkedIn / email
```

Key consequences of this design:

- **A fresh install looks empty — that is correct.** There are 0 tenants, 0 drafts by design.
- **There is no "sign up" UI.** Tenants are created in the database (the seed script below does this).
- **The chat agent never invents facts** — it only answers from text you ingested for that tenant.
- **The homepage `/` is intentionally a placeholder.** The product surface is the APIs + `/admin`.

---

## 2. Diagnosis — why your deployment shows "nothing useful"

Three separate layers of problems, all confirmed on 2026-09-11:

| # | Problem | Evidence | Fix |
|---|---------|----------|-----|
| 1 | **Vercel deployment is broken at platform level** — every path returns `500 FUNCTION_INVOCATION_FAILED`, *including static files* like `/favicon.ico` and `/widget.js` | Live probes; the same repo built locally serves `/`, `/admin`, `/admin/login` with HTTP 200 and zero env vars | §3 below |
| 2 | **URL note** — the canonical production URL is **`masteragent-nine.vercel.app`** (Vercel project `masteragent`); older references to `agentos-nine.vercel.app` are stale | Live probes (note: `masteragent.vercel.app` is a stranger's "NOSTA AI" site — not yours) | Use the correct URL |
| 3 | **Empty runtime data** — even once it loads, there are no tenants, so `/admin` shows nothing and widget config 404s | Handoff report: "0 tenants, 0 drafts, 0 runs (by design)" | §5 seed script |

The code itself is healthy: `next build` compiles cleanly (13 routes), TypeScript passes, all 14 test suites pass locally.

---

## 3. Fix the Vercel deployment (do this first)

Since even static assets 500, the project is misconfigured at the **project settings** level. Open https://vercel.com → your project → **Settings**, and verify all of these:

1. **Framework Preset** → must be **Next.js**.
   (If it says "Other" or a CRA/Vite preset, Vercel deploys a broken output where *everything* runs through one crashing function — exactly your symptom.)
2. **Node.js Version** → **20.x or 22.x**. (Next 16 requires ≥ 20.9; an 18.x pin can produce runtime crashes.)
3. **Root Directory** → leave empty / repo root (the Next app lives at the repo root, not in a subfolder).
4. **Build Command / Output Directory** → leave at defaults (Do not override). Next.js auto-detects `next build`.
5. After changing anything: **Deployments → ⋯ → Redeploy** (untick "Use existing build cache").
6. If it still 500s: open the failed deployment → **Runtime Logs** tab, and read the very first stack trace — that names the exact crashing module. Also try deleting the project and re-importing the GitHub repo fresh, then re-enter env vars.

---

## 4. Environment variables on Vercel

Settings → Environment Variables → add **all** of these for Production + Preview (copy values from your local `.env.local` — they are not in git):

| Key | Value |
|---|---|
| `DATABASE_URL` | Neon Postgres **pooled** connection string (`...-pooler...`, `sslmode=require`) |
| `OPENAI_API_KEY` | your live key |
| `OPENAI_MODEL` | `gpt-4o-mini` |
| `OPENAI_EMBEDDINGS_MODEL` | `text-embedding-3-small` |
| `CHANNEL_ENC_KEY` | 64-hex AES key |
| `ADMIN_PASSWORD` | dashboard login password |
| `CRON_SECRET` | header value for the sweep route |
| `RESEND_API_KEY` | email provider key |
| `EMAIL_FROM` / `EMAIL_TARGET` | sender / blast recipient |
| `NEXT_PUBLIC_APP_URL` | `https://masteragent-nine.vercel.app` |

**Important:** `NEXT_PUBLIC_APP_URL` changes between local and prod — keep it pointing at the production URL on Vercel and at `http://localhost:3000` locally.

---

## 5. Give it data (the part you were missing)

Run migrations once, then seed a demo tenant. On your PC, in the repo checkout:

```bash
npm run migrate        # creates the 11 tables in Neon (idempotent)

# copy scripts/seed-demo.ts into scripts/, then:
node --env-file=.env.local node_modules/tsx/dist/cli.mjs scripts/seed-demo.ts
```

The seed script: creates tenant `acme-homes` → saves brand voice → ingests knowledge paragraphs into pgvector → runs a **real OpenAI marketing goal** → prints the generated draft and the tenant ID. Safe to re-run.

---

## 6. Daily usage flow

1. **Generate:** `POST /api/agents/run` with `{ "tenantId": <id>, "topic": "...", "channel": "linkedin" }`
2. **Review:** open `/admin` on the deployed URL → log in with `ADMIN_PASSWORD` → paste tenant ID → **Load**
3. **Approve → Schedule** a draft
4. **Publish:** automatic daily at 03:30 UTC via cron (`vercel.json`), or force: `POST /api/agents/sweep` with header `x-cron-secret: <CRON_SECRET>`
5. **Chat answers:** `POST /api/v1/chat` with `{ "tenantId": <id>, "question": "what is included in every home?" }` (the body key is `question`) → answered strictly from your ingested text, with `sources`
6. **Widget:** `GET /api/v1/widget/config?tenant=<id>` → embed `public/widget.js` on any site

### API cheat sheet

| Endpoint | Auth | Purpose |
|---|---|---|
| `POST /api/agents/run` | session (`agents.run`) or legacy bearer (flag-gated); per-IP + per-tenant daily cap | dispatch a goal → pending draft |
| `POST /api/v1/chat` | none (public); per-IP rate limit + per-tenant daily cap | RAG-grounded customer-service answer |
| `GET /api/v1/widget/config?tenant=` | none | public widget config |
| `POST /api/v1/channels` | session (`website.manage`) or legacy bearer (flag-gated) | store channel token (AES-GCM at rest) |
| `GET/POST /api/admin/drafts` | session (`drafts.read`, BU-scoped) or legacy bearer | approval queue |
| `POST /api/admin/drafts/[id]` | session (`drafts.approve`/`drafts.schedule`) or legacy bearer | approve / reject / schedule (reviewer recorded) |
| `GET/POST /api/agents/sweep` | `x-cron-secret: <CRON_SECRET>` | publish scheduled drafts |

---

## 7. FAQ

- **Widget config returns 404** → that tenant ID doesn't exist. Seed it first (§5). Correct behavior, not a bug.
- **`/admin` shows nothing after Load** → no drafts for that tenant yet. Run a goal first (§6 step 1).
- **A goal routed to the "wrong" agent** → the router is keyword-based: topics containing *research/news/trend* → research; *outreach/pitch/lead/sell* → sales; *promote/awareness/event* → ambassador; everything else → marketing; `channel: "chat"` → customer_service. Reword the topic to steer it.
- **Instagram/TikTok drafts never publish** → intentional in v1; they stay `pending` until those channels go live.
- **Channel tokens** → paste via `POST /api/v1/channels`; they are AES-256-GCM encrypted at rest, never stored in plaintext.
