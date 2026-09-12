/**
 * Hybrid retrieval v2 (Phase 5 §9.3): filtered dual-leg retrieval.
 *
 *   Leg 1 (vector):  existing ivfflat cosine on chunks.embedding — unchanged.
 *   Leg 2 (keyword): chunks.tsv @@ websearch_to_tsquery('english', query),
 *                    ranked by ts_rank.
 *   Fusion:          reciprocal-rank fusion (k=60) over both leg rankings.
 *   Enforcement:     scopeWhere(scope) applies to BOTH legs AND is re-applied
 *                    on the final hydration query — a chunk can only reach a
 *                    caller through a scope-filtered plan, no exceptions.
 *
 * Resilience contract (proven by test + live): the keyword leg does not
 * depend on the embedding provider. When embeddings are unavailable
 * (provider outage, zero credits — the standing production condition during
 * Phase 5), retrieval degrades to keyword-only instead of failing. Embed
 * failures already ledger through the gateway when the client is attributed.
 */
import { query } from "../db";
import { scopeWhere } from "./scopes";
import type { EmbedContext, KnowledgeCitation, KnowledgeScope } from "./types";

const RRF_K = 60;

export interface HybridRetrieveParams {
  scope: KnowledgeScope;
  query: string;
  topK?: number;
  /** Candidates fetched per leg before fusion (default max(topK*4, 20)). */
  candidateLimit?: number;
}

export interface HybridRetrieveResult {
  citations: KnowledgeCitation[];
  legs: { vector: boolean; keyword: boolean };
}

interface HydratedRow {
  chunkId: number;
  content: string;
  documentId: number;
  title: string;
  authorityTier: number;
  accessLevel: string;
  jurisdiction: string | null;
  sourceUrl: string | null;
  documentUrl: string | null;
  effectiveDate: string | null;
  verificationStatus: string;
  provenance: Record<string, unknown> | null;
  agentScopes: string[] | null;
}

export async function hybridRetrieve(
  ctx: EmbedContext,
  p: HybridRetrieveParams
): Promise<KnowledgeCitation[]> {
  const { citations } = await hybridRetrieveDetailed(ctx, p);
  return citations;
}

export async function hybridRetrieveDetailed(
  ctx: EmbedContext,
  p: HybridRetrieveParams
): Promise<HybridRetrieveResult> {
  const topK = Math.max(1, Math.min(50, p.topK ?? 5));
  const limit = p.candidateLimit ?? Math.max(topK * 4, 20);
  const q = (p.query ?? "").trim();
  if (q === "") return { citations: [], legs: { vector: false, keyword: false } };

  const scope = p.scope;
  const baseParams: unknown[] = [];
  const where = scopeWhere(scope, baseParams);

  /* ---- Leg 1: keyword (never provider-dependent) ---- */
  let keywordIds: number[] = [];
  try {
    const kwParams = [...baseParams, q, limit];
    const rows = await query<{ id: number }>(
      `SELECT c.id
       FROM chunks c
       JOIN documents d ON d.id = c.document_id
       WHERE ${where} AND c.tsv @@ websearch_to_tsquery('english', $${kwParams.length - 1})
       ORDER BY ts_rank(c.tsv, websearch_to_tsquery('english', $${kwParams.length - 1})) DESC
       LIMIT $${kwParams.length}`,
      kwParams
    );
    keywordIds = rows.map((r) => Number(r.id));
  } catch {
    /* keyword leg is best-effort; final query below still applies scope */
  }

  /* ---- Leg 2: vector (provider-dependent, degradable) ---- */
  let vectorIds: number[] = [];
  let vectorLeg = false;
  try {
    const vecs = await ctx.embed([q]);
    if (vecs.length !== 1) {
      throw new Error(`embed returned ${vecs.length} vector(s) for 1 input`);
    }
    const vParams = [...baseParams, JSON.stringify(vecs[0]), limit];
    const rows = await query<{ id: number }>(
      `SELECT c.id
       FROM chunks c
       JOIN documents d ON d.id = c.document_id
       WHERE ${where}
       ORDER BY c.embedding <=> $${vParams.length - 1}::vector
       LIMIT $${vParams.length}`,
      vParams
    );
    vectorIds = rows.map((r) => Number(r.id));
    vectorLeg = true;
  } catch {
    /* degrade to keyword-only; the gateway ledger records the embed error */
  }

  const unionIds = Array.from(new Set([...vectorIds, ...keywordIds]));
  if (unionIds.length === 0) {
    return { citations: [], legs: { vector: vectorLeg, keyword: keywordIds.length > 0 } };
  }

  /* ---- Hydration with the scope filter RE-APPLIED (belt and braces) ---- */
  const hParams = [...baseParams, unionIds];
  const rows = await query<HydratedRow>(
    `SELECT c.id AS "chunkId", c.content, d.id AS "documentId", d.title,
            d.authority_tier AS "authorityTier", d.access_level AS "accessLevel",
            d.jurisdiction, d.source_url AS "sourceUrl", d.url AS "documentUrl",
            d.effective_date::text AS "effectiveDate",
            d.verification_status AS "verificationStatus",
            d.provenance, d.agent_scopes AS "agentScopes"
     FROM chunks c
     JOIN documents d ON d.id = c.document_id
     WHERE c.id = ANY($${hParams.length}::bigint[]) AND ${where}`,
    hParams
  );

  /* ---- Reciprocal-rank fusion ---- */
  const score = new Map<number, number>();
  const legHits = new Map<number, { vector: boolean; keyword: boolean }>();
  const accumulate = (ids: number[], leg: "vector" | "keyword") => {
    ids.forEach((id, index) => {
      score.set(id, (score.get(id) ?? 0) + 1 / (RRF_K + index + 1));
      const hit = legHits.get(id) ?? { vector: false, keyword: false };
      hit[leg] = true;
      legHits.set(id, hit);
    });
  };
  accumulate(vectorIds, "vector");
  accumulate(keywordIds, "keyword");

  const citations: KnowledgeCitation[] = rows
    .map((r) => ({
      chunkId: Number(r.chunkId),
      documentId: Number(r.documentId),
      title: r.title,
      content: r.content,
      score: score.get(Number(r.chunkId)) ?? 0,
      authorityTier: r.authorityTier,
      accessLevel: r.accessLevel,
      jurisdiction: r.jurisdiction,
      sourceUrl: r.sourceUrl,
      documentUrl: r.documentUrl,
      effectiveDate: r.effectiveDate,
      verificationStatus: r.verificationStatus,
      provenance: r.provenance ?? {},
      agentScopes: r.agentScopes ?? [],
      legs: legHits.get(Number(r.chunkId)) ?? { vector: false, keyword: false },
    }))
    .sort((a, b) => b.score - a.score || b.chunkId - a.chunkId)
    .slice(0, topK);

  return { citations, legs: { vector: vectorLeg, keyword: keywordIds.length > 0 } };
}
