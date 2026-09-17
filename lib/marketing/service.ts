/**
 * Marketing workforce service (Phase 11) — the ONLY writer of campaigns /
 * audience_segments / campaign_metrics rows.
 *
 * Contracts:
 *  - Approval gate (§91, §468): transitions INTO 'active' (launch from
 *    draft, resume from paused) REQUIRE approverUserId — approved_by_user_id
 *    and approved_at are stamped in the same transaction. There is no path
 *    to an active campaign without a human approval identity.
 *  - Row-locked FSM: transitionCampaign() reads the status under
 *    FOR UPDATE, checks CAMPAIGN_FLOW, writes in ONE transaction — two
 *    concurrent transitions cannot both win.
 *  - BU isolation: every write carries business_unit_id; reads filter by it
 *    when a BU scope is given.
 *  - Single-writer discipline mirrors lib/social/service.ts.
 */
import { query, transaction } from "../db";
import {
  canTransitionCampaign,
  Campaign,
  CampaignMetric,
  CampaignRollup,
  CampaignStatus,
  AudienceSegment,
  LAUNCH_STATES,
  MarketingServiceError,
  MetricSource,
  SegmentSource,
} from "./types";

/* ------------------------------------------------------------------ */
/* Row mapping                                                         */
/* ------------------------------------------------------------------ */

interface SegmentRow {
  id: string | number; business_unit_id: number; name: string; description: string | null;
  criteria: Record<string, unknown> | null; estimated_size: string | number | null;
  source: string; created_by_user_id: string | number | null;
  created_at: string; updated_at: string;
}

function toSegment(r: SegmentRow): AudienceSegment {
  return {
    id: Number(r.id), businessUnitId: r.business_unit_id, name: r.name,
    description: r.description, criteria: r.criteria ?? {},
    estimatedSize: r.estimated_size != null ? Number(r.estimated_size) : null,
    source: r.source as SegmentSource,
    createdByUserId: r.created_by_user_id != null ? Number(r.created_by_user_id) : null,
    createdAt: r.created_at, updatedAt: r.updated_at,
  };
}

interface CampaignRow {
  id: string | number; business_unit_id: number; website_id: string | number | null;
  audience_segment_id: string | number | null; name: string; objective: string | null;
  status: string; starts_at: string | null; ends_at: string | null;
  approved_by_user_id: string | number | null; approved_at: string | null;
  activated_at: string | null; completed_at: string | null;
  created_by_user_id: string | number | null; created_by_agent: string | null;
  metadata: Record<string, unknown> | null; created_at: string; updated_at: string;
}

function toCampaign(r: CampaignRow): Campaign {
  return {
    id: Number(r.id), businessUnitId: r.business_unit_id,
    websiteId: r.website_id != null ? Number(r.website_id) : null,
    audienceSegmentId: r.audience_segment_id != null ? Number(r.audience_segment_id) : null,
    name: r.name, objective: r.objective,
    status: r.status as CampaignStatus,
    startsAt: r.starts_at, endsAt: r.ends_at,
    approvedByUserId: r.approved_by_user_id != null ? Number(r.approved_by_user_id) : null,
    approvedAt: r.approved_at, activatedAt: r.activated_at, completedAt: r.completed_at,
    createdByUserId: r.created_by_user_id != null ? Number(r.created_by_user_id) : null,
    createdByAgent: r.created_by_agent,
    metadata: r.metadata ?? {},
    createdAt: r.created_at, updatedAt: r.updated_at,
  };
}

interface MetricRow {
  id: string | number; campaign_id: string | number; captured_at: string;
  impressions: string | number | null; clicks: string | number | null;
  conversions: string | number | null; spend_usd: string | number | null;
  source: string; raw: Record<string, unknown> | null;
}

function num(v: string | number | null): number | null {
  return v == null ? null : Number(v);
}

