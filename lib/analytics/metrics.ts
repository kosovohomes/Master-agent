/**
 * Phase 13 — deterministic metric collection (§99 aggregate contract).
 *
 * Every query here returns COUNTS, SUMS or RATES — never rows of customer
 * data. The platform scope is the §99 owner surface: cross-BU totals plus a
 * per-BU AGGREGATE breakdown (one numeric row per BU — no names, no emails,
 * no content). All windows are half-open [start, end).
 *
 * Design rule: missing tables or empty data degrade to ZEROS, never errors —
 * a fresh platform must still produce a valid report.
 */
import { query } from "../db";
import type {
  AggregateMetrics,
  BuBreakdownRow,
  MetricWindow,
  ReportCadence,
  ReportPeriodKind,
} from "./types";

/* ------------------------------------------------------------------ */
/* Period math                                                         */
/* ------------------------------------------------------------------ */

function iso(d: Date): string {
  return d.toISOString();
}

/** ISO week key like 2026-W38 (Monday-based). */
export function isoWeekKey(d: Date): string {
  const t = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
  const day = t.getUTCDay() || 7; // Mon=1..Sun=7
  t.setUTCDate(t.getUTCDate() + 4 - day); // nearest Thursday
  const yearStart = Date.UTC(t.getUTCFullYear(), 0, 1);
  const week = Math.ceil(((t.getTime() - yearStart) / 86_400_000 + 1) / 7);
  return `${t.getUTCFullYear()}-W${String(week).padStart(2, "0")}`;
}

/** The canonical period key for a cadence (research periodKeyFor pattern). */
export function periodKeyFor(kind: ReportCadence | ReportPeriodKind, now: Date = new Date()): string {
  if (kind === "daily") return now.toISOString().slice(0, 10);
  if (kind === "weekly") return isoWeekKey(now);
  if (kind === "monthly") return now.toISOString().slice(0, 7);
  return `od-${Math.floor(now.getTime() / 60_000)}`; // on_demand: minute bucket
}

export interface PeriodBounds {
  start: Date;
  end: Date;
}

/** Half-open [start, end) bounds for a named period key. */
export function periodBounds(kind: "daily" | "weekly" | "monthly", key: string): PeriodBounds {
  if (kind === "daily") {
    const start = new Date(`${key}T00:00:00.000Z`);
    const end = new Date(start.getTime() + 86_400_000);
    return { start, end };
  }
  if (kind === "weekly") {
    const m = /^(\d{4})-W(\d{2})$/.exec(key);
    if (!m) throw new Error(`invalid weekly period key: ${key}`);
    const year = Number(m[1]);
    const week = Number(m[2]);
    // Jan 4 is always in ISO week 1.
    const jan4 = new Date(Date.UTC(year, 0, 4));
    const jan4Day = jan4.getUTCDay() || 7;
    const week1Monday = new Date(jan4.getTime() - (jan4Day - 1) * 86_400_000);
    const start = new Date(week1Monday.getTime() + (week - 1) * 7 * 86_400_000);
    const end = new Date(start.getTime() + 7 * 86_400_000);
    return { start, end };
  }
  const m = /^(\d{4})-(\d{2})$/.exec(key);
  if (!m) throw new Error(`invalid monthly period key: ${key}`);
  const start = new Date(`${key}-01T00:00:00.000Z`);
  const end = new Date(Date.UTC(Number(m[1]), Number(m[2]), 1)); // first day of next month
  return { start, end };
}

/** A rolling window of `days` ending now (on_demand + dashboard default). */
export function rollingBounds(days: number, now: Date = new Date()): PeriodBounds {
  const d = Math.max(1, Math.min(365, Math.floor(days)));
  return { start: new Date(now.getTime() - d * 86_400_000), end: now };
}

/** Resolve the concrete window for a report definition. */
export function windowFor(
  kind: ReportPeriodKind,
  key: string,
  windowDays = 30
): { window: MetricWindow; bounds: PeriodBounds } {
  if (kind === "on_demand") {
    const b = rollingBounds(windowDays);
    return { window: { kind: "window", key, start: iso(b.start), end: iso(b.end) }, bounds: b };
  }
  const b = periodBounds(kind, key);
  return {
    window: { kind, key, start: iso(b.start), end: iso(b.end) },
    bounds: b,
  };
}

