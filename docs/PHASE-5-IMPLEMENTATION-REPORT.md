# Phase 5 Implementation Report — Knowledge System v2

**Repo:** kosovohomes/Master-agent · **HEAD at report:** `0dc96eb` (feat `921ec51` + CI fix) · **CI:** green (typecheck + 33 suites + build, ephemeral pgvector Postgres) · **Production:** READY at masteragent-nine.vercel.app, migrations 023–026 applied (ledger 27, legacy 11/11 intact)

---

## 1. Scope delivered

Phase 5 (Phase 0.5 §9, §11 P5) replaces the tenant-only RAG with a **five-scope knowledge system** — GLOBAL → BUSINESS → WEBSITE → JURISDICTION → AGENT — plus the legal/authority/language/lifecycle metadata contract (§9.2), real fetchers, structure-aware chunking, filtered hybrid retrieval, and a knowledge admin surface. The Phase 0 audit's standing finding "content_sources declares kinds no code fetches" is closed.

Preserved verbatim (test-proven, per §9.3): pgvector + ivfflat, checksum dedup + embed-count guards, grounding prompt + `{answer, sources[]}` shape, injectable `ctx.embed` seam, legacy tenant-scoped retrieval as the rollback path.

## 2. Migrations 023–026 (additive, idempotent, ledger-verified)

| Version | Name | Content |
|---|---|---|
| 023 | knowledge_sources | Source registry: scope columns (business_unit_id NULL = global, website_id NULL = BU-wide), kind CHECK expanded to 7 kinds, authority_level 1–5, jurisdiction/state_province/country, language, document_type, access_level, refresh_frequency, max_documents, status, metadata, last_checked. Backfill from content_sources via the 1:1 tenant→BU map — **mapped rows only**; unmapped legacy sources stay out rather than silently becoming global. content_sources itself untouched (rename/view swap deferred to the cleanup phase, same decision as Phase 4). |
| 024 | documents_scoping | documents gains business_unit_id, website_id, knowledge_source_id, jurisdiction, country, state_province, court_system, language, document_type, access_level (default internal), authority_tier (default 3, CHECK 1–5), effective_date, source_date, source_url, provenance JSONB, verification_status, agent_scopes JSONB. tenant_id/source_id become optional (v2 writes knowledge_source_id instead) — **no data touched**. Backfill maps existing documents onto their BU and stamps access_level='public' (legacy widget chat was public-by-design → behavior preserved when the flag flips ON). Indexes on BU / website / jurisdiction / checksum. agent_runs.citations JSONB added. |
| 025 | chunks_hybrid | chunks.tsv tsvector + chunk_no INT; backfill `to_tsvector('english', content)` (the exact expression the write path uses — the two can never drift); GIN index on tsv; (document_id, chunk_no) index. |
| 026 | knowledge_flag_permissions | `knowledge_v2` feature flag (non-emergency) + `knowledge.manage` permission granted to owner + administrator. |

Live: `applied: ["023 knowledge_sources","024 documents_scoping","025 chunks_hybrid","026 knowledge_flag_permissions"]`, re-run = zero applied.

## 3. The scope model, mechanically enforced (§9.1 → §16)

`lib/knowledge/scopes.ts` builds a fully parameterized WHERE fragment applied to **both retrieval legs and re-applied on final hydration** (belt and braces):

- **GLOBAL:** `business_unit_id IS NULL` is visible to every caller; a BU-less caller sees ONLY global docs.
- **BUSINESS:** caller BU sees global + own; never another BU's corpus.
- **WEBSITE:** `website_id IS NULL OR website_id = caller` — a BU-wide caller sees website-scoped docs (it serves them); a website caller sees BU-wide + own site.
- **JURISDICTION:** `jurisdiction IS NULL OR jurisdiction = caller` — law from jurisdiction X is never returned for Y (§50–§51).
- **AGENT:** `agent_scopes = '[]' OR agent_scopes ? caller-slug` — agent-restricted material is invisible to other agents.
- Plus: authority ceiling (`authority_tier <= max`, 1 = government/court … 5 = unverified), `access_level = 'public'` hard filter for anonymous callers, language filter, effective-date as-of filter, and an admin-only `unrestricted` escape that agent/public paths can never set.

## 4. Hybrid retrieval (`lib/knowledge/retrieve.ts`)

- **Leg 1 — vector:** unchanged ivfflat cosine.
- **Leg 2 — keyword:** `chunks.tsv @@ websearch_to_tsquery('english', q)` ranked by `ts_rank`.
- **Fusion:** reciprocal-rank fusion (k=60); dual-leg chunks outrank single-leg chunks by construction.
- **Scope:** applied to both legs AND the hydration query — a chunk can only reach a caller through a scope-filtered plan.
- **Degradation contract (proven live-relevant):** the keyword leg has zero provider dependency. When embeddings fail (provider outage, or the current zero-credits state), retrieval degrades to keyword-only instead of failing; the gateway ledger records the embed error independently.
- Empty query → no calls; topK capped; citation rows carry title, content, score, tier, access level, jurisdiction, sourceUrl, documentUrl, effectiveDate, verificationStatus, provenance, agentScopes, and per-chunk leg attribution.