function toMetric(r: MetricRow): CampaignMetric {
  return {
    id: Number(r.id), campaignId: Number(r.campaign_id), capturedAt: r.captured_at,
    impressions: num(r.impressions), clicks: num(r.clicks),
    conversions: num(r.conversions), spendUsd: num(r.spend_usd),
    source: r.source as MetricSource, raw: r.raw ?? {},
  };
}

function isUniqueViolation(e: unknown): boolean {
  return typeof e === "object" && e !== null && (e as { code?: string }).code === "23505";
}

/* ------------------------------------------------------------------ */
/* Audience segments                                                   */
/* ------------------------------------------------------------------ */

export async function createSegment(input: {
  businessUnitId: number;
  name: string;
  description?: string | null;
  criteria?: Record<string, unknown>;
  estimatedSize?: number | null;
  source?: SegmentSource;
  userId?: number | null;
}): Promise<AudienceSegment> {
  const name = input.name.trim();
  if (!name) throw new MarketingServiceError("BAD_NAME", "segment name is required");
  if (name.length > 200) throw new MarketingServiceError("BAD_NAME", "segment name too long");
  try {
    const rows = await query<SegmentRow>(
      `INSERT INTO audience_segments
         (business_unit_id, name, description, criteria, estimated_size, source, created_by_user_id)
       VALUES ($1, $2, $3, $4::jsonb, $5, $6, $7)
       RETURNING *`,
      [
        input.businessUnitId, name, input.description ?? null,
        JSON.stringify(input.criteria ?? {}), input.estimatedSize ?? null,
        input.source ?? "manual", input.userId ?? null,
      ]
    );
    return toSegment(rows[0]);
  } catch (e) {
    if (isUniqueViolation(e)) throw new MarketingServiceError("DUPLICATE", `segment "${name}" already exists for this business unit`);
    throw e;
  }
}

export async function listSegments(opts: { businessUnitId?: number | null; limit?: number } = {}): Promise<AudienceSegment[]> {
  const clauses: string[] = [];
  const params: unknown[] = [];
  if (opts.businessUnitId != null) {
    params.push(opts.businessUnitId);
    clauses.push(`business_unit_id = $${params.length}`);
  }
  params.push(opts.limit ?? 200);
  const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";
  const rows = await query<SegmentRow>(
    `SELECT * FROM audience_segments ${where} ORDER BY created_at DESC LIMIT $${params.length}`,
    params
  );
  return rows.map(toSegment);
}

export async function updateSegment(
  id: number,
  patch: { name?: string; description?: string | null; criteria?: Record<string, unknown>; estimatedSize?: number | null }
): Promise<AudienceSegment> {
  return transaction(async (q) => {
    const cur = await q<SegmentRow>(`SELECT * FROM audience_segments WHERE id = $1 FOR UPDATE`, [id]);
    if (cur.length === 0) throw new MarketingServiceError("NOT_FOUND", `segment ${id} not found`);
    const seg = cur[0];
    const name = patch.name !== undefined ? patch.name.trim() : seg.name;
    if (!name) throw new MarketingServiceError("BAD_NAME", "segment name is required");
    const rows = await q<SegmentRow>(
      `UPDATE audience_segments SET
         name = $2,
         description = $3,
         criteria = $4::jsonb,
         estimated_size = $5,
         updated_at = now()
       WHERE id = $1
       RETURNING *`,
      [
        id, name,
        patch.description !== undefined ? patch.description : seg.description,
        JSON.stringify(patch.criteria !== undefined ? patch.criteria : seg.criteria ?? {}),
        patch.estimatedSize !== undefined ? patch.estimatedSize : seg.estimated_size,
      ]
    );
    return toSegment(rows[0]);
  }).catch((e) => {
    if (isUniqueViolation(e)) throw new MarketingServiceError("DUPLICATE", "segment name already exists for this business unit");
    throw e;
  });
}

