/**
 * Content workforce service (Phase 8) — the ONLY writer of content rows.
 *
 * Storage contracts:
 *  - Never-overwrite (§61): appendVersion() inserts a NEW content_versions
 *    row (UNIQUE (content_item_id, version)) and moves
 *    content_items.current_version_id inside the same transaction. Existing
 *    version rows are never updated, by construction.
 *  - Transactional FSM (§60): transitionItem() reads the lifecycle with a
 *    row lock, checks LIFECYCLE_FLOW, and writes inside ONE transaction —
 *    two concurrent approvals cannot both win (same contract as the legacy
 *    drafts FSM, Phase 1 SEC-C7).
 *  - Approval immutability (§72): a decision INSERTs an approvals row and
 *    NEVER updates it. Pending requests are content_items in REVIEW — the
 *    queue is the lifecycle, so no mutable "pending" approvals rows exist.
 *  - Every review-relevant action lands in approval_actions (edit-before-
 *    approve trail, §5.1 bundle 7).
 *  - BU isolation: every write carries business_unit_id; reads filter by it
 *    when a BU scope is given.
 */
import { query, transaction } from "../db";
import { emitEvent, type EventName } from "../tasks/events";
import {
  canTransition,
  type ApprovalActionRecord,
  type ApprovalDecision,
  type ApprovalRecord,
  type ContentItem,
  type ContentLifecycle,
  type ContentRisk,
  type ContentType,
  type ContentVersion,
} from "./types";

export class ContentServiceError extends Error {
  code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = "ContentServiceError";
    this.code = code;
  }
}

/* ------------------------------------------------------------------ */
/* Row mapping                                                         */
/* ------------------------------------------------------------------ */

interface ItemRow {
  id: string | number; business_unit_id: number; website_id: string | number | null;
  research_item_id: string | number | null; type: string; title: string | null;
  lifecycle: string; brief: Record<string, unknown> | null; created_by_agent: string | null;
  current_version_id: string | number | null; unprocessed_reason: string | null;
  task_id: string | number | null; created_at: string; updated_at: string;
  reviewed_at: string | null; reviewed_by: string | null;
}

function toItem(r: ItemRow): ContentItem {
  return {
    id: Number(r.id), businessUnitId: r.business_unit_id,
    websiteId: r.website_id != null ? Number(r.website_id) : null,
    researchItemId: r.research_item_id != null ? Number(r.research_item_id) : null,
    type: r.type as ContentType, title: r.title, lifecycle: r.lifecycle as ContentLifecycle,
    brief: r.brief ?? {}, createdByAgent: r.created_by_agent,
    currentVersionId: r.current_version_id != null ? Number(r.current_version_id) : null,
    unprocessedReason: r.unprocessed_reason, taskId: r.task_id != null ? Number(r.task_id) : null,
    createdAt: r.created_at, updatedAt: r.updated_at,
    reviewedAt: r.reviewed_at, reviewedBy: r.reviewed_by,
  };
}

interface VersionRow {
  id: string | number; content_item_id: string | number; version: number;
  title: string | null; body: string; metadata: Record<string, unknown> | null;
  created_by_agent: string | null; prompt_version: number | null; prompt_hash: string | null;
  change_note: string | null; created_at: string;
}

function toVersion(r: VersionRow): ContentVersion {
  return {
    id: Number(r.id), contentItemId: Number(r.content_item_id), version: r.version,
    title: r.title, body: r.body, metadata: r.metadata ?? {},
    createdByAgent: r.created_by_agent, promptVersion: r.prompt_version,
    promptHash: r.prompt_hash, changeNote: r.change_note, createdAt: r.created_at,
  };
}

/* ------------------------------------------------------------------ */
/* Items                                                               */
/* ------------------------------------------------------------------ */

export const CONTENT_TYPES: readonly ContentType[] = ["article", "social_post", "email", "page_copy", "other"];