## 5. Structure-aware chunking (`lib/knowledge/chunking.ts`)

Replaces blind 800-char slicing for v2 ingests (the legacy slicer is retained untouched for the legacy path and as `chunkFlat`): headings stay attached to their sections; paragraphs pack up to targetSize (default 800, same scale as legacy); oversized blocks hard-split on word boundaries (CJK-safe fallback); consecutive chunks share a word-snapped overlap tail (default 150 chars) so clauses cut at a boundary remain retrievable; undersized tails merge back; empty input still yields exactly one chunk (legacy contract). `chunk_no` preserves document order.

## 6. Real fetchers (`lib/knowledge/fetchers.ts`)

URL / sitemap (incl. one-level index expansion, asset-URL filtering, partial-success semantics) / RSS (+Atom `<entry>`) fetchers: AbortController timeout, content-type guard, 500 KB byte cap, per-page error collection (one bad page never fails a sitemap run), and **provenance stamps** on every fetched doc: fetchedAt, crawlerId (`agentos-knowledge-v1`), sourceRef, content revision hash, bytes. `upload`/`github`/`db` kinds are explicitly refused with a clear error (they arrive through other channels) — no silent pretend-success.

## 7. Scope-safe ingestion (`lib/knowledge/ingest.ts`)

Checksum dedup logic preserved (§9.3) but **scoped**: dedup key = (checksum, COALESCE(bu,0), COALESCE(website,0)) — the same text ingested under different BUs is a *different document*, because scope-blind dedup would leak by construction. Documents carry the full scope + metadata stamp from their source; chunks carry tsv (SQL-computed) + chunk_no. Embed-count guard identical to legacy (fail loudly before any DB bind).

## 8. Source lifecycle + durable refresh

- `runSourceFetch` (service): disabled sources refuse; fetch failures mark the source `error` with the reason in `metadata.lastRun` and rethrow (task backoff handles transience); per-document failures are *collected* (partial success still records what it got); success sets `last_checked`, `status='active'`, and a full lastRun summary.
- `knowledge_fetch` task handler (Phase 3 machinery reused): steps load → fetch_and_ingest → emit; emits `knowledge.source.fetched` (counts) / `knowledge.source.failed` on the event bus; embeddings ride the gateway with BU attribution (`purpose=knowledge_ingest`) so ingest spend is budget-enforced and ledgered.
- Scheduled refresh: the daily cron sweep now spawns due-source fetches (`hourly`/`daily`/`weekly` vs `last_checked`; manual never auto-runs) with per-source-per-day idempotency keys — gated by `knowledge_v2`, so the rollback hatch covers scheduling too.

## 9. Research grounding — citations carry tier + provenance (P5 acceptance)

`/api/agents/run` passes a scoped retriever to dispatch when `knowledge_v2` is ON; dispatch resolves the researcher's scope set (BU + `agent_slug='research'`), retrieves top-5 passages, injects them into the brief prompt as cited context (`[title — authority tier Tn]`), and persists the full citation objects (tier + provenance) on `agent_runs.citations` and in the API response. Retrieval failure degrades to an ungrounded run — never a crash. Flag OFF = the retriever is not passed and dispatch behaves exactly as in Phase 4.

## 10. Chat path

`knowledge_v2` ON: the widget chat retrieves through the hybrid engine with scope `{businessUnitId, agentSlug:'customer_service', publicOnly:true}` — anonymous visitors can only ever receive public docs of their own BU (plus globals). `answerChat` sources now include authorityTier, sourceUrl, jurisdiction, verificationStatus, provenance (additive JSON; widget ignores unknown fields). OFF: the legacy tenant-only retriever, byte-identical behavior.

## 11. Admin surface

- APIs (knowledge.manage; reads also audit.read): `GET/POST /api/admin/knowledge`, `PATCH/DELETE /api/admin/knowledge/[id]`, `POST /api/admin/knowledge/[id]/fetch` (spawns the durable task, idempotency-keyed), `GET /api/admin/knowledge/documents` (browse + scoped retrieval playground). All mutations audited.
- `/knowledge` Command Center screen: sources table (scope, tier, access, refresh, status, last_checked + lastRun summary), create form (kind/ref/BU/jurisdiction/language/tier/access/refresh), Fetch now / Enable / Disable / Delete, and a **retrieval playground** that previews exactly what a scoped caller would receive — with tier + provenance badges and leg attribution per citation.
- Nav entry visible with knowledge.manage or audit.read.

## 12. Tests — 33 suites (was 29), all green

