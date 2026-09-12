/**
 * Knowledge system v2 (Phase 5, Phase 0.5 §9) — shared types.
 *
 * Scope model (§9.1): GLOBAL → BUSINESS → WEBSITE → JURISDICTION → AGENT.
 * documents.business_unit_id NULL = global; website_id NULL = BU-wide;
 * jurisdiction NULL = unscoped content; agent_scopes '[]' = unrestricted.
 * Retrieval resolves the caller's scope set and applies ALL filters — an
 * agent never receives unscoped corpora (§16 becomes mechanically
 * enforceable; audit §9.4).
 */

export type AccessLevel = "public" | "internal" | "confidential";

export type KnowledgeSourceKind =
  | "sitemap"
  | "upload"
  | "api"
  | "rss"
  | "url"
  | "github"
  | "db";

export type RefreshFrequency = "manual" | "hourly" | "daily" | "weekly";

export type VerificationStatus = "unverified" | "verified" | "stale" | "contradicted";

/** The caller's resolved scope set (§9.1). All filters apply simultaneously. */
export interface KnowledgeScope {
  /** Caller's business unit. null/undefined = global-only caller. */
  businessUnitId?: number | null;
  /** Caller's website context. null = BU-wide caller (sees BU + website docs). */
  websiteId?: number | null;
  /** Agent identity for agent_scopes enforcement (empty = unrestricted docs only). */
  agentSlug?: string | null;
  /** Legal scope: docs from OTHER jurisdictions are excluded (§50–§51). */
  jurisdiction?: string | null;
  /** Language filter: docs in other languages excluded (§97). */
  language?: string | null;
  /** Highest authority tier to include: 1 (government/court) … 5 (unverified). */
  maxAuthorityTier?: number;
  /** Anonymous widget caller: only access_level='public' is retrievable. */
  publicOnly?: boolean;
  /** Effective-date filter: docs effective after this date are excluded. */
  asOfDate?: string | null;
  /**
   * Admin-only escape that skips the BU/website partition (search playground,
   * management screens). NEVER set for agent or public retrieval paths.
   */
  unrestricted?: boolean;
}

/** A retrieval result that carries tier + provenance (P5 acceptance). */
export interface KnowledgeCitation {
  chunkId: number;
  documentId: number;
  title: string;
  content: string;
  /** Reciprocal-rank-fusion score across the legs that returned this chunk. */
  score: number;
  authorityTier: number;
  accessLevel: AccessLevel | string;
  jurisdiction: string | null;
  /** Authoritative origin recorded on the document (legal/source of record). */
  sourceUrl: string | null;
  /** Page URL the content was fetched from. */
  documentUrl: string | null;
  effectiveDate: string | null;
  verificationStatus: string;
  provenance: Record<string, unknown>;
  agentScopes: string[];
  /** Which hybrid legs surfaced this chunk. */
  legs: { vector: boolean; keyword: boolean };
}

/** Injectable embedding context (same seam as lib/rag — test-proven). */
export interface EmbedContext {
  embed(texts: string[]): Promise<number[][]>;
}