export async function createItem(p: {
  businessUnitId: number;
  websiteId?: number | null;
  researchItemId?: number | null;
  type?: ContentType;
  title?: string | null;
  brief?: Record<string, unknown>;
  createdByAgent?: string | null;
  taskId?: number | null;
  /** When body is provided the item starts at DRAFT with version 1. */
  body?: string | null;
}): Promise<ContentItem> {
  const rows = await query<ItemRow>(
    `INSERT INTO content_items (business_unit_id, website_id, research_item_id, type, title, brief, created_by_agent, task_id, lifecycle)
     VALUES ($1,$2,$3,$4,$5,$6::jsonb,$7,$8,$9) RETURNING *`,
    [
      p.businessUnitId, p.websiteId ?? null, p.researchItemId ?? null,
      p.type ?? "article", p.title ?? null, JSON.stringify(p.brief ?? {}),
      p.createdByAgent ?? null, p.taskId ?? null, p.body ? "DRAFT" : "IDEA",
    ]
  ).catch((e: { code?: string }) => {
    if (e.code === "23503") throw new ContentServiceError("NOT_FOUND", "referenced business unit / website / research item does not exist");
    throw e;
  });
  const item = toItem(rows[0]);
  if (p.body) {
    await appendVersion(item.id, {
      title: p.title ?? undefined,
      body: p.body,
      createdByAgent: p.createdByAgent ?? undefined,
      changeNote: "initial version",
    });
    return (await getItem(item.id)) ?? item;
  }
  await emitEvent(item.businessUnitId, "content.item.created", { itemId: item.id, type: item.type, source: (p.brief as { source?: string })?.source ?? "manual" });
  return item;
}

export async function getItem(id: number): Promise<ContentItem | null> {
  const rows = await query<ItemRow>("SELECT * FROM content_items WHERE id = $1", [id]);
  return rows[0] ? toItem(rows[0]) : null;
}

export async function listItems(opts: { businessUnitId?: number | null; lifecycle?: ContentLifecycle | null; limit?: number } = {}): Promise<ContentItem[]> {
  const limit = Math.min(opts.limit ?? 50, 200);
  const rows = await query<ItemRow>(
    `SELECT * FROM content_items
     WHERE ($1::bigint IS NULL OR business_unit_id = $1)
       AND ($2::text IS NULL OR lifecycle = $2)
     ORDER BY updated_at DESC LIMIT $3`,
    [opts.businessUnitId ?? null, opts.lifecycle ?? null, limit]
  );
  return rows.map(toItem);
}

export async function stats(businessUnitId?: number | null): Promise<{ lifecycle: string; n: number }[]> {
  return query<{ lifecycle: string; n: number }>(
    `SELECT lifecycle, count(*)::int AS n FROM content_items
     WHERE ($1::bigint IS NULL OR business_unit_id = $1) GROUP BY lifecycle ORDER BY lifecycle`,
    [businessUnitId ?? null]
  );
}

export async function setTask(itemId: number, taskId: number): Promise<void> {
  await query("UPDATE content_items SET task_id = $2, updated_at = now() WHERE id = $1", [itemId, taskId]);
}

export async function setUnprocessedReason(itemId: number, reason: string | null): Promise<void> {
  await query("UPDATE content_items SET unprocessed_reason = $2, updated_at = now() WHERE id = $1", [itemId, reason]);
}

/* ------------------------------------------------------------------ */
/* Versions — never-overwrite (§61)                                    */
/* ------------------------------------------------------------------ */