export async function deleteSegment(id: number): Promise<boolean> {
  const rows = await query(`DELETE FROM audience_segments WHERE id = $1 RETURNING id`, [id]);
  return rows.length > 0;
}

/* ------------------------------------------------------------------ */
/* Campaigns                                                           */
/* ------------------------------------------------------------------ */

export async function createCampaign(input: {
  businessUnitId: number;
  name: string;
  objective?: string | null;
  websiteId?: number | null;
  audienceSegmentId?: number | null;
  startsAt?: string | null;
  endsAt?: string | null;
  metadata?: Record<string, unknown>;
  userId?: number | null;
  agentSlug?: string | null;
}): Promise<Campaign> {
  const name = input.name.trim();
  if (!name) throw new MarketingServiceError("BAD_NAME", "campaign name is required");
  if (name.length > 200) throw new MarketingServiceError("BAD_NAME", "campaign name too long");
  if (input.startsAt && input.endsAt && new Date(input.endsAt) <= new Date(input.startsAt)) {
    throw new MarketingServiceError("BAD_WINDOW", "campaign ends_at must be after starts_at");
  }
  if (input.audienceSegmentId != null) {
    const seg = await query(`SELECT id FROM audience_segments WHERE id = $1 AND business_unit_id = $2`, [
      input.audienceSegmentId, input.businessUnitId,
    ]);
    if (seg.length === 0) throw new MarketingServiceError("SEGMENT_NOT_FOUND", "audience segment not found in this business unit");
  }
  try {
    const rows = await query<CampaignRow>(
      `INSERT INTO campaigns
         (business_unit_id, website_id, audience_segment_id, name, objective,
          starts_at, ends_at, metadata, created_by_user_id, created_by_agent)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb, $9, $10)
       RETURNING *`,
      [
        input.businessUnitId, input.websiteId ?? null, input.audienceSegmentId ?? null,
        name, input.objective ?? null, input.startsAt ?? null, input.endsAt ?? null,
        JSON.stringify(input.metadata ?? {}), input.userId ?? null, input.agentSlug ?? null,
      ]
    );
    return toCampaign(rows[0]);
  } catch (e) {
    if (isUniqueViolation(e)) throw new MarketingServiceError("DUPLICATE", `campaign "${name}" already exists for this business unit`);
    throw e;
  }
}

export async function listCampaigns(opts: {
  businessUnitId?: number | null;
  status?: CampaignStatus | null;
  limit?: number;
} = {}): Promise<Campaign[]> {
  const clauses: string[] = [];
  const params: unknown[] = [];
  if (opts.businessUnitId != null) {
    params.push(opts.businessUnitId);
    clauses.push(`business_unit_id = $${params.length}`);
  }
  if (opts.status) {
    params.push(opts.status);
    clauses.push(`status = $${params.length}`);
  }
  params.push(opts.limit ?? 100);
  const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";
  const rows = await query<CampaignRow>(
    `SELECT * FROM campaigns ${where} ORDER BY created_at DESC LIMIT $${params.length}`,
    params
  );
  return rows.map(toCampaign);
}

export async function getCampaign(id: number): Promise<Campaign | null> {
  const rows = await query<CampaignRow>(`SELECT * FROM campaigns WHERE id = $1`, [id]);
  return rows.length ? toCampaign(rows[0]) : null;
}

