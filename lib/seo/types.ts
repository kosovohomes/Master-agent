/**
 * SEO workforce types (Phase 9 — Phase 0.5 §80/§218/§464: SEO agent,
 * keyword intelligence, gap analysis, recommendations with approval flags).
 *
 * The seo_scan task produces two artifacts per run:
 *   - seo_keywords rows: the BU keyword store (harvested deterministically
 *     from research findings / content items / competitor material, enriched
 *     by the LLM when funded; manual entries ride the API).
 *   - seo_recommendations rows: actionable advice. EVERY recommendation
 *     carries evidence (citation of the research/source/data point that
 *     supports it) — the acceptance criterion is "recommendations appear
 *     with evidence", so the schema requires a non-empty evidence array.
 *
 * Approval flags: open → approved | dismissed, approved → done. The review
 * identity (reviewed_by / reviewed_at) is set transactionally on transition
 * and never overwritten afterwards (same class as §72 approval immutability).
 */

export type SeoKeywordIntent =
  | "informational"
  | "commercial"
  | "transactional"
  | "navigational";

export type SeoKeywordSource = "manual" | "research" | "content" | "scan";

export type SeoKeywordStatus = "active" | "retired";

export type SeoRecommendationKind =
  | "on_page"
  | "technical"
  | "content"
  | "keyword"
  | "gap";

export type SeoRecommendationStatus = "open" | "approved" | "dismissed" | "done";

export type SeoRisk = "low" | "medium" | "high";

export interface SeoKeywordDraft {
  keyword: string;
  intent?: SeoKeywordIntent;
  difficultyEst?: number;
  volumeEst?: number | null;
  url?: string | null;
  source?: SeoKeywordSource;
}

export interface SeoEvidence {
  /** What the evidence is: research finding title, site page, data point. */
  label: string;
  /** URL when the evidence lives on the web (research source, target page). */
  url?: string | null;
  /** One line on WHAT this evidence shows and why it supports the advice. */
  note: string;
  /** Optional provenance link into the platform (research_item id, etc.). */
  researchItemId?: number | null;
}

export interface SeoRecommendationDraft {
  kind: SeoRecommendationKind;
  title: string;
  detail: string;
  evidence: SeoEvidence[];
  risk?: SeoRisk;
  targetKind?: "page" | "site";
  targetUrl?: string | null;
}

/** LLM structured output for the analysis leg (seo_analysis_v1). */
export interface SeoAnalysis {
  ambiguous: boolean;
  keywords: Array<{
    keyword: string;
    intent?: SeoKeywordIntent;
    difficultyEst?: number;
    volumeEst?: number | null;
    url?: string | null;
  }>;
  recommendations: SeoRecommendationDraft[];
}

/** Structured-output schema enforced by completeJSON (subset validator). */
export const SEO_ANALYSIS_SCHEMA: Record<string, unknown> = {
  type: "object",
  required: ["ambiguous", "keywords", "recommendations"],
  properties: {
    ambiguous: { type: "boolean" },
    keywords: {
      type: "array",
      items: {
        type: "object",
        required: ["keyword"],
        properties: {
          keyword: { type: "string" },
          intent: {
            type: "string",
            enum: ["informational", "commercial", "transactional", "navigational"],
          },
          difficultyEst: { type: "number" },
          volumeEst: { type: ["number", "null"] },
          url: { type: ["string", "null"] },
        },
      },
    },
    recommendations: {
      type: "array",
      items: {
        type: "object",
        required: ["kind", "title", "detail", "evidence"],
        properties: {
          kind: {
            type: "string",
            enum: ["on_page", "technical", "content", "keyword", "gap"],
          },
          title: { type: "string" },
          detail: { type: "string" },
          risk: { type: "string", enum: ["low", "medium", "high"] },
          targetKind: { type: "string", enum: ["page", "site"] },
          targetUrl: { type: ["string", "null"] },
          evidence: {
            type: "array",
            items: {
              type: "object",
              required: ["label", "note"],
              properties: {
                label: { type: "string" },
                url: { type: ["string", "null"] },
                note: { type: "string" },
                researchItemId: { type: ["number", "null"] },
              },
            },
          },
        },
      },
    },
  },
};

export interface SeoScanResult {
  keywordsHarvested: number;
  keywordsStored: number;
  recommendations: number;
  duplicates: number;
  llmAnalysis: boolean;
  ambiguous: boolean;
  degraded: boolean;
  degradeReason?: string;
}

export interface SeoKeywordRow {
  id: number;
  businessUnitId: number;
  keyword: string;
  normalizedKeyword: string;
  intent: SeoKeywordIntent;
  position: number | null;
  previousPosition: number | null;
  volumeEst: number | null;
  difficultyEst: number | null;
  url: string | null;
  source: SeoKeywordSource;
  status: SeoKeywordStatus;
  taskId: number | null;
  firstSeenAt: string;
  lastSeenAt: string;
}

export interface SeoRecommendationRow {
  id: number;
  businessUnitId: number;
  targetKind: "page" | "site";
  targetUrl: string | null;
  kind: SeoRecommendationKind;
  title: string;
  detail: string;
  evidence: SeoEvidence[];
  status: SeoRecommendationStatus;
  risk: SeoRisk;
  dedupHash: string;
  agentSlug: string;
  taskId: number | null;
  promptVersion: number | null;
  promptHash: string | null;
  reviewedBy: string | null;
  reviewedAt: string | null;
  createdAt: string;
  updatedAt: string;
}
