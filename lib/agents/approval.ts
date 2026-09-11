import { query, transaction } from "../db";

export type DraftStatus = "pending" | "approved" | "rejected" | "scheduled" | "posted" | "failed";

export const STATUS_FLOW: Record<DraftStatus, DraftStatus[]> = {
  pending: ["approved", "rejected"],
  approved: ["scheduled"],
  rejected: [],
  scheduled: ["posted", "failed"],
  posted: [],
  failed: [],
};

export function canTransition(from: DraftStatus, to: DraftStatus): boolean {
  return STATUS_FLOW[from].includes(to);
}

/**
 * FSM transition (Phase 1 M1 — SEC-C7): the status read, legality check, and
 * status write now run inside one transaction with a row lock, closing the
 * double-approve/publish window that widens once multiple operators exist.
 */
async function transition(draftId: number, to: DraftStatus): Promise<void> {
  await transaction(async (q) => {
    const rows = await q<{ status: DraftStatus }>("SELECT status FROM drafts WHERE id = $1 FOR UPDATE", [draftId]);
    if (rows.length === 0) throw new Error(`draft not found: ${draftId}`);
    if (!canTransition(rows[0].status, to)) {
      throw new Error(`illegal draft transition ${rows[0].status} -> ${to}`);
    }
    await q("UPDATE drafts SET status = $2 WHERE id = $1", [draftId, to]);
  });
}

/** Reviewer identity recorded on approval actions when a session user acts. */
export interface ReviewerRef {
  userId: number;
}

export async function createDraft(p: { tenantId: number; agent: string; channel: string; content: string }) {
  const rows = await query<{ id: number }>(
    `INSERT INTO drafts (tenant_id, agent, channel, content, status)
     VALUES ($1, $2, $3, $4, 'pending') RETURNING id`,
    [p.tenantId, p.agent, p.channel, p.content]
  );
  return { draftId: rows[0].id };
}

export async function approveDraft(draftId: number, reviewer?: ReviewerRef): Promise<void> {
  await transition(draftId, "approved");
  await query(
    "INSERT INTO approvals (draft_id, decision, reviewer_user_id) VALUES ($1, 'approved', $2)",
    [draftId, reviewer?.userId ?? null]
  );
}

export async function rejectDraft(draftId: number, comment: string, reviewer?: ReviewerRef): Promise<void> {
  await transition(draftId, "rejected");
  await query("UPDATE drafts SET review_notes = $2 WHERE id = $1", [draftId, comment]);
  await query(
    "INSERT INTO approvals (draft_id, decision, comment, reviewer_user_id) VALUES ($1, 'rejected', $2, $3)",
    [draftId, comment, reviewer?.userId ?? null]
  );
}

export async function scheduleDraft(draftId: number, _actor?: ReviewerRef): Promise<void> {
  await transition(draftId, "scheduled");
}

/**
 * Phase 3 write-stop (§205): publications land in content_publications
 * (idempotency_key UNIQUE per draft) instead of the outbox. The outbox
 * becomes an archive — no new rows from here on; drop is Phase 4 cleanup.
 * UPSERT semantics: the engine's publishing_sweep pre-inserts a pending
 * claim row BEFORE the external side effect; markPosted then finalizes that
 * same row. Legacy callers (no claim row) insert fresh.
 */
export async function markPosted(draftId: number, externalId: string): Promise<void> {
  const d = await query<{ tenant_id: number; channel: string }>("SELECT tenant_id, channel FROM drafts WHERE id = $1", [draftId]);
  await transition(draftId, "posted");
  await query(
    `INSERT INTO content_publications
       (draft_id, tenant_id, channel, external_id, idempotency_key, status, published_at, attempted_at)
     VALUES ($1, $2, $3, $4, $5, 'published', now(), now())
     ON CONFLICT (idempotency_key) DO UPDATE
       SET status = 'published', external_id = EXCLUDED.external_id,
           published_at = now(), attempted_at = now(), error = NULL`,
    [draftId, d[0].tenant_id, d[0].channel, externalId, `draft:${draftId}`]
  );
}

export async function markFailed(draftId: number, error: string): Promise<void> {
  const d = await query<{ tenant_id: number; channel: string }>("SELECT tenant_id, channel FROM drafts WHERE id = $1", [draftId]);
  await transition(draftId, "failed");
  await query(
    `INSERT INTO content_publications
       (draft_id, tenant_id, channel, idempotency_key, status, error, attempted_at)
     VALUES ($1, $2, $3, $4, 'failed', $5, now())
     ON CONFLICT (idempotency_key) DO UPDATE
       SET status = 'failed', error = EXCLUDED.error, attempted_at = now()`,
    [draftId, d[0].tenant_id, d[0].channel, `draft:${draftId}`, error.slice(0, 2000)]
  );
}

export interface DraftRow {
  id: number; tenant_id: number; agent: string; channel: string;
  content: string; status: DraftStatus; review_notes: string | null;
}

export async function listDraftsByTenant(tenantId: number, status?: DraftStatus): Promise<DraftRow[]> {
  if (status) {
    return query<DraftRow>("SELECT id, tenant_id, agent, channel, content, status, review_notes FROM drafts WHERE tenant_id = $1 AND status = $2 ORDER BY id", [tenantId, status]);
  }
  return query<DraftRow>("SELECT id, tenant_id, agent, channel, content, status, review_notes FROM drafts WHERE tenant_id = $1 ORDER BY id", [tenantId]);
}

/** Drafts across multiple legacy tenants (session-scoped admin reads). */
export async function listDraftsByTenants(tenantIds: number[], status?: DraftStatus): Promise<DraftRow[]> {
  if (tenantIds.length === 0) return [];
  if (status) {
    return query<DraftRow>("SELECT id, tenant_id, agent, channel, content, status, review_notes FROM drafts WHERE tenant_id = ANY($1::bigint[]) AND status = $2 ORDER BY id", [tenantIds, status]);
  }
  return query<DraftRow>("SELECT id, tenant_id, agent, channel, content, status, review_notes FROM drafts WHERE tenant_id = ANY($1::bigint[]) ORDER BY id", [tenantIds]);
}