/** Field-level edit; blocked in terminal states. Never touches FSM/approval columns. */
export async function updateCampaign(
  id: number,
  patch: {
    objective?: string | null;
    websiteId?: number | null;
    audienceSegmentId?: number | null;
    startsAt?: string | null;
    endsAt?: string | null;
    metadata?: Record<string, unknown>;
  }
): Promise<Campaign> {
  return transaction(async (q) => {
    const cur = await q<CampaignRow>(`SELECT * FROM campaigns WHERE id = $1 FOR UPDATE`, [id]);
    if (cur.length === 0) throw new MarketingServiceError("NOT_FOUND", `campaign ${id} not found`);
    const c = cur[0];
    if (c.status === "completed" || c.status === "cancelled") {
      throw new MarketingServiceError("TERMINAL", `campaign ${id} is ${c.status} and can no longer be edited`);
    }
    const startsAt = patch.startsAt !== undefined ? patch.startsAt : c.starts_at;
    const endsAt = patch.endsAt !== undefined ? patch.endsAt : c.ends_at;
    if (startsAt && endsAt && new Date(endsAt) <= new Date(startsAt)) {
      throw new MarketingServiceError("BAD_WINDOW", "campaign ends_at must be after starts_at");
    }
    if (patch.audienceSegmentId != null) {
      const seg = await q<{ id: number }>(
        `SELECT id FROM audience_segments WHERE id = $1 AND business_unit_id = $2`,
        [patch.audienceSegmentId, c.business_unit_id]
      );
      if (seg.length === 0) throw new MarketingServiceError("SEGMENT_NOT_FOUND", "audience segment not found in this business unit");
    }
    const mergedMetadata = {
      ...(c.metadata ?? {}),
      ...(patch.metadata !== undefined ? patch.metadata : {}),
    };
    const rows = await q<CampaignRow>(
      `UPDATE campaigns SET
         objective = $2,
         website_id = $3,
         audience_segment_id = $4,
         starts_at = $5,
         ends_at = $6,
         metadata = $7::jsonb,
         updated_at = now()
       WHERE id = $1
       RETURNING *`,
      [
        id,
        patch.objective !== undefined ? patch.objective : c.objective,
        patch.websiteId !== undefined ? patch.websiteId : c.website_id,
        patch.audienceSegmentId !== undefined ? patch.audienceSegmentId : c.audience_segment_id,
        startsAt, endsAt, JSON.stringify(mergedMetadata),
      ]
    );
    return toCampaign(rows[0]);
  });
}

/**
 * Row-locked FSM transition (the §60 contract). Approval law (§91):
 * transitions INTO a LAUNCH_STATE require approverUserId — the approver
 * identity is stamped immutably on first launch; paused→active re-stamps
 * activated_at but PRESERVES the original approved_by/at (the launch
 * approval history is never overwritten).
 */
export async function transitionCampaign(
  id: number,
  to: CampaignStatus,
  opts: { approverUserId?: number | null } = {}
): Promise<Campaign> {
  return transaction(async (q) => {
    const cur = await q<CampaignRow>(`SELECT * FROM campaigns WHERE id = $1 FOR UPDATE`, [id]);
    if (cur.length === 0) throw new MarketingServiceError("NOT_FOUND", `campaign ${id} not found`);
    const c = cur[0];
    const from = c.status as CampaignStatus;
    if (!canTransitionCampaign(from, to)) {
      throw new MarketingServiceError("BAD_TRANSITION", `campaign ${id}: ${from} → ${to} is not a legal transition`);
    }
    const isLaunch = LAUNCH_STATES.includes(to);
    if (isLaunch && !opts.approverUserId) {
      throw new MarketingServiceError("APPROVAL_REQUIRED", `campaign ${id}: ${from} → ${to} requires a human approver (§91 campaigns APPROVAL)`);
    }
    const launchFields = isLaunch
      ? `activated_at = now(),
         approved_by_user_id = COALESCE(approved_by_user_id, $3),
         approved_at = COALESCE(approved_at, now()),`
      : `activated_at = activated_at, approved_by_user_id = approved_by_user_id, approved_at = approved_at,`;
    const completion = to === "completed" ? `completed_at = now()` : `completed_at = completed_at`;
    // $3 only exists in the launch branch — binding it unconditionally makes
    // the non-launch statement "supplies 3 parameters, requires 2" (08P01).
    const params: unknown[] = isLaunch ? [id, to, opts.approverUserId ?? null] : [id, to];
    const rows = await q<CampaignRow>(
      `UPDATE campaigns SET
         status = $2,
         ${launchFields}
         ${completion},
         updated_at = now()
       WHERE id = $1
       RETURNING *`,
      params
    );
    return toCampaign(rows[0]);
  });
}

