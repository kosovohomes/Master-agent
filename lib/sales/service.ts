/**
 * Phase 12 — sales + customer workforce service (single-writer data access).
 *
 * Contracts carried here:
 *  - Conversation persistence (widget chat survives reloads; §909)
 *  - Inquiry FSM (row-locked transitions; §55 classification/escalation)
 *  - Lead dedup (partial UNIQUE bu+lower(email)) with a SCORE-RATCHET
 *    upsert: a re-lead of the same contact updates contact fields and
 *    ratchets lead_score upward — a score never regresses and a stage is
 *    never demoted by automation; only humans move stages (§91).
 *  - Site-key resolution (widget = website-registered connector #1, §13):
 *    a presented siteKey resolves to exactly one active widget integration
 *    → website → business unit, which is what binds conversations and
 *    inquiries to the site that emitted them (§101 customer isolation).
 */
import { query, transaction } from "../db";
import {
  SalesServiceError,
  canTransitionInquiry,
  canTransitionLead,
  bandFor,
  clampScore,
  type InquiryStatus,
  type LeadStage,
  type ScoreSource,
  type ClassifySource,
} from "./types";

/* ------------------------------------------------------------------ */
/* Row shapes                                                          */
/* ------------------------------------------------------------------ */

export interface ConversationRow {
  id: number;
  business_unit_id: number;
  website_id: number | null;
  visitor_id: string | null;
  channel: string;
  status: string;
  customer_name: string | null;
  customer_email: string | null;
  metadata: Record<string, unknown>;
  created_at: string;
  updated_at: string;
}

export interface MessageRow {
  id: number;
  conversation_id: number;
  role: "visitor" | "assistant";
  content: string;
  citations: unknown;
  metadata: Record<string, unknown>;
  created_at: string;
}

export interface InquiryRow {
  id: number;
  business_unit_id: number;
  conversation_id: number | null;
  website_id: number | null;
  name: string | null;
  email: string | null;
  subject: string | null;
  body: string;
  classification: string | null;
  urgency: string | null;
  status: InquiryStatus;
  source: string;
  summary: string | null;
  classified_by: ClassifySource | null;
  created_by_user_id: number | null;
  metadata: Record<string, unknown>;
  created_at: string;
  updated_at: string;
}

export interface LeadRow {
  id: number;
  business_unit_id: number | null;
  inquiry_id: number | null;
  company: string | null;
  contact_name: string | null;
  contact_email: string | null;
  contact_phone: string | null;
  source: string;
  stage: LeadStage;
  lead_score: number;
  score_band: string;
  next_action: string | null;
  score_rationale: string | null;
  scored_by: ScoreSource | null;
  created_by_agent: string | null;
  created_by_user_id: number | null;
  metadata: Record<string, unknown>;
  created_at: string;
  updated_at: string;
}

/**
 * The physical table is the EXTENDED legacy `leads` (Phase-1 baseline):
 * `name` IS the contact name, `contact`/`channel` are NOT NULL legacy
 * compatibility columns the writer back-fills, `tenant_id` is legacy.
 * Map to the §55 shape and strip legacy internals from API responses.
 */
function toLead(r: Record<string, unknown>): LeadRow {
  const { name, contact, channel, tenant_id, notes, ...rest } = r as Record<string, unknown>;
  void contact; void channel; void tenant_id; void notes;
  return { ...(rest as unknown as LeadRow), contact_name: (rest.contact_name as string | null) ?? (name as string | null) ?? null };
}

/* ------------------------------------------------------------------ */
/* Conversations + messages                                            */
/* ------------------------------------------------------------------ */

export async function createConversation(p: {
  businessUnitId: number;
  websiteId?: number | null;
  visitorId?: string | null;
  channel?: string;
  customerName?: string | null;
  customerEmail?: string | null;
}): Promise<ConversationRow> {
  const rows = await query<ConversationRow>(
    `INSERT INTO conversations (business_unit_id, website_id, visitor_id, channel, customer_name, customer_email)
     VALUES ($1, $2, $3, $4, $5, $6)
     RETURNING *`,
    [
      p.businessUnitId,
      p.websiteId ?? null,
      p.visitorId ?? null,
      p.channel ?? "widget",
      p.customerName ?? null,
      p.customerEmail ?? null,
    ]
  );
  return rows[0];
}

