/**
 * Knowledge ingestion v2 (Phase 5). Scope-stamped, metadata-stamped writing
 * path for documents + chunks. The legacy path (lib/rag/ingest.ts) is
 * untouched — checksum dedup semantics are PRESERVED here per the Phase 0.5
 * disposition, but scoped: the same text ingested under different BU/website
 * scopes is a DIFFERENT document (scope-blind dedup would leak by construction).
 *
 * Documents written here carry: knowledge_source_id (v2 lineage; legacy
 * source_id stays NULL), the full scope set (BU / website / jurisdiction /
 * language), authority tier, access level, legal dates, provenance JSONB and
 * agent_scopes. Chunks carry tsv (SQL-computed, same expression as migration
 * 025's backfill) and chunk_no (document order).
 */
import crypto from "node:crypto";
import { query } from "../db";
import { chunkStructured, chunkFlat } from "./chunking";
import type { AccessLevel, EmbedContext } from "./types";

export interface IngestKnowledgeDocParams {
  knowledgeSourceId: number;
  title: string;
  url?: string | null;
  text: string;
  /* scope stamp */
  businessUnitId?: number | null;
  websiteId?: number | null;
  jurisdiction?: string | null;
  country?: string | null;
  stateProvince?: string | null;
  courtSystem?: string | null;
  language?: string | null;
  documentType?: string | null;
  /* metadata stamp */
  accessLevel?: AccessLevel;
  authorityTier?: number;
  effectiveDate?: string | null;
  sourceDate?: string | null;
  sourceUrl?: string | null;
  provenance?: Record<string, unknown>;
  agentScopes?: string[];
  verificationStatus?: "unverified" | "verified" | "stale" | "contradicted";
  /* chunking strategy: structured (default) or legacy flat */
  chunking?: "structured" | "flat";
}

export interface IngestKnowledgeDocResult {
  documentId: number;
  chunkCount: number;
  /** true when the checksum dedup reused an existing document (no re-embed). */
  deduplicated: boolean;
}

export async function ingestKnowledgeDocument(
  ctx: EmbedContext,
  p: IngestKnowledgeDocParams
): Promise<IngestKnowledgeDocResult> {
  const checksum = crypto.createHash("sha256").update(p.text).digest("hex");
  const existing = await query<{ id: number; chunk_count: number }>(
    `SELECT d.id,
            (SELECT count(*)::int FROM chunks c WHERE c.document_id = d.id) AS chunk_count
     FROM documents d
     WHERE d.checksum = $1
       AND COALESCE(d.business_unit_id, 0) = COALESCE($2, 0)
       AND COALESCE(d.website_id, 0) = COALESCE($3, 0)
     LIMIT 1`,
    [checksum, p.businessUnitId ?? null, p.websiteId ?? null]
  );
  if (existing.length > 0) {
    return { documentId: existing[0].id, chunkCount: existing[0].chunk_count, deduplicated: true };
  }

  const chunks = p.chunking === "flat" ? chunkFlat(p.text) : chunkStructured(p.text);
  const embeddings = await ctx.embed(chunks);
  if (embeddings.length !== chunks.length) {
    throw new Error(`embed returned ${embeddings.length} vector(s) for ${chunks.length} input(s)`);
  }

  const tier = Math.min(5, Math.max(1, p.authorityTier ?? 3));
  const accessLevel = p.accessLevel ?? "internal";

  const docRows = await query<{ id: number }>(
    `INSERT INTO documents (
       tenant_id, source_id, title, url, checksum,
       business_unit_id, website_id, knowledge_source_id,
       jurisdiction, country, state_province, court_system, language, document_type,
       access_level, authority_tier, effective_date, source_date, source_url,
       provenance, verification_status, agent_scopes
     )
     VALUES (
       NULL, NULL, $1, $2, $3,
       $4, $5, $6,
       $7, $8, $9, $10, $11, $12,
       $13, $14, $15::date, $16::date, $17,
       $18::jsonb, $19, $20::jsonb
     )
     RETURNING id`,
    [
      p.title, p.url ?? null, checksum,
      p.businessUnitId ?? null, p.websiteId ?? null, p.knowledgeSourceId,
      p.jurisdiction ?? null, p.country ?? null, p.stateProvince ?? null, p.courtSystem ?? null,
      p.language ?? null, p.documentType ?? null,
      accessLevel, tier, p.effectiveDate ?? null, p.sourceDate ?? null, p.sourceUrl ?? null,
      JSON.stringify(p.provenance ?? {}), p.verificationStatus ?? "unverified",
      JSON.stringify(p.agentScopes ?? []),
    ]
  );
  const documentId = docRows[0].id;

  for (let i = 0; i < chunks.length; i++) {
    await query(
      `INSERT INTO chunks (document_id, tenant_id, content, embedding, tsv, chunk_no)
       VALUES ($1, NULL, $2, $3::vector, to_tsvector('english', $2), $4)`,
      [documentId, chunks[i], JSON.stringify(embeddings[i]), i]
    );
  }
  return { documentId, chunkCount: chunks.length, deduplicated: false };
}
