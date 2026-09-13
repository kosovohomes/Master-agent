import { NextResponse } from "next/server";
import { requireAnyPermission, requirePermission } from "@/lib/auth/guards";
import {
  listKeywords,
  listRecommendations,
  stats,
} from "@/lib/seo/service";
import type { SeoKeywordIntent, SeoKeywordStatus, SeoRecommendationKind, SeoRecommendationStatus } from "@/lib/seo/types";
import { spawnTask } from "@/lib/tasks/queue";
import { isFlagEnabled } from "@/lib/settings";
import { writeAudit, requestIdFor } from "@/lib/audit";
import { ensureRegisteredForApi } from "@/lib/tasks/bootstrap";

export const runtime = "nodejs";

const KEYWORD_INTENTS: SeoKeywordIntent[] = ["informational", "commercial", "transactional", "navigational"];
const REC_KINDS: SeoRecommendationKind[] = ["on_page", "technical", "content", "keyword", "gap"];
const REC_STATUSES: SeoRecommendationStatus[] = ["open", "approved", "dismissed", "done"];
const KEYWORD_STATUSES: SeoKeywordStatus[] = ["active", "retired"];

/**
 * /api/admin/seo (Phase 9 — SEO workforce control surface).
 *  GET  — seo.manage / audit.read: keywords (filterable), recommendations
 *         (filterable), per-status stats, flag state.
 *  POST — seo.manage: spawn an seo_scan task for a BU
 *         {businessUnitId}. Audited; the scan is durable (task engine),
 *         so the response returns the task id — the dashboard polls the
 *         task status. Flag-off scans still spawn (the handler skips
 *         fail-closed) so the audit trail shows who attempted what; the
 *         /seo screen communicates the flag state.
 */
export async function GET(req: Request) {
  const requestId = requestIdFor(req);
  const gate = await requireAnyPermission(req, ["seo.manage", "audit.read"]);
  if (!gate.ok) return gate.response;

  const url = new URL(req.url);
  const buRaw = url.searchParams.get("businessUnitId");
  const businessUnitId = buRaw && /^\d+$/.test(buRaw) ? Number(buRaw) : null;

  const kwStatusRaw = url.searchParams.get("keywordStatus");
  const keywordStatus = KEYWORD_STATUSES.includes(kwStatusRaw as SeoKeywordStatus)
    ? (kwStatusRaw as SeoKeywordStatus)
    : null;
  const intentRaw = url.searchParams.get("intent");
  const intent = KEYWORD_INTENTS.includes(intentRaw as SeoKeywordIntent)
    ? (intentRaw as SeoKeywordIntent)
    : null;
  const recStatusRaw = url.searchParams.get("recommendationStatus");
  const recommendationStatus = REC_STATUSES.includes(recStatusRaw as SeoRecommendationStatus)
    ? (recStatusRaw as SeoRecommendationStatus)
    : null;
  const kindRaw = url.searchParams.get("kind");
  const kind = REC_KINDS.includes(kindRaw as SeoRecommendationKind)
    ? (kindRaw as SeoRecommendationKind)
    : null;

  const [keywords, recommendations, statRows, flag] = await Promise.all([
    listKeywords({ businessUnitId, status: keywordStatus ?? "active", intent, limit: 200 }),
    listRecommendations({ businessUnitId, status: recommendationStatus, kind, limit: 100 }),
    stats(businessUnitId),
    isFlagEnabled("seo", false),
  ]);
  return NextResponse.json({
    data: { keywords, recommendations, stats: statRows, flag },
    meta: { requestId },
  });
}

export async function POST(req: Request) {
  const requestId = requestIdFor(req);
  const gate = await requirePermission(req, "seo.manage");
  if (!gate.ok) return gate.response;

  let body: Record<string, unknown>;
  try {
    body = (await req.json()) as Record<string, unknown>;
  } catch {
    return NextResponse.json({ errors: [{ code: "INVALID_JSON" }] }, { status: 400 });
  }

  const businessUnitId = Number(body.businessUnitId);
  if (!Number.isInteger(businessUnitId) || businessUnitId <= 0) {
    return NextResponse.json({ errors: [{ code: "BUSINESS_UNIT_ID_REQUIRED" }] }, { status: 400 });
  }

  await ensureRegisteredForApi();
  const spawned = await spawnTask({
    businessUnitId,
    kind: "seo_scan",
    payload: { businessUnitId },
    priority: 100,
    maxAttempts: 3,
    idempotencyKey: `seo_scan:manual:${businessUnitId}:${Date.now()}`,
    createdBy: `user:${gate.ctx.user?.id ?? "unknown"}`,
  });

  await writeAudit({
    actorType: "user",
    actorId: gate.ctx.user?.id ?? null,
    action: "seo.scan.spawn",
    resource: "tasks",
    resourceId: spawned.taskId,
    result: "success",
    requestId,
    metadata: { businessUnitId, kind: "seo_scan", duplicate: !spawned.created },
  });
  return NextResponse.json({ data: { taskId: spawned.taskId, created: spawned.created }, meta: { requestId } });
}