export async function getConversation(id: number): Promise<ConversationRow | null> {
  const rows = await query<ConversationRow>("SELECT * FROM conversations WHERE id = $1", [id]);
  return rows[0] ?? null;
}

export async function appendMessage(p: {
  conversationId: number;
  role: "visitor" | "assistant";
  content: string;
  citations?: unknown;
  metadata?: Record<string, unknown>;
}): Promise<MessageRow> {
  const rows = await query<MessageRow>(
    `INSERT INTO messages (conversation_id, role, content, citations, metadata)
     VALUES ($1, $2, $3, $4::jsonb, $5::jsonb)
     RETURNING *`,
    [
      p.conversationId,
      p.role,
      p.content,
      JSON.stringify(p.citations ?? []),
      JSON.stringify(p.metadata ?? {}),
    ]
  );
  // Touch the conversation (updated_at is the recency cursor on lists).
  await query("UPDATE conversations SET updated_at = now() WHERE id = $1", [p.conversationId]);
  return rows[0];
}

/**
 * §65: conversations never expose internal reasoning. Only visitor and
 * assistant roles are EVER persisted, so a plain SELECT is already safe —
 * this function is the single read path the admin API uses.
 */
export async function getMessages(conversationId: number, limit = 200): Promise<MessageRow[]> {
  return query<MessageRow>(
    `SELECT id, conversation_id, role, content, citations, metadata, created_at
     FROM messages WHERE conversation_id = $1 ORDER BY created_at ASC, id ASC LIMIT $2`,
    [conversationId, limit]
  );
}

export async function listConversations(buId: number, limit = 50): Promise<ConversationRow[]> {
  return query<ConversationRow>(
    `SELECT * FROM conversations WHERE business_unit_id = $1
     ORDER BY updated_at DESC LIMIT $2`,
    [buId, limit]
  );
}

export async function closeConversation(id: number): Promise<ConversationRow> {
  const rows = await query<ConversationRow>(
    `UPDATE conversations SET status = 'closed', updated_at = now()
     WHERE id = $1 AND status = 'active' RETURNING *`,
    [id]
  );
  if (!rows[0]) throw new SalesServiceError("NOT_FOUND", 404, `conversation ${id} not found or not active`);
  return rows[0];
}

/* ------------------------------------------------------------------ */
/* Inquiries                                                           */
/* ------------------------------------------------------------------ */

export async function createInquiry(p: {
  businessUnitId: number;
  conversationId?: number | null;
  websiteId?: number | null;
  name?: string | null;
  email?: string | null;
  subject?: string | null;
  body: string;
  source?: string;
  createdByUserId?: number | null;
  metadata?: Record<string, unknown>;
}): Promise<InquiryRow> {
  if (p.conversationId != null) {
    const conv = await getConversation(p.conversationId);
    if (!conv) throw new SalesServiceError("CONVERSATION_NOT_FOUND", 404, `conversation ${p.conversationId} not found`);
    if (conv.business_unit_id !== p.businessUnitId) {
      throw new SalesServiceError("BU_MISMATCH", 400, "conversation belongs to a different business unit");
    }
  }
  const rows = await query<InquiryRow>(
    `INSERT INTO inquiries (business_unit_id, conversation_id, website_id, name, email, subject, body, source, created_by_user_id, metadata)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10::jsonb)
     RETURNING *`,
    [
      p.businessUnitId,
      p.conversationId ?? null,
      p.websiteId ?? null,
      p.name ?? null,
      p.email ?? null,
      p.subject ?? null,
      p.body,
      p.source ?? "widget",
      p.createdByUserId ?? null,
      JSON.stringify(p.metadata ?? {}),
    ]
  );
  return rows[0];
}

export async function getInquiry(id: number): Promise<InquiryRow | null> {
  const rows = await query<InquiryRow>("SELECT * FROM inquiries WHERE id = $1", [id]);
  return rows[0] ?? null;
}