export async function appendVersion(itemId: number, p: {
  title?: string;
  body: string;
  metadata?: Record<string, unknown>;
  createdByAgent?: string | null;
  promptVersion?: number | null;
  promptHash?: string | null;
  changeNote?: string | null;
}): Promise<ContentVersion> {
  return transaction(async (q) => {
    // Lock the item row so two concurrent writers cannot race the version
    // number; the UNIQUE (content_item_id, version) is the DB-level backstop.
    const locked = await q<{ id: string | number }>("SELECT id FROM content_items WHERE id = $1 FOR UPDATE", [itemId]);
    if (locked.length === 0) throw new ContentServiceError("NOT_FOUND", `content item not found: ${itemId}`);
    const rows = await q<VersionRow>(
      `INSERT INTO content_versions (content_item_id, version, title, body, metadata, created_by_agent, prompt_version, prompt_hash, change_note)
       SELECT $1, COALESCE(max(version), 0) + 1, $2, $3, $4::jsonb, $5, $6, $7, $8
       FROM content_versions WHERE content_item_id = $1
       RETURNING *`,
      [
        itemId, p.title ?? null, p.body, JSON.stringify(p.metadata ?? {}),
        p.createdByAgent ?? null, p.promptVersion ?? null, p.promptHash ?? null, p.changeNote ?? null,
      ]
    );
    const version = toVersion(rows[0]);
    await q(
      `UPDATE content_items SET current_version_id = $2, updated_at = now(),
         title = COALESCE($3, title)
       WHERE id = $1`,
      [itemId, version.id, p.title ?? null]
    );
    return version;
  });
}

export async function listVersions(itemId: number): Promise<ContentVersion[]> {
  const rows = await query<VersionRow>(
    "SELECT * FROM content_versions WHERE content_item_id = $1 ORDER BY version DESC",
    [itemId]
  );
  return rows.map(toVersion);
}

export async function getVersion(itemId: number, version: number): Promise<ContentVersion | null> {
  const rows = await query<VersionRow>(
    "SELECT * FROM content_versions WHERE content_item_id = $1 AND version = $2",
    [itemId, version]
  );
  return rows[0] ? toVersion(rows[0]) : null;
}

/* ------------------------------------------------------------------ */
/* Lifecycle transitions (transactional FSM)                           */
/* ------------------------------------------------------------------ */

export async function transitionItem(
  itemId: number,
  to: ContentLifecycle,
  opts: { actorLabel?: string | null; userId?: number | null } = {}
): Promise<ContentItem> {
  const rows = await transaction(async (q) => {
    const locked = await q<ItemRow>("SELECT * FROM content_items WHERE id = $1 FOR UPDATE", [itemId]);
    if (locked.length === 0) throw new ContentServiceError("NOT_FOUND", `content item not found: ${itemId}`);
    const from = locked[0].lifecycle as ContentLifecycle;
    if (!canTransition(from, to)) {
      throw new ContentServiceError("ILLEGAL_TRANSITION", `illegal content transition ${from} -> ${to}`);
    }
    return q<ItemRow>(
      `UPDATE content_items SET lifecycle = $2, updated_at = now(),
         reviewed_at = CASE WHEN $2 IN ('APPROVED','REVIEW','DRAFT') AND $1 = 'REVIEW' THEN now() ELSE reviewed_at END,
         reviewed_by = CASE WHEN $2 IN ('APPROVED','REVIEW','DRAFT') AND $1 = 'REVIEW' THEN COALESCE($3, reviewed_by) ELSE reviewed_by END,
         unprocessed_reason = CASE WHEN $1 = 'RESEARCHING' THEN NULL ELSE unprocessed_reason END
       WHERE id = $4 RETURNING *`,
      [from, to, opts.actorLabel ?? null, itemId]
    );
  });
  const item = toItem(rows[0]);
  await emitEvent(item.businessUnitId, "content.state_changed", {
    itemId: item.id, from: rows[0].lifecycle, to: item.lifecycle, actor: opts.actorLabel ?? "system",
  });
  return item;
}

/* ------------------------------------------------------------------ */
/* Approval center v2 (§72)                                            */
/* ------------------------------------------------------------------ */

/**
 * Park an item into REVIEW (the pending queue is the lifecycle itself).
 * Idempotent: an item already in REVIEW (e.g. manually moved) just gets its
 * risk/action recorded. Records the risk level + requested action on the
 * item brief and the submit action into approval_actions. No approvals row
 * exists yet — decisions are immutable INSERTs (§72), a pending row would
 * be mutable.
 */