/* ------------------------------------------------------------------ */
/* Aggregate collection                                                */
/* ------------------------------------------------------------------ */

async function count(sql: string, params: unknown[]): Promise<number> {
  const rows = await query<{ n: number }>(sql, params);
  return Number(rows[0]?.n ?? 0);
}

async function num(sql: string, params: unknown[]): Promise<number> {
  const rows = await query<{ v: number | string | null }>(sql, params);
  const v = rows[0]?.v;
  return v == null ? 0 : Number(v);
}

/** Aggregates for exactly one scope: buId=null → platform, else one BU. */
export async function collectMetrics(
  buId: number | null,
  bounds: PeriodBounds
): Promise<AggregateMetrics> {
  const start = bounds.start.toISOString();
  const end = bounds.end.toISOString();
  const p: unknown[] = buId == null ? [start, end] : [start, end, buId];
  // Window predicates reuse $1/$2 (/$3 for BU) regardless of table. Every
  // workforce table timestamps with created_at; campaign_metrics uses
  // captured_at (joined through campaigns for the BU attribution).
  const w = "created_at >= $1 AND created_at < $2" + (buId != null ? " AND business_unit_id = $3" : "");
  const leads = w;
  const inquiries = w;
  const conversations = w;
  const content = w;
  const social = w;
  const campaigns = w;
  const llm = w;
  const research = w;
  const seo = w;
  const tasks = w;

  const [
    businessUnits, websites, users,
    leadsTotal, leadsNew, leadsQualified, leadsWon, leadsLost, leadsHot,
    inquiriesTotal, inquiriesEscalated, inquiriesSpam, inquiriesResolved,
    conversationsTotal, conversationsEscalated,
    contentItems, contentReview, contentApproved, contentPublished,
    socialPosts, socialPosted, socialFailed,
    campaignsActive, campaignsCompleted,
    mktImpressions, mktClicks, mktConversions, mktSpend,
    llmRequests, llmErrors, llmPrompt, llmCompletion, llmCost,
    researchFindings, researchEscalated,
    seoOpen,
    tasksFailed, tasksEscalated,
  ] = await Promise.all([
    count("SELECT count(*)::int AS n FROM business_units", []),
    count("SELECT count(*)::int AS n FROM websites", []),
    count("SELECT count(*)::int AS n FROM users WHERE status = 'active'", []),
    count(`SELECT count(*)::int AS n FROM leads WHERE ${leads}`, p),
    count(`SELECT count(*)::int AS n FROM leads WHERE ${leads} AND stage = 'new'`, p),
    count(`SELECT count(*)::int AS n FROM leads WHERE ${leads} AND stage IN ('qualified','engaged','proposal')`, p),
    count(`SELECT count(*)::int AS n FROM leads WHERE ${leads} AND stage = 'won'`, p),
    count(`SELECT count(*)::int AS n FROM leads WHERE ${leads} AND stage IN ('lost','dead')`, p),
    count(`SELECT count(*)::int AS n FROM leads WHERE ${leads} AND score_band = 'hot' AND stage NOT IN ('won','lost','dead','converted')`, p),
    count(`SELECT count(*)::int AS n FROM inquiries WHERE ${inquiries}`, p),
    count(`SELECT count(*)::int AS n FROM inquiries WHERE ${inquiries} AND status = 'escalated'`, p),
    count(`SELECT count(*)::int AS n FROM inquiries WHERE ${inquiries} AND classification = 'spam'`, p),
    count(`SELECT count(*)::int AS n FROM inquiries WHERE ${inquiries} AND status = 'resolved'`, p),
    count(`SELECT count(*)::int AS n FROM conversations WHERE ${conversations}`, p),
    count(`SELECT count(*)::int AS n FROM conversations WHERE ${conversations} AND status = 'escalated'`, p),
    count(`SELECT count(*)::int AS n FROM content_items WHERE ${content}`, p),
    count(`SELECT count(*)::int AS n FROM content_items WHERE ${content} AND lifecycle IN ('FACT_CHECK','REVIEW')`, p),
    count(`SELECT count(*)::int AS n FROM content_items WHERE ${content} AND lifecycle = 'APPROVED'`, p),
    count(`SELECT count(*)::int AS n FROM content_items WHERE ${content} AND lifecycle = 'PUBLISHED'`, p),
    count(`SELECT count(*)::int AS n FROM social_posts WHERE ${social}`, p),
    count(`SELECT count(*)::int AS n FROM social_posts WHERE ${social} AND status = 'posted'`, p),
    count(`SELECT count(*)::int AS n FROM social_posts WHERE ${social} AND status = 'failed'`, p),
    count(`SELECT count(*)::int AS n FROM campaigns WHERE ${campaigns} AND status = 'active'`, p),
    count(`SELECT count(*)::int AS n FROM campaigns WHERE ${campaigns} AND status = 'completed'`, p),
    num(
      `SELECT COALESCE(sum(cm.impressions), 0) AS v FROM campaign_metrics cm
       JOIN campaigns c ON c.id = cm.campaign_id
       WHERE cm.captured_at >= $1 AND cm.captured_at < $2${buId != null ? " AND c.business_unit_id = $3" : ""}`,
      p
    ),
    num(
      `SELECT COALESCE(sum(cm.clicks), 0) AS v FROM campaign_metrics cm
       JOIN campaigns c ON c.id = cm.campaign_id
       WHERE cm.captured_at >= $1 AND cm.captured_at < $2${buId != null ? " AND c.business_unit_id = $3" : ""}`,
      p
    ),
    num(
      `SELECT COALESCE(sum(cm.conversions), 0) AS v FROM campaign_metrics cm
       JOIN campaigns c ON c.id = cm.campaign_id
       WHERE cm.captured_at >= $1 AND cm.captured_at < $2${buId != null ? " AND c.business_unit_id = $3" : ""}`,
      p
    ),
    num(
      `SELECT COALESCE(sum(cm.spend_usd), 0) AS v FROM campaign_metrics cm
       JOIN campaigns c ON c.id = cm.campaign_id
       WHERE cm.captured_at >= $1 AND cm.captured_at < $2${buId != null ? " AND c.business_unit_id = $3" : ""}`,
      p
    ),
    count(`SELECT count(*)::int AS n FROM llm_requests WHERE ${llm}`, p),
    count(`SELECT count(*)::int AS n FROM llm_requests WHERE ${llm} AND status <> 'ok'`, p),
    num(`SELECT COALESCE(sum(prompt_tokens), 0) AS v FROM llm_requests WHERE ${llm}`, p),
    num(`SELECT COALESCE(sum(completion_tokens), 0) AS v FROM llm_requests WHERE ${llm}`, p),
    num(`SELECT COALESCE(sum(cost_usd), 0) AS v FROM llm_requests WHERE ${llm}`, p),
    count(`SELECT count(*)::int AS n FROM research_items WHERE ${research} AND status = 'finding'`, p),
    count(`SELECT count(*)::int AS n FROM research_items WHERE ${research} AND status = 'escalated'`, p),
    count(`SELECT count(*)::int AS n FROM seo_recommendations WHERE ${seo} AND status = 'open'`, p),
    count(`SELECT count(*)::int AS n FROM tasks WHERE ${tasks} AND status = 'failed'`, p),
    count(`SELECT count(*)::int AS n FROM tasks WHERE ${tasks} AND status = 'escalated'`, p),
  ]);

  return {
    businessUnits, websites, users,
    leads: { total: leadsTotal, newStage: leadsNew, qualified: leadsQualified, won: leadsWon, lost: leadsLost, hotOpen: leadsHot },
    inquiries: { total: inquiriesTotal, escalated: inquiriesEscalated, spam: inquiriesSpam, resolved: inquiriesResolved },
    conversations: { total: conversationsTotal, escalated: conversationsEscalated },
    content: { items: contentItems, inReview: contentReview, approved: contentApproved, published: contentPublished },
    social: { posts: socialPosts, published: socialPosted, failed: socialFailed },
    campaigns: { active: campaignsActive, completed: campaignsCompleted },
    marketing: {
      impressions: mktImpressions, clicks: mktClicks,
      conversions: mktConversions, spendUsd: Math.round(mktSpend * 100) / 100,
    },
    llm: {
      requests: llmRequests, errors: llmErrors,
      promptTokens: llmPrompt, completionTokens: llmCompletion,
      costUsd: Math.round(llmCost * 1_000_000) / 1_000_000,
    },
    research: { findings: researchFindings, escalated: researchEscalated },
    seo: { openRecommendations: seoOpen },
    tasks: { failed: tasksFailed, escalated: tasksEscalated },
  };
}

