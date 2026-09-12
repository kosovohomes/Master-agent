/**
 * Knowledge source registry service (Phase 5): CRUD over knowledge_sources
 * plus runSourceFetch — the fetch → ingest → status machine that makes a
 * source declaration actually produce documents (the gap the Phase 0 audit
 * flagged: "content_sources declares kinds no code fetches").
 *
 * runSourceFetch semantics:
 *   - disabled sources refuse to run; kind-not-fetchable and fetch failures
 *     mark the source 'error' with the reason in metadata.lastRun, then
 *     rethrow (task retries/backoff handle transience).
 *   - Per-document failures (empty text, embed mismatch) are COLLECTED — a
 *     partially failing fetch still records what it got (partial success).
 *   - Success updates last_checked + metadata.lastRun and stamps provenance
 *     per document; checksum dedup reports as deduplicated (no re-embed).
 */
import { query } from "../db";
import { spawnTask } from "../tasks/queue";
import { ingestKnowledgeDocument } from "./ingest";
import type { EmbedContext, KnowledgeSourceKind, AccessLevel, RefreshFrequency } from "./types";
import type { FetchedDoc, KnowledgeFetcher } from "./fetchers";

export interface KnowledgeSourceRow {
  id: number;
  businessUnitId: number | null;
  websiteId: number | null;
  kind: KnowledgeSourceKind;
  ref: string;
  title: string;
  description: string;
  authorityLevel: number;
  jurisdiction: string | null;
  stateProvince: string | null;
  country: string | null;
  language: string | null;
  documentType: string | null;
  accessLevel: AccessLevel;
  refreshFrequency: RefreshFrequency;
  maxDocuments: number;
  status: "active" | "disabled" | "error";
  metadata: Record<string, unknown>;
  lastChecked: string | null;
  createdAt: string;
  updatedAt: string;
}