/* ------------------------------------------------------------------ */
/* Metrics + performance monitoring (§468)                             */
/* ------------------------------------------------------------------ */

export async function ingestMetrics(input: {
  campaignId: number;
  impressions?: number | null;
  clicks?: number | null;
  conversions?: number | null;
  spendUsd?: number | null;
  source?: MetricSource;
  raw?: Record<string, unknown>;
}): Promise<CampaignMetric> {
  const camp = await query(`SELECT id FROM campaigns WHERE id = $1`, [input.campaignId]);
  if (camp.length === 0) throw new MarketingServiceError("NOT_FOUND", `campaign ${input.campaignId} not found`);
  const rows = await query<MetricRow>(
    `INSERT INTO campaign_metrics (campaign_id, impressions, clicks, conversions, spend_usd, source, raw)
     VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb)
     RETURNING *`,
    [
      input.campaignId, input.impressions ?? null, input.clicks ?? null,
      input.conversions ?? null, input.spendUsd ?? null,
      input.source ?? "manual", JSON.stringify(input.raw ?? {}),
    ]
  );
  return toMetric(rows[0]);
}

export async function campaignRollup(campaignId: number): Promise<CampaignRollup> {
  const sums = await query<{
    impressions: string | null; clicks: string | null; conversions: string | null;
    spend_usd: string | null; snapshots: string;
  }>(
    `SELECT SUM(impressions)::text AS impressions, SUM(clicks)::text AS clicks,
            SUM(conversions)::text AS conversions, SUM(spend_usd)::text AS spend_usd,
            COUNT(*)::text AS snapshots
     FROM campaign_metrics WHERE campaign_id = $1`,
    [campaignId]
  );
  const latestRows = await query<MetricRow>(
    `SELECT * FROM campaign_metrics WHERE campaign_id = $1 ORDER BY captured_at DESC, id DESC LIMIT 1`,
    [campaignId]
  );
  const s = sums[0];
  return {
    campaignId,
    impressions: Number(s?.impressions ?? 0),
    clicks: Number(s?.clicks ?? 0),
    conversions: Number(s?.conversions ?? 0),
    spendUsd: Number(s?.spend_usd ?? 0),
    snapshots: Number(s?.snapshots ?? 0),
    latest: latestRows.length ? toMetric(latestRows[0]) : null,
  };
}

export interface CampaignSummary {
  campaign: Campaign;
  rollup: CampaignRollup;
}

/** Performance monitoring feed: campaigns + their metric rollups. */
export async function metricsSummary(opts: { businessUnitId?: number | null; limit?: number } = {}): Promise<CampaignSummary[]> {
  const campaigns = await listCampaigns({ businessUnitId: opts.businessUnitId, limit: opts.limit ?? 50 });
  const out: CampaignSummary[] = [];
  for (const c of campaigns) {
    out.push({ campaign: c, rollup: await campaignRollup(c.id) });
  }
  return out;
}

/* ------------------------------------------------------------------ */
/* Sweep support (auto-complete past end date — time semantics)         */
/* ------------------------------------------------------------------ */

export async function findExhaustedCampaigns(limit = 100): Promise<Array<{ id: number; businessUnitId: number; name: string }>> {
  const rows = await query<{ id: string | number; business_unit_id: number; name: string }>(
    `SELECT id, business_unit_id, name FROM campaigns
     WHERE status = 'active' AND ends_at IS NOT NULL AND ends_at < now()
     ORDER BY ends_at ASC LIMIT $1`,
    [limit]
  );
  return rows.map((r) => ({ id: Number(r.id), businessUnitId: r.business_unit_id, name: r.name }));
}
