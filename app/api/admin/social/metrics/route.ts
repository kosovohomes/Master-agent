import { NextResponse } from "next/server";
import { requirePermission } from "@/lib/auth/guards";
import { ingestMetrics } from "@/lib/social/service";
import { SocialServiceError } from "@/lib/social/types";
import { writeAudit, requestIdFor } from "@/lib/audit";

export const runtime = "nodejs";

function nonNeg(v: unknown): number | null {
  const n = Number(v);
  return Number.isFinite(n) && n >= 0 ? Math.floor(n) : null;
}

/**
 * /api/admin/social/metrics (Phase 10 — metrics ingestion, §466).
 *  POST — social.manage: {socialPostId, impressions?, likes?, comments?,
 *         shares?, clicks?, raw?}. Manual/webhook ingestion; the sweep's
 *         provider pull is the other source. Audited.
 */
export async function POST(req: Request) {
  const requestId = requestIdFor(req);
  const gate = await requirePermission(req, "social.manage");
  if (!gate.ok) return gate.response;

  let body: Record<string, unknown>;
  try {
    body = (await req.json()) as Record<string, unknown>;
  } catch {
    return NextResponse.json({ errors: [{ code: "INVALID_JSON" }] }, { status: 400 });
  }

  const socialPostId = Number(body.socialPostId);
  if (!Number.isInteger(socialPostId) || socialPostId <= 0) {
    return NextResponse.json({ errors: [{ code: "SOCIAL_POST_ID_REQUIRED" }] }, { status: 400 });
  }

  try {
    const metric = await ingestMetrics({
      socialPostId,
      impressions: nonNeg(body.impressions),
      likes: nonNeg(body.likes),
      comments: nonNeg(body.comments),
      shares: nonNeg(body.shares),
      clicks: nonNeg(body.clicks),
      raw: (body.raw && typeof body.raw === "object" ? body.raw : {}) as Record<string, unknown>,
      source: "manual",
    });
    await writeAudit({
      actorType: "user",
      actorId: gate.ctx.user?.id ?? null,
      action: "social.metrics.ingest",
      resource: "social_post_metrics",
      resourceId: metric.id,
      result: "success",
      requestId,
      metadata: { socialPostId },
    });
    return NextResponse.json({ data: { metric }, meta: { requestId } });
  } catch (e) {
    const code = e instanceof SocialServiceError ? e.code : "METRICS_INGEST_FAILED";
    const status = code === "NOT_FOUND" ? 404 : 500;
    return NextResponse.json({ errors: [{ code }] }, { status });
  }
}
