/**
 * Content workforce types (Phase 8 — Phase 0.5 §11 P7, §60–§61 lifecycle,
 * §5.1 drafts state map, §72 approval immutability, audit §901).
 *
 * The content chain runs three registry agents in sequence:
 *   content_strategy → content → fact_check
 * each executing from its VERSIONED prompt (agent_versions) with a
 * structured-output schema below. The artifact is a content_item whose
 * lifecycle is the §60 nine-state machine; every text the chain or a human
 * produces lands as a NEW content_version row (never-overwrite, §61).
 */

/* ------------------------------------------------------------------ */
/* §60 nine-state lifecycle                                            */
/* ------------------------------------------------------------------ */

export type ContentLifecycle =
  | "IDEA"
  | "RESEARCHING"
  | "DRAFT"
  | "FACT_CHECK"
  | "REVIEW"
  | "APPROVED"
  | "SCHEDULED"
  | "PUBLISHED"
  | "ARCHIVED";

export const LIFECYCLE_STATES: readonly ContentLifecycle[] = [
  "IDEA", "RESEARCHING", "DRAFT", "FACT_CHECK", "REVIEW",
  "APPROVED", "SCHEDULED", "PUBLISHED", "ARCHIVED",
] as const;

/**
 * The §60 lifecycle as a transition table. Design notes:
 *  - REVIEW → DRAFT is the rework loop (request-changes); ARCHIVED is the
 *    terminal state for rejected/killed items.
 *  - APPROVED → SCHEDULED / PUBLISHED exist for the operator path, but this
 *    phase builds NO auto-publishing (roadmap P7: "NOT yet: auto-publish
 *    anything") — reaching APPROVED is the acceptance boundary.
 */
export const LIFECYCLE_FLOW: Record<ContentLifecycle, ContentLifecycle[]> = {
  IDEA: ["RESEARCHING", "ARCHIVED"],
  RESEARCHING: ["DRAFT", "ARCHIVED"],
  DRAFT: ["FACT_CHECK", "REVIEW", "ARCHIVED"],
  FACT_CHECK: ["REVIEW", "DRAFT", "ARCHIVED"],
  REVIEW: ["APPROVED", "DRAFT", "ARCHIVED"],
  APPROVED: ["SCHEDULED", "PUBLISHED", "ARCHIVED"],
  SCHEDULED: ["PUBLISHED", "ARCHIVED"],
  PUBLISHED: ["ARCHIVED"],
  ARCHIVED: [],
};

export function canTransition(from: ContentLifecycle, to: ContentLifecycle): boolean {
  return LIFECYCLE_FLOW[from]?.includes(to) ?? false;
}

/** §5.1 drafts FSM → lifecycle state map (documented, tested, one-to-one). */
export type LegacyDraftStatus = "pending" | "approved" | "rejected" | "scheduled" | "posted" | "failed";
export const DRAFT_STATE_MAP: Record<LegacyDraftStatus, ContentLifecycle> = {
  pending: "DRAFT",
  approved: "APPROVED",
  scheduled: "SCHEDULED",
  posted: "PUBLISHED",
  // §5.1: failed drafts map to PUBLISHED with the failure traceable in
  // content_publications + brief.legacy_status (publication ledger is the
  // failure record; the lifecycle state is not overloaded with a 10th state).
  failed: "PUBLISHED",
  rejected: "REVIEW",
};

/* ------------------------------------------------------------------ */
/* Risk + approval center v2 (§72)                                     */
/* ------------------------------------------------------------------ */

export type ContentRisk = "low" | "medium" | "high";
export type RequestedAction = "publish" | "schedule" | "review";

/** Fact-check verdict → approval risk level (conservative mapping). */
export function riskFromFactCheck(status: FactCheckStatus): ContentRisk {
  if (status === "fail") return "high";
  if (status === "warnings") return "medium";
  return "low";
}

export type ApprovalDecision = "approve" | "reject" | "request_changes";

/* ------------------------------------------------------------------ */
/* Chain artifacts                                                     */
/* ------------------------------------------------------------------ */

export interface PlanKeyMessage {
  message: string;
  citations: number[];
}

export interface ContentPlan {
  angle: string;
  audience: string;
  channel?: string | null;
  tone?: string | null;
  keyMessages: PlanKeyMessage[];
  outline: string[];
  ambiguous: boolean;
}

export interface ContentDraftOutput {
  title: string;
  body: string;
}

export type FactCheckStatus = "pass" | "warnings" | "fail";
export type ClaimVerdict = "supported" | "unsupported" | "contradicted" | "unverifiable";