export async function submitForReview(itemId: number, p: {
  riskLevel: ContentRisk;
  requestedAction?: string;
  taskId?: number | null;
  actorLabel?: string;
  userId?: number | null;
}): Promise<ContentItem> {
  const item = await getItem(itemId);
  if (!item) throw new ContentServiceError("NOT_FOUND", `content item not found: ${itemId}`);
  const updated = item.lifecycle === "REVIEW"
    ? item
    : await transitionItem(itemId, "REVIEW", { actorLabel: p.actorLabel ?? "content-chain" });
  await query(
    `UPDATE content_items SET brief = brief || $2::jsonb, task_id = COALESCE($3, task_id), updated_at = now()
     WHERE id = $1`,
    [itemId, JSON.stringify({ riskLevel: p.riskLevel, requestedAction: p.requestedAction ?? "publish" }), p.taskId ?? null]
  );
  await recordAction({
    businessUnitId: item.businessUnitId,
    contentItemId: itemId,
    versionId: item.currentVersionId,
    actorUserId: p.userId ?? null,
    actorLabel: p.actorLabel ?? "content-chain",
    action: "submit",
    diff: { riskLevel: p.riskLevel, requestedAction: p.requestedAction ?? "publish" },
  });
  return updated;
}

/** Human decision on an item in REVIEW. Immutable INSERT + FSM transition. */
export async function decideItem(itemId: number, p: {
  decision: ApprovalDecision;
  comment?: string | null;
  reviewerUserId?: number | null;
  reviewerLabel?: string | null;
}): Promise<ContentItem> {
  const item = await getItem(itemId);
  if (!item) throw new ContentServiceError("NOT_FOUND", `content item not found: ${itemId}`);
  if (item.lifecycle !== "REVIEW") {
    throw new ContentServiceError("NOT_IN_REVIEW", `item is ${item.lifecycle}, decisions require REVIEW`);
  }

  const to: ContentLifecycle = p.decision === "approve" ? "APPROVED" : p.decision === "request_changes" ? "DRAFT" : "ARCHIVED";
  const decision = p.decision === "approve" ? "approved" : "rejected";

  // Immutable decision row (§72): INSERT only, never UPDATE. content_item_id
  // FK has no cascade — the audit record outlives the content item.
  const approvalRows = await query<{ id: string | number }>(
    `INSERT INTO approvals (draft_id, decision, comment, reviewer_user_id, content_item_id, risk_level, requested_action, decision_reason, task_id)
     VALUES (NULL, $1, $2, $3, $4, $5, $6, $2, $7) RETURNING id`,
    [
      decision, p.comment ?? null, p.reviewerUserId ?? null, itemId,
      (item.brief as { riskLevel?: string }).riskLevel ?? null,
      (item.brief as { requestedAction?: string }).requestedAction ?? null,
      item.taskId,
    ]
  );
  const approvalId = Number(approvalRows[0].id);

  const updated = await transitionItem(itemId, to, {
    actorLabel: p.reviewerLabel ?? "reviewer",
    userId: p.reviewerUserId ?? null,
  });

  await recordAction({
    businessUnitId: item.businessUnitId,
    contentItemId: itemId,
    approvalId,
    versionId: item.currentVersionId,
    actorUserId: p.reviewerUserId ?? null,
    actorLabel: p.reviewerLabel ?? "reviewer",
    action: p.decision,
    diff: { from: "REVIEW", to, decision },
    note: p.comment ?? null,
  });

  await emitEvent(item.businessUnitId, p.decision === "approve" ? "content.approved" : "content.rejected", {
    itemId, decision, to, reviewer: p.reviewerLabel ?? "reviewer",
  });
  return updated;
}

