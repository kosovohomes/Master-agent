# Staging Environment Strategy (Phase 1 M3)

**Rule (owner-mandated):** tests and staging migrations must never point at the
production database. The production Neon endpoint is
`ep-patient-wildflower-aui4sh0g-pooler...neon.tech` — that host fragment is
hard-coded as a refusal marker in `tests/run-all.ts`, which aborts (exit 2)
unless `ALLOW_PROD_TESTS=1` is set explicitly.

## 1. Isolation model

| Environment | Database | Auth surface | Deploys |
|---|---|---|---|
| **Production** | Neon `neondb` (endpoint `...aui4sh0g...`) | Live users, real channel tokens | `main` via Vercel (`masteragent-nine.vercel.app`) |
| **Staging** | **Separate Neon database or branch** (below) | Throwaway users only | Vercel preview / staging project |
| **CI** | Ephemeral `pgvector/pgvector:pg16` service container (`.github/workflows/ci.yml`) | Fake constants from workflow env | none |

## 2. Creating the separate staging database (Neon)

Pick one; both satisfy "separate database":

**Option A — Neon branch (recommended):** in the Neon console, branch
`neondb` → `neondb-staging`. Branches copy schema + data at branch time and
are cheap on the free plan. Copy the branch's pooled `DATABASE_URL`.

**Option B — second database in the same project:**
`CREATE DATABASE agentos_staging;` run against the direct (non-pooler)
endpoint. It starts empty; run `npx tsx scripts/migrate.ts` (or
`POST /api/admin/migrate`) against it to bring it to the current ledger.

## 3. Staging deploy on Vercel

1. Import the same repo as a **second Vercel project** (e.g. `masteragent-staging`)
   — do **not** add the staging DATABASE_URL to the production project.
2. Set environment variables for the staging project only (all values fake or
   staging-scoped): `DATABASE_URL` (staging), `OPENAI_API_KEY`
   (a restricted/funded-for-staging key), `CHANNEL_ENC_KEY` (fresh 64-hex,
   **different from production**), `ADMIN_PASSWORD`, `CRON_SECRET`, `OPS_TOKEN`,
   `NEXT_PUBLIC_APP_URL=https://<staging-alias>.vercel.app`, plus Resend/email
   values if exercised.
3. Deploy, then bootstrap: `POST /api/admin/migrate` → `POST /api/admin/bootstrap`
   with the first owner → log into `/login`.
4. Optional: Vercel "Preview" deployments from feature branches may point at
   the staging database by setting project-level preview env vars — never
   production ones.

## 4. Verification checklist (any staging refresh)

- [ ] `GET /api/admin/env-check` shows the staging `DATABASE_URL` host, not the
      production `aui4sh0g` endpoint
- [ ] `schema_migrations` ledger is present and ordered (11 versions after Phase 1)
- [ ] Login works against a staging user; no production user emails exist
- [ ] `POST /api/admin/seed` produces the demo tenant + mapped BU + website
- [ ] Widget config for the staging tenant returns 200
- [ ] Emergency flags (`stop_all_agents`, `disable_publishing`) are OFF

## 5. Local integration tests

`npm test` reads `.env.local` (see `.env.example`). For local runs use the
same ephemeral pattern CI uses: a disposable Postgres with pgvector
(`docker run -p 5432:5432 -e POSTGRES_PASSWORD=agentos_ci pgvector/pgvector:pg16`
or an embedded extraction as used during Phase 1 development), then
`npx tsx scripts/migrate.ts && npx tsx tests/run-all.ts`. The suite mutates
data by design — that is why it refuses production hosts up front.