/**
 * The §99 cross-BU breakdown: ONE aggregate row per BU (numbers only).
 * `buIds` is the caller's AUTHORIZED scope — the caller (service/route)
 * derives it from buScopeForUser; this function never widens it. Empty
 * scope → empty breakdown (fail closed).
 */
export async function buBreakdown(
  buIds: number[],
  bounds: PeriodBounds
): Promise<BuBreakdownRow[]> {
  if (buIds.length === 0) return [];
  const start = bounds.start.toISOString();
  const end = bounds.end.toISOString();
  const rows = await query<{
    id: number; name: string; leads: number; hot_leads: number; inquiries: number;
    escalated_inquiries: number; content_items: number; social_posts: number;
    spend_usd: number | string | null; llm_requests: number; llm_cost_usd: number | string | null;
  }>(
    `SELECT b.id, b.name,
       (SELECT count(*)::int FROM leads l WHERE l.business_unit_id = b.id AND l.created_at >= $1 AND l.created_at < $2) AS leads,
       (SELECT count(*)::int FROM leads l WHERE l.business_unit_id = b.id AND l.created_at >= $1 AND l.created_at < $2 AND l.score_band = 'hot' AND l.stage NOT IN ('won','lost','dead','converted')) AS hot_leads,
       (SELECT count(*)::int FROM inquiries i WHERE i.business_unit_id = b.id AND i.created_at >= $1 AND i.created_at < $2) AS inquiries,
       (SELECT count(*)::int FROM inquiries i WHERE i.business_unit_id = b.id AND i.created_at >= $1 AND i.created_at < $2 AND i.status = 'escalated') AS escalated_inquiries,
       (SELECT count(*)::int FROM content_items ci WHERE ci.business_unit_id = b.id AND ci.created_at >= $1 AND ci.created_at < $2) AS content_items,
       (SELECT count(*)::int FROM social_posts sp WHERE sp.business_unit_id = b.id AND sp.created_at >= $1 AND sp.created_at < $2) AS social_posts,
       (SELECT COALESCE(sum(cm.spend_usd), 0) FROM campaign_metrics cm JOIN campaigns c ON c.id = cm.campaign_id WHERE c.business_unit_id = b.id AND cm.captured_at >= $1 AND cm.captured_at < $2) AS spend_usd,
       (SELECT count(*)::int FROM llm_requests lr WHERE lr.business_unit_id = b.id AND lr.created_at >= $1 AND lr.created_at < $2) AS llm_requests,
       (SELECT COALESCE(sum(lr.cost_usd), 0) FROM llm_requests lr WHERE lr.business_unit_id = b.id AND lr.created_at >= $1 AND lr.created_at < $2) AS llm_cost_usd
     FROM business_units b
     WHERE b.id = ANY($3::int[])
     ORDER BY b.id ASC`,
    [start, end, buIds]
  );
  return rows.map((r) => ({
    businessUnitId: Number(r.id),
    businessUnitName: r.name,
    leads: Number(r.leads),
    hotLeads: Number(r.hot_leads),
    inquiries: Number(r.inquiries),
    escalatedInquiries: Number(r.escalated_inquiries),
    contentItems: Number(r.content_items),
    socialPosts: Number(r.social_posts),
    campaignSpendUsd: Math.round(Number(r.spend_usd ?? 0) * 100) / 100,
    llmRequests: Number(r.llm_requests),
    llmCostUsd: Math.round(Number(r.llm_cost_usd ?? 0) * 1_000_000) / 1_000_000,
  }));
}
