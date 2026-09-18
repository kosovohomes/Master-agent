import { NextResponse } from "next/server";
import { requireAnyPermission } from "@/lib/auth/guards";
import { buScopeForUser } from "@/lib/auth/rbac";
import { query } from "@/lib/db";
import {
  analyticsSummary,
  listRecommendations,
  listReports,
  listSchedules,
  type AnalyticsScope,
} from "@/lib/analytics/service";
import { collectMetrics, buBreakdown, rollingBounds } from "@/lib/analytics/metrics";
import { isFlagEnabled } from "@/lib/settings";
import { requestIdFor } from "@/lib/audit";

export const runtime = "nodejs";

/**
 * /api/admin/analytics (Phase 13 — cross-BU aggregate control surface, §99).
 *
 * GET — analytics.manage / audit.read. The §99 privacy law, enforced by
 * CONSTRUCTION + SCOPE:
 *   1. Everything returned is a COUNT or SUM — no customer rows, names,
 *      emails or content ever leave the aggregate layer.
 *   2. buScopeForUser drives visibility: kind="all" (owner/administrator)
 *      gets the platform surface incl. the per-BU aggregate breakdown and
 *      platform (bu NULL) reports; kind="list" gets ONLY their own BUs —
 *      platform rows are invisible to them (listReports/listRecommendations/
 *      listSchedules all take the scope).
 */
export async function GET(req: Request) {
  const requestId = requestIdFor(req);
  const gate = await requireAnyPermission(req, ["analytics.manage", "audit.read"]);
  if (!gate.ok) return gate.response;
  const user = gate.ctx.user;

  const scope: AnalyticsScope = user
    ? await buScopeForUser(user.id)
    : { kind: "list", businessUnitIds: [] };

  const url = new URL(req.url);
  const daysRaw = url.searchParams.get("days");
  const days = daysRaw && /^\d+$/.test(daysRaw) ? Math.max(1, Math.min(365, Number(daysRaw))) : 30;
  const bounds = rollingBounds(days);

  const authorizedBuIds =
    scope.kind === "all"
      ? (await query<{ id: number }>("SELECT id FROM business_units ORDER BY id ASC")).map((r) => Number(r.id))
      : scope.businessUnitIds;

  const [metrics, breakdown, reports, recommendations, schedules, summary, analyticsFlag] = await Promise.all([
    scope.kind === "all"
      ? collectMetrics(null, bounds)
      : authorizedBuIds.length > 0
        ? sumBuMetrics(authorizedBuIds, bounds)
        : zeroMetrics(),
    buBreakdown(authorizedBuIds, bounds),
    listReports(scope, 20),
    listRecommendations(scope, { limit: 25 }),
    listSchedules(scope),
    analyticsSummary(scope),
    isFlagEnabled("analytics", false),
  ]);

  return NextResponse.json({
    data: {
      scope: scope.kind,
      windowDays: days,
      metrics,
      breakdown,
      reports,
      recommendations,
      schedules,
      summary,
      flags: { analytics: analyticsFlag },
    },
    meta: { requestId },
  });
}

/* ------------------------------------------------------------------ */
/* Scope-limited union (kind="list"): sum the caller's own BUs only    */
/* ------------------------------------------------------------------ */

async function sumBuMetrics(buIds: number[], bounds: ReturnType<typeof rollingBounds>) {
  const parts = await Promise.all(buIds.map((id) => collectMetrics(id, bounds)));
  if (parts.length === 0) return zeroMetrics();
  const add = (a: number, b: number) => a + b;
  return parts.reduce((acc, cur) => ({
    businessUnits: acc.businessUnits,
    websites: acc.websites,
    users: acc.users,
    leads: {
      total: add(acc.leads.total, cur.leads.total), newStage: add(acc.leads.newStage, cur.leads.newStage),
      qualified: add(acc.leads.qualified, cur.leads.qualified), won: add(acc.leads.won, cur.leads.won),
      lost: add(acc.leads.lost, cur.leads.lost), hotOpen: add(acc.leads.hotOpen, cur.leads.hotOpen),
    },
    inquiries: {
      total: add(acc.inquiries.total, cur.inquiries.total), escalated: add(acc.inquiries.escalated, cur.inquiries.escalated),
      spam: add(acc.inquiries.spam, cur.inquiries.spam), resolved: add(acc.inquiries.resolved, cur.inquiries.resolved),
    },
    conversations: { total: add(acc.conversations.total, cur.conversations.total), escalated: add(acc.conversations.escalated, cur.conversations.escalated) },
    content: {
      items: add(acc.content.items, cur.content.items), inReview: add(acc.content.inReview, cur.content.inReview),
      approved: add(acc.content.approved, cur.content.approved), published: add(acc.content.published, cur.content.published),
    },
    social: { posts: add(acc.social.posts, cur.social.posts), published: add(acc.social.published, cur.social.published), failed: add(acc.social.failed, cur.social.failed) },
    campaigns: { active: add(acc.campaigns.active, cur.campaigns.active), completed: add(acc.campaigns.completed, cur.campaigns.completed) },
    marketing: {
      impressions: add(acc.marketing.impressions, cur.marketing.impressions), clicks: add(acc.marketing.clicks, cur.marketing.clicks),
      conversions: add(acc.marketing.conversions, cur.marketing.conversions), spendUsd: Math.round((acc.marketing.spendUsd + cur.marketing.spendUsd) * 100) / 100,
    },
    llm: {
      requests: add(acc.llm.requests, cur.llm.requests), errors: add(acc.llm.errors, cur.llm.errors),
      promptTokens: add(acc.llm.promptTokens, cur.llm.promptTokens), completionTokens: add(acc.llm.completionTokens, cur.llm.completionTokens),
      costUsd: Math.round((acc.llm.costUsd + cur.llm.costUsd) * 1_000_000) / 1_000_000,
    },
    research: { findings: add(acc.research.findings, cur.research.findings), escalated: add(acc.research.escalated, cur.research.escalated) },
    seo: { openRecommendations: add(acc.seo.openRecommendations, cur.seo.openRecommendations) },
    tasks: { failed: add(acc.tasks.failed, cur.tasks.failed), escalated: add(acc.tasks.escalated, cur.tasks.escalated) },
  }));
}

function zeroMetrics() {
  const z = 0;
  return {
    businessUnits: z, websites: z, users: z,
    leads: { total: z, newStage: z, qualified: z, won: z, lost: z, hotOpen: z },
    inquiries: { total: z, escalated: z, spam: z, resolved: z },
    conversations: { total: z, escalated: z },
    content: { items: z, inReview: z, approved: z, published: z },
    social: { posts: z, published: z, failed: z },
    campaigns: { active: z, completed: z },
    marketing: { impressions: z, clicks: z, conversions: z, spendUsd: z },
    llm: { requests: z, errors: z, promptTokens: z, completionTokens: z, costUsd: z },
    research: { findings: z, escalated: z },
    seo: { openRecommendations: z },
    tasks: { failed: z, escalated: z },
  };
}
