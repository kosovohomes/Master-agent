/**
 * Research workforce types (Phase 7 — Phase 0.5 §6.2 P6, §52–§53, §59, §137).
 *
 * The workforce agents (research / intelligence / legal_intelligence /
 * competitor) all execute through ONE pipeline shape: plan → search →
 * fetch → analyze → store. Only the prompt (from agent_versions) and the
 * output schema differ per agent. Research items are the shared artifact;
 * competitor events are the competitor agent's additional output.
 */

export type ResearchAgentSlug = "research" | "intelligence" | "legal_intelligence" | "competitor";

export type ResearchItemStatus =
  | "unprocessed" // material collected; LLM unavailable → degraded mode (§144 containment)
  | "finding" // cited + scored, awaiting human review
  | "escalated" // ambiguous / low confidence → human attention (§109)
  | "verified" // human review: accepted
  | "rejected" // human review: rejected
  | "archived"; // human review: archived

export type ResearchCadence = "hourly" | "daily" | "weekly";

export interface ResearchSchedule {
  id: number;
  businessUnitId: number;
  agentSlug: ResearchAgentSlug;
  name: string;
  /** Topic template; {{date}} expands to the run date (YYYY-MM-DD). */
  topic: string;
  queries: string[];
  cadence: ResearchCadence;
  maxItems: number;
  enabled: boolean;
  lastRunAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface ResearchSource {
  /** Citation index used by the LLM ([1], [2], …). */
  index: number;
  title: string;
  url: string | null;
  snippet: string;
  fetchedAt: string | null;
  revision: string | null;
}

export interface CompetitorEventDraft {
  competitor: string;
  kind: "pricing" | "product" | "announcement" | "content" | "other";
  title: string;
  url?: string | null;
  citations?: number[];
}

export interface ResearchFinding {
  title: string;
  summary: string;
  score: number; // 0..100 relevance / materiality
  confidence: number; // 0..1
  ambiguous: boolean;
  implications?: string[];
  opportunities?: string[];
  risks?: string[];
  actions?: string[];
  competitorEvents?: CompetitorEventDraft[];
}

/** The structured-output schema every workforce agent must satisfy. */
export const FINDING_SCHEMA: Record<string, unknown> = {
  type: "object",
  required: ["title", "summary", "score", "confidence", "ambiguous"],
  properties: {
    title: { type: "string", minLength: 3, maxLength: 200 },
    summary: { type: "string", minLength: 20, maxLength: 4000 },
    score: { type: "integer", minimum: 0, maximum: 100 },
    confidence: { type: "number", minimum: 0, maximum: 1 },
    ambiguous: { type: "boolean" },
    implications: { type: "array", items: { type: "string" } },
    opportunities: { type: "array", items: { type: "string" } },
    risks: { type: "array", items: { type: "string" } },
    actions: { type: "array", items: { type: "string" } },
    competitorEvents: {
      type: "array",
      items: {
        type: "object",
        required: ["competitor", "kind", "title"],
        properties: {
          competitor: { type: "string", minLength: 1 },
          kind: { type: "string", enum: ["pricing", "product", "announcement", "content", "other"] },
          title: { type: "string", minLength: 1 },
          url: { type: ["string", "null"] },
          citations: { type: "array", items: { type: "integer" } },
        },
      },
    },
  },
};

export interface ResearchItem {
  id: number;
  businessUnitId: number;
  scheduleId: number | null;
  agentSlug: string;
  topic: string;
  query: string | null;
  status: ResearchItemStatus;
  title: string | null;
  summary: string | null;
  analysis: Record<string, unknown> | null;
  score: number | null;
  confidence: number | null;
  sources: ResearchSource[];
  material: string | null;
  promptVersion: number | null;
  promptHash: string | null;
  taskId: number | null;
  createdAt: string;
  updatedAt: string;
  reviewedAt: string | null;
  reviewedBy: string | null;
}

export interface Competitor {
  id: number;
  businessUnitId: number;
  name: string;
  url: string | null;
  notes: string | null;
  enabled: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface CompetitorEvent {
  id: number;
  businessUnitId: number;
  competitorId: number;
  kind: string;
  title: string;
  url: string | null;
  snapshot: Record<string, unknown> | null;
  researchItemId: number | null;
  detectedAt: string;
}

/** Result of one pipeline run (research_run task result payload). */
export interface ResearchRunResult {
  queries: string[];
  searched: number;
  fetched: number;
  collected: number;
  findings: number;
  escalated: number;
  unprocessed: number;
  duplicates: number;
  competitorEvents: number;
  degraded: boolean;
  degradeReason?: string;
}
