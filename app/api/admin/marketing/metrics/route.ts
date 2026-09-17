import { NextResponse } from "next/server";
import { requirePermission, requireAnyPermission } from "@/lib/auth/guards";
import { ingestMetrics, metricsSummary } from "@/lib/marketing/service";
import { MarketingServiceError, MetricSource } from "@/lib/marketing/types";
import { writeAudit, requestIdFor } from "@/lib/audit";

export const runtime = "nodejs";

/**
 * /api/admin/marketing/metrics (Phase 11 — performance monitoring, §468).
 *  GET  — marketing.manage / audit.read: per-campaign rollups.
 *  POST — marketing.manage: ingest a metric snapshot {campaignId,
 *         impressions?, clicks?, conversions?, spendUsd?, source?, raw?}.
 *         Append-only snapshots; rollups SUM over them. Audited.
 */
export async function GET(req: Request) {
  const requestId = requestIdFor(req);
  const gate = await requireAnyPermission(req, ["marketing.manage", "audit.read"]);
  if (!gate.ok) return gate.response;

  const url = new URL(req.url);
  const buRaw = url.searchParams.get("businessUnitId");
  const businessUnitId = buRaw && /^\d+$/.test(buRaw) ? Number(buRaw) : null;
  const metrics = await metricsSummary({ businessUnitId, limit: 50 });
  return NextResponse.json({ data: { metrics }, meta: { requestId } });
}

export async function POST(req: Request) {
  const requestId = requestIdFor(req);
  const gate = await requirePermission(req, "marketing.manage");
  if (!gate.ok) return gate.response;

  let body: Record<string, unknown>;
  try {
    body = (await req.json()) as Record<string, unknown>;
  } catch {
    return NextResponse.json({ errors: [{ code: "INVALID_JSON" }] }, { status: 400 });
  }

  const campaignId = Number(body.campaignId);
  if (!Number.isInteger(campaignId) || campaignId <= 0) {
    return NextResponse.json({ errors: [{ code: "INVALID_ID" }] }, { status: 400 });
  }
  const source: MetricSource = typeof body.source === "string" && ["manual", "provider", "derived"].includes(body.source)
    ? (body.source as MetricSource)
    : "manual";

  try {
    const metric = await ingestMetrics({
      campaignId,
      impressions: body.impressions != null ? Number(body.impressions) : null,
      clicks: body.clicks != null ? Number(body.clicks) : null,
      conversions: body.conversions != null ? Number(body.conversions) : null,
      spendUsd: body.spendUsd != null ? Number(body.spendUsd) : null,
      source,
      raw: (body.raw ?? {}) as Record<string, unknown>,
    });
    await writeAudit({
      actorType: "user",
      actorId: gate.ctx.user?.id ?? null,
      action: "marketing.metrics.ingest",
      resource: "campaign_metrics",
      resourceId: metric.id,
      result: "success",
      requestId,
      metadata: { campaignId, source },
    });
    return NextResponse.json({ data: { metric }, meta: { requestId } }, { status: 201 });
  } catch (e) {
    const code = e instanceof MarketingServiceError ? e.code : "METRICS_INGEST_FAILED";
    const status = code === "NOT_FOUND" ? 404 : 500;
    return NextResponse.json({ errors: [{ code }] }, { status });
  }
}