New suites:
1. **knowledge-chunking** (pure): heading attachment, packing bounds, word-boundary hard splits, overlap tails (+disable switch), tail merge, CJK, flat parity.
2. **knowledge-fetchers**: fake-fetch driven URL/sitemap(index)/RSS parsing, title/text/entity handling, provenance stamps, HTTP/content-type/empty failure paths, kind refusal, and the full `runSourceFetch` roundtrip on real DB (scope stamps, provenance, lastRun, dedup, error marking) + scheduler spawn rules and same-day idempotency.
3. **knowledge-scopes** — THE LEAK SUITE (P5 acceptance): BU isolation both directions; global-only caller; website refinement; **US law never answers UK queries and vice versa**; agent_scopes enforcement (marketing never sees research-only material); public-only access (internal margins invisible to anonymous callers); authority ceiling; admin unrestricted; scope-safe dedup; hydration re-check.
4. **knowledge-retrieval**: dual-leg fusion + RRF ordering property, citation tier+provenance/access/verification fields, **keyword-only degradation under provider failure**, chunk_no contract, tsv-on-write contract, topK/empty-query, scope enforcement through the hybrid engine, dedup-with-zero-embed.

Adjusted: `migrations-tests` flag-seed count 4→5; `dispatch-tests` pins knowledge_v2 OFF for the legacy route contract and adds a positive grounding contract (flag ON ⇒ exactly one extra provider embed call + citations array in the result).

## 13. CI history

- Round 1 (`921ec51`): 2 failures in dispatch-tests — the route test counted provider fetches while the new `knowledge_v2` flag (seeded ON) legitimately added a grounding embed call.
- Round 2 (`0dc96eb`): **GREEN** — typecheck + 33 suites + build.

## 14. Production deployment + live acceptance

Deploy `agentos-ifekeup99` → alias masteragent-nine.vercel.app, READY. Migrations applied (ledger 27; legacy 11/11). Verified live:

- Owner session shows `knowledge.manage`; legacy source backfilled as knowledge_sources #1 (kind api, ref seed-demo, BU 1).
- Source #2 created via API (url, BU 1, public, T2, jurisdiction US, daily).
- Fetch task #7 spawned idempotently, claimed by the engine, **fetched https://example.com over real HTTP from production**, stamped provenance, and — with zero OpenAI credits — recorded the ingest failure with exact attribution (`llm 429: credit_balance_exhausted`) in the task result, set source metadata lastRun, and emitted `knowledge.source.fetched` on the event bus with full counts. Task SUCCEEDED with collected errors (partial-success design working as specified).
- Playground + documents APIs verified (empty corpus → empty result; browse returns 0 documents — consistent: production has never had a successfully ingested document; see §15).
- **Flag rollback proven live:** knowledge_v2 OFF → playground returns 409 `KNOWLEDGE_V2_DISABLED`; ON → restored. Two audited `settings.flag` entries.
- Audit trail: knowledge.source.create / knowledge.fetch / knowledge.source.update all recorded success.
- Regressions: /knowledge, /gateway, /operations, /agents, /settings all 200 with owner session; widget config 200; public endpoints fail closed as before.
- Source #2 set to `manual` refresh so the daily cron will not retry the (currently impossible) ingest until the OpenAI key is funded.

## 15. The standing blocker, now precisely instrumented

Production has **zero ingested documents** — the Phase 0-era demo seed also failed at the embed step (429), which is only now visible because Phase 5 makes every step observable. Consequence chain: fetch works (proven live) → embed requires credits → ingest stops → retrieval corpus empty (the keyword leg itself needs no provider, but there is nothing to retrieve yet). The moment the OpenAI key has credits: press "Fetch now" on source #2 (or set it back to daily) → documents appear with tier + provenance → playground, widget chat grounding, and research briefs go live end-to-end with zero further deploys.

## 16. Rollback map

- `knowledge_v2` OFF: chat + research use the legacy tenant-only path; scheduling stops spawning. Zero code change, ≤1-run propagation.
- Per-source `status='disabled'`: individual sources stop fetching without touching others.
- All migrations additive: no renames, no drops, no data loss; legacy tables 11/11 untouched.

## 17. Deferred (recorded)

- documents/knowledge_sources → knowledge_documents rename + content_sources VIEW swap (cleanup phase with DROP privileges, owner sign-off — same bucket as tenants→VIEW + outbox drop).
- PDF/DOCX/CSV fetchers (roadmap "next" after URL/sitemap/RSS).
- tsvector GIN weighting (A/B/C/D) + trigram fuzzy leg — retrievable upgrade once a real corpus exists to tune against.
- Events API projection: business_unit_id not yet exposed on event rows (internal field; visible via DB).

## 18. Next per roadmap

Phase 6 — website connector strategy: connector contract + capability grants enforcement, signed inbound webhook (`/api/integrations/:siteId/events`), site content synced as knowledge sources reusing this phase's fetch/ingest machinery.