function mapSource(r: any): KnowledgeSourceRow {
  return {
    id: r.id,
    businessUnitId: r.business_unit_id ?? null,
    websiteId: r.website_id ?? null,
    kind: r.kind,
    ref: r.ref,
    title: r.title ?? "",
    description: r.description ?? "",
    authorityLevel: r.authority_level,
    jurisdiction: r.jurisdiction ?? null,
    stateProvince: r.state_province ?? null,
    country: r.country ?? null,
    language: r.language ?? null,
    documentType: r.document_type ?? null,
    accessLevel: r.access_level,
    refreshFrequency: r.refresh_frequency,
    maxDocuments: r.max_documents,
    status: r.status,
    metadata: r.metadata ?? {},
    lastChecked: r.last_checked ?? null,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

const SOURCE_COLUMNS = `id, business_unit_id, website_id, kind, ref, title, description,
  authority_level, jurisdiction, state_province, country, language, document_type,
  access_level, refresh_frequency, max_documents, status, metadata, last_checked,
  created_at, updated_at`;

export async function listKnowledgeSources(businessUnitId?: number | null): Promise<KnowledgeSourceRow[]> {
  const rows = businessUnitId != null
    ? await query<any>(`SELECT ${SOURCE_COLUMNS} FROM knowledge_sources WHERE business_unit_id = $1 OR business_unit_id IS NULL ORDER BY id ASC`, [businessUnitId])
    : await query<any>(`SELECT ${SOURCE_COLUMNS} FROM knowledge_sources ORDER BY id ASC`);
  return rows.map(mapSource);
}

export async function getKnowledgeSource(id: number): Promise<KnowledgeSourceRow | null> {
  const rows = await query<any>(`SELECT ${SOURCE_COLUMNS} FROM knowledge_sources WHERE id = $1`, [id]);
  return rows.length > 0 ? mapSource(rows[0]) : null;
}

export interface CreateKnowledgeSourceParams {
  businessUnitId?: number | null;
  websiteId?: number | null;
  kind: KnowledgeSourceKind;
  ref: string;
  title?: string;
  description?: string;
  authorityLevel?: number;
  jurisdiction?: string | null;
  stateProvince?: string | null;
  country?: string | null;
  language?: string | null;
  documentType?: string | null;
  accessLevel?: AccessLevel;
  refreshFrequency?: RefreshFrequency;
  maxDocuments?: number;
}

export class KnowledgeSourceError extends Error {
  code: string;
  constructor(code: string, message: string) {
    super(message);
    this.code = code;
    this.name = "KnowledgeSourceError";
  }
}

export async function createKnowledgeSource(p: CreateKnowledgeSourceParams): Promise<KnowledgeSourceRow> {
  const ref = (p.ref ?? "").trim();
  if (ref === "") throw new KnowledgeSourceError("REF_REQUIRED", "source ref (URL or identifier) is required");
  const kinds: string[] = ["sitemap", "upload", "api", "rss", "url", "github", "db"];
  if (!kinds.includes(p.kind)) throw new KnowledgeSourceError("INVALID_KIND", `unknown kind: ${p.kind}`);
  const authority = p.authorityLevel ?? 3;
  if (!Number.isInteger(authority) || authority < 1 || authority > 5) {
    throw new KnowledgeSourceError("INVALID_AUTHORITY", "authorityLevel must be an integer 1..5");
  }
  const maxDocs = p.maxDocuments ?? 10;
  if (!Number.isInteger(maxDocs) || maxDocs < 1 || maxDocs > 200) {
    throw new KnowledgeSourceError("INVALID_MAX_DOCS", "maxDocuments must be an integer 1..200");
  }
  const rows = await query<{ id: number }>(
    `INSERT INTO knowledge_sources
       (business_unit_id, website_id, kind, ref, title, description, authority_level,
        jurisdiction, state_province, country, language, document_type, access_level,
        refresh_frequency, max_documents)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15)
     RETURNING id`,
    [
      p.businessUnitId ?? null, p.websiteId ?? null, p.kind, ref, p.title ?? ref, p.description ?? "",
      authority, p.jurisdiction ?? null, p.stateProvince ?? null, p.country ?? null,
      p.language ?? null, p.documentType ?? null, p.accessLevel ?? "internal",
      p.refreshFrequency ?? "manual", maxDocs,
    ]
  ).catch((e) => {
    if ((e as { code?: string }).code === "23503") {
      throw new KnowledgeSourceError("UNKNOWN_SCOPE", "unknown business unit or website id");
    }
    throw e;
  });
  const created = await getKnowledgeSource(rows[0].id);
  if (!created) throw new KnowledgeSourceError("VANISHED", "source vanished after insert");
  return created;
}

export interface UpdateKnowledgeSourceParams {
  title?: string;
  description?: string;
  authorityLevel?: number;
  jurisdiction?: string | null;
  stateProvince?: string | null;
  country?: string | null;
  language?: string | null;
  documentType?: string | null;
  accessLevel?: AccessLevel;
  refreshFrequency?: RefreshFrequency;
  maxDocuments?: number;
  status?: "active" | "disabled" | "error";
  websiteId?: number | null;
}

export async function updateKnowledgeSource(id: number, p: UpdateKnowledgeSourceParams): Promise<KnowledgeSourceRow | null> {
  if (p.authorityLevel !== undefined && (!Number.isInteger(p.authorityLevel) || p.authorityLevel < 1 || p.authorityLevel > 5)) {
    throw new KnowledgeSourceError("INVALID_AUTHORITY", "authorityLevel must be an integer 1..5");
  }
  const sets: string[] = [];
  const params: unknown[] = [id];
  const add = (col: string, val: unknown) => {
    params.push(val);
    sets.push(`${col} = $${params.length}`);
  };
  if (p.title !== undefined) add("title", p.title);
  if (p.description !== undefined) add("description", p.description);
  if (p.authorityLevel !== undefined) add("authority_level", p.authorityLevel);
  if (p.jurisdiction !== undefined) add("jurisdiction", p.jurisdiction);
  if (p.stateProvince !== undefined) add("state_province", p.stateProvince);
  if (p.country !== undefined) add("country", p.country);
  if (p.language !== undefined) add("language", p.language);
  if (p.documentType !== undefined) add("document_type", p.documentType);
  if (p.accessLevel !== undefined) add("access_level", p.accessLevel);
  if (p.refreshFrequency !== undefined) add("refresh_frequency", p.refreshFrequency);
  if (p.maxDocuments !== undefined) add("max_documents", p.maxDocuments);
  if (p.status !== undefined) add("status", p.status);
  if (p.websiteId !== undefined) add("website_id", p.websiteId);
  if (sets.length === 0) return getKnowledgeSource(id);
  sets.push("updated_at = now()");
  await query(`UPDATE knowledge_sources SET ${sets.join(", ")} WHERE id = $1`, params);
  return getKnowledgeSource(id);
}

export async function deleteKnowledgeSource(id: number): Promise<boolean> {
  const rows = await query<{ id: number }>("DELETE FROM knowledge_sources WHERE id = $1 RETURNING id", [id]);
  return rows.length > 0;
}

/* ------------------------------------------------------------------ */
/* fetch → ingest run                                                  */
/* ------------------------------------------------------------------ */

export interface FetchRunResult {
  sourceId: number;
  kind: string;
  fetched: number;
  ingested: number;
  deduplicated: number;
  chunkCount: number;
  errors: string[];
}

async function markSourceError(id: number, error: string): Promise<void> {
  await query(
    `UPDATE knowledge_sources
     SET status = 'error', last_checked = now(), updated_at = now(),
         metadata = metadata || $2::jsonb
     WHERE id = $1`,
    [id, JSON.stringify({ lastRun: { at: new Date().toISOString(), error: String(error).slice(0, 1000) } })]
  );
}

export async function runSourceFetch(
  sourceId: number,
  deps: { fetcher: KnowledgeFetcher; embed: EmbedContext }
): Promise<FetchRunResult> {
  const src = await getKnowledgeSource(sourceId);
  if (!src) throw new KnowledgeSourceError("NOT_FOUND", `knowledge source not found: ${sourceId}`);
  if (src.status === "disabled") {
    throw new KnowledgeSourceError("SOURCE_DISABLED", `knowledge source ${sourceId} is disabled`);
  }

  let docs: FetchedDoc[];
  try {
    docs = await deps.fetcher.fetchForKind(src.kind, src.ref, src.maxDocuments);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    await markSourceError(src.id, msg);
    throw new Error(`knowledge fetch failed for source ${src.id} (${src.kind} ${src.ref}): ${msg}`);
  }

  const errors: string[] = [];
  let ingested = 0;
  let deduplicated = 0;
  let chunkCount = 0;
  for (const doc of docs) {
    if (doc.text.trim() === "") {
      errors.push(`empty content: ${doc.url ?? doc.title}`);
      continue;
    }
    try {
      const r = await ingestKnowledgeDocument(deps.embed, {
        knowledgeSourceId: src.id,
        title: (doc.title || doc.url || "untitled").slice(0, 300),
        url: doc.url,
        text: doc.text,
        businessUnitId: src.businessUnitId,
        websiteId: src.websiteId,
        jurisdiction: src.jurisdiction,
        country: src.country,
        stateProvince: src.stateProvince,
        language: src.language,
        documentType: src.documentType,
        accessLevel: src.accessLevel,
        authorityTier: src.authorityLevel,
        sourceUrl: src.ref,
        provenance: doc.provenance,
        chunking: "structured",
      });
      if (r.deduplicated) {
        deduplicated++;
      } else {
        ingested++;
        chunkCount += r.chunkCount;
      }
    } catch (e) {
      errors.push(`ingest failed for "${doc.title.slice(0, 80)}": ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  await query(
    `UPDATE knowledge_sources
     SET status = 'active', last_checked = now(), updated_at = now(),
         metadata = metadata || $2::jsonb
     WHERE id = $1`,
    [src.id, JSON.stringify({
      lastRun: {
        at: new Date().toISOString(),
        fetched: docs.length,
        ingested,
        deduplicated,
        chunkCount,
        errors: errors.slice(0, 20),
      },
    })]
  );

  return { sourceId: src.id, kind: src.kind, fetched: docs.length, ingested, deduplicated, chunkCount, errors };
}

/* ------------------------------------------------------------------ */
/* scheduled refresh (cron-driven)                                     */
/* ------------------------------------------------------------------ */

/**
 * Spawn knowledge_fetch tasks for every ACTIVE source whose refresh_frequency
 * is due (hourly/daily/weekly vs last_checked; manual sources never auto-run).
 * Called by the daily cron sweep — hourly sources effectively refresh daily
 * (cron granularity), weekly sources only on the day they fall due.
 *
 * Idempotency: per-source-per-day key (`knowledge_fetch:<id>:<yyyy-mm-dd>`)
 * — a duplicate cron run never double-spawns, and tomorrow gets a fresh key.
 * Dedup of CONTENT is handled independently by checksums at ingest time.
 */
export async function spawnDueKnowledgeFetches(dayKey = new Date().toISOString().slice(0, 10)): Promise<{ due: number; spawned: number; taskIds: number[] }> {
  const dueRows = await query<{ id: number; business_unit_id: number | null }>(
    `SELECT id, business_unit_id FROM knowledge_sources
     WHERE status = 'active' AND refresh_frequency <> 'manual'
       AND (
         (refresh_frequency = 'hourly' AND (last_checked IS NULL OR last_checked < now() - interval '1 hour'))
         OR (refresh_frequency = 'daily' AND (last_checked IS NULL OR last_checked < now() - interval '1 day'))
         OR (refresh_frequency = 'weekly' AND (last_checked IS NULL OR last_checked < now() - interval '7 days'))
       )`
  );
  const taskIds: number[] = [];
  for (const row of dueRows) {
    const { taskId, created } = await spawnTask({
      businessUnitId: row.business_unit_id,
      kind: "knowledge_fetch",
      payload: { knowledgeSourceId: row.id },
      idempotencyKey: `knowledge_fetch:${row.id}:${dayKey}`,
      createdBy: "cron",
    });
    if (created) taskIds.push(taskId);
  }
  return { due: dueRows.length, spawned: taskIds.length, taskIds };
}