/** Manual edit before approve: appends a NEW version + an edit action. */
export async function addManualVersion(itemId: number, p: {
  title?: string;
  body: string;
  changeNote?: string | null;
  actorLabel?: string | null;
  userId?: number | null;
}): Promise<ContentVersion> {
  const item = await getItem(itemId);
  if (!item) throw new ContentServiceError("NOT_FOUND", `content item not found: ${itemId}`);
  const version = await appendVersion(itemId, {
    title: p.title ?? undefined,
    body: p.body,
    createdByAgent: "human",
    changeNote: p.changeNote ?? "manual edit",
  });
  await recordAction({
    businessUnitId: item.businessUnitId,
    contentItemId: itemId,
    versionId: version.id,
    actorUserId: p.userId ?? null,
    actorLabel: p.actorLabel ?? "editor",
    action: "edit",
    diff: { version: version.version, replaces: item.currentVersionId },
  });
  return version;
}

/* ------------------------------------------------------------------ */
/* Approval history                                                    */
/* ------------------------------------------------------------------ */

export async function recordAction(p: {
  businessUnitId: number;
  contentItemId?: number | null;
  approvalId?: number | null;
  versionId?: number | null;
  actorUserId?: number | null;
  actorLabel?: string | null;
  action: ApprovalActionRecord["action"];
  diff?: Record<string, unknown> | null;
  note?: string | null;
}): Promise<number> {
  const rows = await query<{ id: string | number }>(
    `INSERT INTO approval_actions (business_unit_id, content_item_id, approval_id, version_id, actor_user_id, actor_label, action, diff, note)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8::jsonb,$9) RETURNING id`,
    [
      p.businessUnitId, p.contentItemId ?? null, p.approvalId ?? null, p.versionId ?? null,
      p.actorUserId ?? null, p.actorLabel ?? null, p.action, JSON.stringify(p.diff ?? {}), p.note ?? null,
    ]
  );
  return Number(rows[0].id);
}

function toApproval(r: Record<string, unknown>): ApprovalRecord {
  return {
    id: Number(r.id),
    contentItemId: r.content_item_id != null ? Number(r.content_item_id) : null,
    draftId: r.draft_id != null ? Number(r.draft_id) : null,
    decision: String(r.decision),
    riskLevel: (r.risk_level as string | null) ?? null,
    requestedAction: (r.requested_action as string | null) ?? null,
    decisionReason: (r.decision_reason as string | null) ?? null,
    reviewerUserId: r.reviewer_user_id != null ? Number(r.reviewer_user_id) : null,
    decidedAt: String(r.decided_at),
  };
}

function toAction(r: Record<string, unknown>): ApprovalActionRecord {
  return {
    id: Number(r.id),
    contentItemId: r.content_item_id != null ? Number(r.content_item_id) : null,
    approvalId: r.approval_id != null ? Number(r.approval_id) : null,
    versionId: r.version_id != null ? Number(r.version_id) : null,
    actorUserId: r.actor_user_id != null ? Number(r.actor_user_id) : null,
    actorLabel: (r.actor_label as string | null) ?? null,
    action: r.action as ApprovalActionRecord["action"],
    diff: (r.diff as Record<string, unknown> | null) ?? null,
    note: (r.note as string | null) ?? null,
    createdAt: String(r.created_at),
  };
}

export async function listApprovalsForItem(itemId: number): Promise<ApprovalRecord[]> {
  const rows = await query<Record<string, unknown>>(
    "SELECT * FROM approvals WHERE content_item_id = $1 ORDER BY decided_at DESC",
    [itemId]
  );
  return rows.map(toApproval);
}

export async function listActionsForItem(itemId: number): Promise<ApprovalActionRecord[]> {
  const rows = await query<Record<string, unknown>>(
    "SELECT * FROM approval_actions WHERE content_item_id = $1 ORDER BY created_at DESC",
    [itemId]
  );
  return rows.map(toAction);
}

/** Pending queue: content items awaiting a human decision. */
export async function listPendingReviews(businessUnitId?: number | null, limit = 50): Promise<ContentItem[]> {
  return listItems({ businessUnitId, lifecycle: "REVIEW", limit });
}