export interface ClaimReport {
  claim: string;
  verdict: ClaimVerdict;
  citations: number[];
  correction?: string | null;
}

export interface FactCheckReport {
  status: FactCheckStatus;
  claims: ClaimReport[];
  summary: string;
}

/* ------------------------------------------------------------------ */
/* Structured-output schemas (completeJSON subset)                     */
/* ------------------------------------------------------------------ */

export const CONTENT_PLAN_SCHEMA: Record<string, unknown> = {
  type: "object",
  required: ["angle", "audience", "keyMessages", "outline", "ambiguous"],
  properties: {
    angle: { type: "string", minLength: 3, maxLength: 500 },
    audience: { type: "string", minLength: 2, maxLength: 300 },
    channel: { type: ["string", "null"] },
    tone: { type: ["string", "null"] },
    keyMessages: {
      type: "array",
      minItems: 1,
      maxItems: 8,
      items: {
        type: "object",
        required: ["message"],
        properties: {
          message: { type: "string", minLength: 3, maxLength: 500 },
          citations: { type: "array", items: { type: "integer" } },
        },
      },
    },
    outline: { type: "array", minItems: 1, maxItems: 15, items: { type: "string", minLength: 1, maxLength: 300 } },
    ambiguous: { type: "boolean" },
  },
};

export const CONTENT_DRAFT_SCHEMA: Record<string, unknown> = {
  type: "object",
  required: ["title", "body"],
  properties: {
    title: { type: "string", minLength: 3, maxLength: 200 },
    body: { type: "string", minLength: 50, maxLength: 40_000 },
  },
};

export const FACT_CHECK_SCHEMA: Record<string, unknown> = {
  type: "object",
  required: ["status", "claims", "summary"],
  properties: {
    status: { type: "string", enum: ["pass", "warnings", "fail"] },
    claims: {
      type: "array",
      maxItems: 30,
      items: {
        type: "object",
        required: ["claim", "verdict"],
        properties: {
          claim: { type: "string", minLength: 3, maxLength: 1000 },
          verdict: { type: "string", enum: ["supported", "unsupported", "contradicted", "unverifiable"] },
          citations: { type: "array", items: { type: "integer" } },
          correction: { type: ["string", "null"] },
        },
      },
    },
    summary: { type: "string", minLength: 3, maxLength: 2000 },
  },
};

/* ------------------------------------------------------------------ */
/* Row shapes                                                          */
/* ------------------------------------------------------------------ */

export type ContentType = "article" | "social_post" | "email" | "page_copy" | "other";

export interface ContentItem {
  id: number;
  businessUnitId: number;
  websiteId: number | null;
  researchItemId: number | null;
  type: ContentType;
  title: string | null;
  lifecycle: ContentLifecycle;
  brief: Record<string, unknown>;
  createdByAgent: string | null;
  currentVersionId: number | null;
  unprocessedReason: string | null;
  taskId: number | null;
  createdAt: string;
  updatedAt: string;
  reviewedAt: string | null;
  reviewedBy: string | null;
}

export interface ContentVersion {
  id: number;
  contentItemId: number;
  version: number;
  title: string | null;
  body: string;
  metadata: Record<string, unknown>;
  createdByAgent: string | null;
  promptVersion: number | null;
  promptHash: string | null;
  changeNote: string | null;
  createdAt: string;
}

export interface ApprovalRecord {
  id: number;
  contentItemId: number | null;
  draftId: number | null;
  decision: string;
  riskLevel: string | null;
  requestedAction: string | null;
  decisionReason: string | null;
  reviewerUserId: number | null;
  decidedAt: string;
}

export interface ApprovalActionRecord {
  id: number;
  contentItemId: number | null;
  approvalId: number | null;
  versionId: number | null;
  actorUserId: number | null;
  actorLabel: string | null;
  action: "submit" | "approve" | "reject" | "request_changes" | "edit" | "assign" | "escalate";
  diff: Record<string, unknown> | null;
  note: string | null;
  createdAt: string;
}

/** Result of one content_run task (payload stored on the task row). */
export interface ContentRunResult {
  itemId: number;
  fromResearchItemId?: number | null;
  lifecycle: ContentLifecycle;
  versions: number;
  plan?: { angle: string; ambiguous: boolean; keyMessages: number } | null;
  factCheck?: { status: FactCheckStatus; claims: number } | null;
  riskLevel?: ContentRisk | null;
  approvalSubmitted: boolean;
  degraded: boolean;
  degradeReason?: string;
}
