/**
 * Phase 13 — Analytics + Strategy workforce types (roadmap P12, §99/§102/§103).
 *
 * Two FSMs and one aggregate contract:
 *  - reports:      pending → ready | failed (a run either lands the digest or
 *                  fails loudly; a report is NEVER left silently stale).
 *  - strategy_recommendations: open → accepted | dismissed (both terminal;
 *                  the review stamp is immutable once terminal).
 *  - The §99 aggregate contract: platform payloads carry COUNTS AND SUMS
 *    ONLY. No type in this module has a field that could carry customer
 *    identity at platform scope — the per-BU breakdown is a list of
 *    aggregate rows, not rows of customers.
 */

export type ReportPeriodKind = "daily" | "weekly" | "monthly" | "on_demand";
export type ReportStatus = "pending" | "ready" | "failed";
export type RecommendationKind = "growth" | "efficiency" | "risk" | "content" | "budget";
export type RecommendationPriority = "low" | "medium" | "high";
export type RecommendationStatus = "open" | "accepted" | "dismissed";
export type InsightDirection = "up" | "down" | "flat" | "anomaly";
export type ReportCadence = "daily" | "weekly" | "monthly";

export const RECOMMENDATION_KINDS: readonly RecommendationKind[] = [
  "growth", "efficiency", "risk", "content", "budget",
];
export const RECOMMENDATION_PRIORITIES: readonly RecommendationPriority[] = [
  "low", "medium", "high",
];
export const INSIGHT_DIRECTIONS: readonly InsightDirection[] = [
  "up", "down", "flat", "anomaly",
];

/** Terminal states of the recommendation FSM — no transitions out. */
export const RECOMMENDATION_TERMINAL: readonly RecommendationStatus[] = ["accepted", "dismissed"];

export class AnalyticsServiceError extends Error {
  code: string;
  httpStatus: number;
  constructor(code: string, httpStatus: number, message: string) {
    super(message);
    this.name = "AnalyticsServiceError";
    this.code = code;
    this.httpStatus = httpStatus;
  }
}

/* ------------------------------------------------------------------ */
/* Records (read models — camelCase mirrors of the DB rows)            */
/* ------------------------------------------------------------------ */

export interface ReportRecord {
  id: number;
  businessUnitId: number | null;
  periodKind: ReportPeriodKind;
  periodKey: string;
  status: ReportStatus;
  title: string;
  summary: string | null;
  payload: Record<string, unknown>;
  narrative: Record<string, unknown> | null;
  generatedBy: "deterministic" | "llm" | null;
  degraded: boolean;
  taskId: number | null;
  promptVersion: number | null;
  promptHash: string | null;
  createdByUserId: number | null;
  metadata: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
}

export interface RecommendationRecord {
  id: number;
  businessUnitId: number | null;
  source: "report" | "analytics" | "strategy" | "manual";
  reportId: number | null;
  kind: RecommendationKind;
  priority: RecommendationPriority;
  title: string;
  detail: string;
  evidence: string[];
  status: RecommendationStatus;
  dedupHash: string;
  agentSlug: string;
  taskId: number | null;
  promptVersion: number | null;
  promptHash: string | null;
  reviewedBy: string | null;
  reviewedAt: string | null;
  createdByUserId: number | null;
  metadata: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
}

export interface ReportScheduleRecord {
  id: number;
  businessUnitId: number | null;
  cadence: ReportCadence;
  enabled: boolean;
  lastRunAt: string | null;
  createdAt: string;
  updatedAt: string;
}

/* ------------------------------------------------------------------ */
/* Aggregate payload contract (§99 — counts and sums ONLY)             */
/* ------------------------------------------------------------------ */

export interface MetricWindow {
  kind: ReportPeriodKind | "window";
  key: string;
  start: string; // ISO
  end: string;   // ISO
}

export interface AggregateMetrics {
  businessUnits: number;
  websites: number;
  users: number;
  leads: { total: number; newStage: number; qualified: number; won: number; lost: number; hotOpen: number };
  inquiries: { total: number; escalated: number; spam: number; resolved: number };
  conversations: { total: number; escalated: number };
  content: { items: number; inReview: number; approved: number; published: number };
  social: { posts: number; published: number; failed: number };
  campaigns: { active: number; completed: number };
  marketing: { impressions: number; clicks: number; conversions: number; spendUsd: number };
  llm: { requests: number; errors: number; promptTokens: number; completionTokens: number; costUsd: number };
  research: { findings: number; escalated: number };
  seo: { openRecommendations: number };
  tasks: { failed: number; escalated: number };
}

/** One row of the cross-BU breakdown — aggregates for EXACTLY one BU. */
export interface BuBreakdownRow {
  businessUnitId: number;
  businessUnitName: string;
  leads: number;
  hotLeads: number;
  inquiries: number;
  escalatedInquiries: number;
  contentItems: number;
  socialPosts: number;
  campaignSpendUsd: number;
  llmRequests: number;
  llmCostUsd: number;
}

export interface ReportPayload {
  window: MetricWindow;
  scope: "platform" | "bu";
  businessUnitId: number | null;
  metrics: AggregateMetrics;
  breakdown: BuBreakdownRow[] | null; // platform scope only (§99 owner surface)
  insights: InsightRecord[];
  provenance: {
    insightsBy: "deterministic" | "llm";
    narrativeBy: "deterministic" | "llm";
    recommendationsBy: "deterministic" | "llm";
    promptVersion: number;
    promptHash: string;
  };
}

export interface ReportNarrative {
  summary: string;
  highlights: string[];
  risks: string[];
}

export interface InsightRecord {
  metric: string;
  direction: InsightDirection;
  observation: string;
}

export interface RecommendationDraft {
  kind: RecommendationKind;
  priority: RecommendationPriority;
  title: string;
  detail: string;
  evidence: string[];
}