export async function listInquiries(buId: number, limit = 100): Promise<InquiryRow[]> {
  return query<InquiryRow>(
    `SELECT * FROM inquiries WHERE business_unit_id = $1
     ORDER BY created_at DESC LIMIT $2`,
    [buId, limit]
  );
}

export async function listInquiriesNeedingClassification(buId: number, limit = 25): Promise<InquiryRow[]> {
  return query<InquiryRow>(
    `SELECT * FROM inquiries WHERE business_unit_id = $1 AND status = 'new'
     ORDER BY created_at ASC LIMIT $2`,
    [buId, limit]
  );
}

/** Row-locked FSM transition (single writer, §55 lifecycle). */
export async function transitionInquiry(
  id: number,
  to: InquiryStatus,
  patch: {
    classification?: string;
    urgency?: string;
    summary?: string | null;
    classifiedBy?: ClassifySource;
  } = {}
): Promise<InquiryRow> {
  return transaction(async (q) => {
    const cur = await q<InquiryRow>("SELECT * FROM inquiries WHERE id = $1 FOR UPDATE", [id]);
    if (cur.length === 0) throw new SalesServiceError("NOT_FOUND", 404, `inquiry ${id} not found`);
    const from = cur[0].status;
    if (!canTransitionInquiry(from, to)) {
      throw new SalesServiceError("BAD_TRANSITION", 409, `inquiry ${id}: ${from} → ${to} is not a legal transition`);
    }
    const rows = await q<InquiryRow>(
      `UPDATE inquiries SET
         status = $2,
         classification = COALESCE($3, classification),
         urgency = COALESCE($4, urgency),
         summary = COALESCE($5, summary),
         classified_by = COALESCE($6, classified_by),
         updated_at = now()
       WHERE id = $1 RETURNING *`,
      [
        id,
        to,
        patch.classification ?? null,
        patch.urgency ?? null,
        patch.summary ?? null,
        patch.classifiedBy ?? null,
      ]
    );
    return rows[0];
  });
}

/** Convenience escalation used by the pipeline after classification. */
export async function escalateInquiry(id: number, patch: Parameters<typeof transitionInquiry>[2] = {}): Promise<InquiryRow> {
  return transitionInquiry(id, "escalated", patch);
}

/**
 * Same-state classification refresh ('classified' → 'classified' is not an
 * FSM move, so re-running the classify leg on an already-classified inquiry
 * goes through here; state-changing transitions must use transitionInquiry).
 */
export async function updateInquiryClassification(
  id: number,
  patch: {
    classification?: string;
    urgency?: string;
    summary?: string | null;
    classifiedBy?: ClassifySource;
    metadata?: Record<string, unknown>;
  }
): Promise<InquiryRow> {
  const rows = await query<InquiryRow>(
    `UPDATE inquiries SET
       classification = COALESCE($2, classification),
       urgency = COALESCE($3, urgency),
       summary = COALESCE($4, summary),
       classified_by = COALESCE($5, classified_by),
       metadata = metadata || $6::jsonb,
       updated_at = now()
     WHERE id = $1 AND status IN ('new','classified')
     RETURNING *`,
    [
      id,
      patch.classification ?? null,
      patch.urgency ?? null,
      patch.summary ?? null,
      patch.classifiedBy ?? null,
      JSON.stringify(patch.metadata ?? {}),
    ]
  );
  if (!rows[0]) {
    const cur = await getInquiry(id);
    if (!cur) throw new SalesServiceError("NOT_FOUND", 404, `inquiry ${id} not found`);
    throw new SalesServiceError("BAD_STATE", 409, `inquiry ${id} is ${cur.status}; classification refresh requires new|classified`);
  }
  return rows[0];
}

/* ------------------------------------------------------------------ */
/* Leads                                                               */
/* ------------------------------------------------------------------ */

/**
 * Score-ratchet upsert (§55 + §91) over the EXTENDED legacy table: same
 * (bu, email) → update contact fields; lead_score moves ONLY upward
 * (GREATEST); band follows the ratcheted score; stage is NEVER touched here
 * (humans own stages); inquiry linkage kept on first insert (first
 * attribution wins). Legacy NOT NULL columns are back-filled by the writer:
 * contact = first non-empty of email/phone/name, channel = source.
 */
