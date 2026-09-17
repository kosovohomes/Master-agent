/**
 * Phase 12 — Sales + customer workforce types (roadmap P11, audit §909).
 *
 * Two FSMs + the §55 classification contract:
 *   INQUIRY_FLOW  new → classified → escalated → resolved | dismissed
 *                 (escalated is a WORKING state — a human engagement
 *                 signal, not a terminal one; §55 "escalation")
 *   LEAD_FLOW     new → qualified → engaged → proposal → won | lost
 *
 * Lead stages only move forward until a terminal stage (won/lost) — the
 * pipeline models a sales funnel; regression ("un-qualify") is a human
 * correction done via metadata notes, not a stage transition.
 */

export type InquiryStatus = "new" | "classified" | "escalated" | "resolved" | "dismissed";
export type LeadStage = "new" | "qualified" | "engaged" | "proposal" | "won" | "lost";
export type InquiryClassification = "sales" | "support" | "spam" | "general";
export type InquiryUrgency = "low" | "medium" | "high";
export type ScoreBand = "cold" | "warm" | "hot";
export type ClassifySource = "llm" | "deterministic" | "human";
export type ScoreSource = "llm" | "deterministic";

export const INQUIRY_FLOW: Record<InquiryStatus, InquiryStatus[]> = {
  new: ["classified", "escalated", "dismissed"],
  classified: ["escalated", "resolved", "dismissed"],
  escalated: ["resolved", "dismissed"],
  resolved: [],
  dismissed: [],
};

export const LEAD_FLOW: Record<LeadStage, LeadStage[]> = {
  new: ["qualified", "lost"],
  qualified: ["engaged", "lost"],
  engaged: ["proposal", "lost"],
  proposal: ["won", "lost"],
  won: [],
  lost: [],
};

export function canTransitionInquiry(from: InquiryStatus, to: InquiryStatus): boolean {
  return INQUIRY_FLOW[from]?.includes(to) ?? false;
}

export function canTransitionLead(from: LeadStage, to: LeadStage): boolean {
  return LEAD_FLOW[from]?.includes(to) ?? false;
}

/** §55 score bands: cold 0-39, warm 40-69, hot 70-100. */
export function bandFor(score: number): ScoreBand {
  if (score >= 70) return "hot";
  if (score >= 40) return "warm";
  return "cold";
}

export function clampScore(n: unknown): number {
  const v = typeof n === "number" && Number.isFinite(n) ? Math.round(n) : 0;
  return Math.max(0, Math.min(100, v));
}

export class SalesServiceError extends Error {
  code: string;
  httpStatus: number;
  constructor(code: string, httpStatus: number, message?: string) {
    super(message ?? code);
    this.name = "SalesServiceError";
    this.code = code;
    this.httpStatus = httpStatus;
  }
}

/* ------------------------------------------------------------------ */
/* Pipeline contract shapes (§55)                                      */
/* ------------------------------------------------------------------ */

export interface InquiryClassificationResult {
  classification: InquiryClassification;
  urgency: InquiryUrgency;
  summary: string;
  isLead: boolean;
  company: string | null;
  contactName: string | null;
  contactEmail: string | null;
  notes: string | null;
  degraded: boolean;
}

export interface LeadScoreResult {
  leadScore: number;
  band: ScoreBand;
  nextAction: string;
  rationale: string | null;
  degraded: boolean;
}

/** The escalation law (§55): these signals page a human. */
export function requiresEscalation(
  c: Pick<InquiryClassificationResult, "urgency" | "classification">,
  s: Pick<LeadScoreResult, "band"> | null
): boolean {
  if (c.urgency === "high") return true;
  if (s?.band === "hot") return true;
  return false;
}