export async function upsertLead(p: {
  businessUnitId: number;
  inquiryId?: number | null;
  company?: string | null;
  contactName?: string | null;
  contactEmail?: string | null;
  contactPhone?: string | null;
  source?: string;
  leadScore?: number;
  scoredBy?: ScoreSource;
  scoreRationale?: string | null;
  nextAction?: string | null;
  createdByAgent?: string | null;
  createdByUserId?: number | null;
  metadata?: Record<string, unknown>;
}): Promise<{ lead: LeadRow; created: boolean }> {
  const score = clampScore(p.leadScore ?? 0);
  const band = bandFor(score);
  const rows = await query<Record<string, unknown>>(
    `INSERT INTO leads (business_unit_id, inquiry_id, company, name, contact_email, contact_phone,
                        contact, channel, source, stage, lead_score, score_band, next_action, score_rationale, scored_by,
                        created_by_agent, created_by_user_id, metadata)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, 'new', $10, $11, $12, $13, $14, $15, $16, $17::jsonb)
     ON CONFLICT (business_unit_id, lower(contact_email)) WHERE contact_email IS NOT NULL
     DO UPDATE SET
       company = COALESCE(EXCLUDED.company, leads.company),
       name = COALESCE(EXCLUDED.name, leads.name),
       contact_phone = COALESCE(EXCLUDED.contact_phone, leads.contact_phone),
       contact = COALESCE(EXCLUDED.contact, leads.contact),
       lead_score = GREATEST(leads.lead_score, EXCLUDED.lead_score),
       score_band = CASE WHEN EXCLUDED.lead_score > leads.lead_score THEN EXCLUDED.score_band ELSE leads.score_band END,
       next_action = COALESCE(EXCLUDED.next_action, leads.next_action),
       score_rationale = CASE WHEN EXCLUDED.lead_score > leads.lead_score THEN EXCLUDED.score_rationale ELSE leads.score_rationale END,
       scored_by = CASE WHEN EXCLUDED.lead_score >= leads.lead_score THEN EXCLUDED.scored_by ELSE leads.scored_by END,
       metadata = leads.metadata || EXCLUDED.metadata,
       updated_at = now()
     RETURNING *, (xmax = 0) AS inserted`,
    [
      p.businessUnitId,
      p.inquiryId ?? null,
      p.company ?? null,
      p.contactName ?? null,
      p.contactEmail ?? null,
      p.contactPhone ?? null,
      p.contactEmail ?? p.contactPhone ?? p.contactName ?? "unknown",
      p.source ?? "widget",
      p.source ?? "widget",
      score,
      band,
      p.nextAction ?? null,
      p.scoreRationale ?? null,
      p.scoredBy ?? "deterministic",
      p.createdByAgent ?? null,
      p.createdByUserId ?? null,
      JSON.stringify(p.metadata ?? {}),
    ]
  );
  const raw0 = rows[0] as unknown as Record<string, unknown> & { inserted: boolean };
  const created = raw0.inserted;
  return { lead: toLead(raw0), created };
}

export async function getLead(id: number): Promise<LeadRow | null> {
  const rows = await query<Record<string, unknown>>("SELECT * FROM leads WHERE id = $1", [id]);
  return rows[0] ? toLead(rows[0]) : null;
}

export async function listLeads(buId: number, limit = 100): Promise<LeadRow[]> {
  const rows = await query<Record<string, unknown>>(
    `SELECT * FROM leads WHERE business_unit_id = $1
     ORDER BY
       CASE stage WHEN 'won' THEN 5 WHEN 'lost' THEN 4 ELSE 0 END ASC,
       lead_score DESC, updated_at DESC
     LIMIT $2`,
    [buId, limit]
  );
  return rows.map(toLead);
}

/** Row-locked stage transition — HUMAN-ONLY doorway (routes are the only caller). */
export async function transitionLead(
  id: number,
  to: LeadStage,
  opts: { nextAction?: string | null } = {}
): Promise<LeadRow> {
  return transaction(async (q) => {
    const cur = await q<LeadRow>("SELECT * FROM leads WHERE id = $1 FOR UPDATE", [id]);
    if (cur.length === 0) throw new SalesServiceError("NOT_FOUND", 404, `lead ${id} not found`);
    const from = cur[0].stage;
    if (!canTransitionLead(from, to)) {
      throw new SalesServiceError("BAD_TRANSITION", 409, `lead ${id}: ${from} → ${to} is not a legal transition`);
    }
    const rows = await q<Record<string, unknown>>(
      `UPDATE leads SET
         stage = $2,
         next_action = COALESCE($3, next_action),
         updated_at = now()
       WHERE id = $1 RETURNING *`,
      [id, to, opts.nextAction ?? null]
    );
    return toLead(rows[0]);
  });
}

export async function updateLeadActions(
  id: number,
  patch: { nextAction?: string | null }
): Promise<LeadRow> {
  const rows = await query<Record<string, unknown>>(
    `UPDATE leads SET next_action = COALESCE($2, next_action), updated_at = now()
     WHERE id = $1 RETURNING *`,
    [id, patch.nextAction ?? null]
  );
  if (!rows[0]) throw new SalesServiceError("NOT_FOUND", 404, `lead ${id} not found`);
  return toLead(rows[0]);
}

/* ------------------------------------------------------------------ */
/* Widget = website-registered connector #1 (§13)                      */
/* ------------------------------------------------------------------ */

export interface SiteKeyResolution {
  websiteId: number;
  businessUnitId: number;
  legacyTenantId: number;
  websiteName: string;
  domain: string | null;
}

/**
 * Resolve a widget site key to its owning site. Enforced invariants:
 *  - integration_type='widget' AND status='active' (revocation = disable)
 *  - the website must be active
 * Returns null when the key does not resolve (callers decide policy —
 * legacy embeds without keys stay accepted during the transition).
 */
export async function resolveSiteKey(siteKey: string): Promise<SiteKeyResolution | null> {
  const rows = await query<SiteKeyResolution>(
    `SELECT w.id AS "websiteId", bu.id AS "businessUnitId", bu.legacy_tenant_id AS "legacyTenantId",
            w.name AS "websiteName", w.domain
     FROM website_integrations wi
     JOIN websites w ON w.id = wi.website_id
     JOIN business_units bu ON bu.id = w.business_unit_id
     WHERE wi.integration_type = 'widget'
       AND wi.status = 'active'
       AND w.status = 'active'
       AND wi.config->>'siteKey' = $1
     LIMIT 1`,
    [siteKey]
  );
  return rows[0] ?? null;
}

/* ------------------------------------------------------------------ */
/* Dashboard aggregate                                                 */
/* ------------------------------------------------------------------ */

export interface SalesSummary {
  inquiries: Record<string, number>;
  leads: Record<string, number>;
  conversations: { total: number; active: number };
  hotLeads: number;
}

export async function salesSummary(buId: number): Promise<SalesSummary> {
  const [inq, ld, conv] = await Promise.all([
    query<{ status: string; n: number }>(
      "SELECT status, count(*)::int AS n FROM inquiries WHERE business_unit_id = $1 GROUP BY status",
      [buId]
    ),
    query<{ stage: string; n: number; band: string; nhot: number }>(
      `SELECT stage, count(*)::int AS n,
              count(*) FILTER (WHERE score_band = 'hot' AND stage NOT IN ('won','lost'))::int AS nhot
       FROM leads WHERE business_unit_id = $1 GROUP BY stage`,
      [buId]
    ),
    query<{ total: number; active: number }>(
      `SELECT count(*)::int AS total, count(*) FILTER (WHERE status = 'active')::int AS active
       FROM conversations WHERE business_unit_id = $1`,
      [buId]
    ),
  ]);
  const inquiries: Record<string, number> = {};
  for (const r of inq) inquiries[r.status] = r.n;
  const leads: Record<string, number> = {};
  let hotLeads = 0;
  for (const r of ld) {
    leads[r.stage] = r.n;
    hotLeads += r.nhot;
  }
  return {
    inquiries,
    leads,
    conversations: conv[0] ?? { total: 0, active: 0 },
    hotLeads,
  };
}
