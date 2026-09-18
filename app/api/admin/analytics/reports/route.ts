import { NextResponse } from "next/server";
import { requirePermission, requireAnyPermission } from "@/lib/auth/guards";
import { buScopeForUser } from "@/lib/auth/rbac";
import { query } from "@/lib/db";
import {
  createReport,
  getReportForScope,
  listReports,
  type AnalyticsScope,
} from "@/lib/analytics/service";
import type { ReportRecord } from "@/lib/analytics/types";
import { periodKeyFor } from "@/lib/analytics/metrics";
import { processReport } from "@/lib/analytics/tasks";
import { AnalyticsServiceError } from "@/lib/analytics/types";
import { isFlagEnabled } from "@/lib/settings";
import { writeAudit, requestIdFor } from "@/lib/audit";

export const runtime = "nodejs";
export const maxDuration = 60;

/**
 * /api/admin/analytics/reports (Phase 13 — on-demand digest generation).
 *
 * POST — analytics.manage ONLY (mutations are narrower than reads).
 *   Body: { businessUnitId?: number|null, days?: number }
 *   - businessUnitId omitted/null → PLATFORM report (§99 owner surface);
 *     a scope-limited caller asking for platform gets 403, and for a BU
 *     outside their scope 404 (existence not leaked).
 *   - On-demand reports dedup on a minute bucket — a double-click returns
 *     the same report (created:false → 200), a new minute generates anew.
 *   - The pipeline runs INLINE (operator is waiting; sales-classify
 *     pattern); LLM legs ride the gateway with attribution and degrade to
 *     the deterministic floor on any failure. The `analytics` flag gates
 *     the whole operation (423 when OFF — operator-invoked legs fail
 *     closed, unlike the read surface).
 */
export async function POST(req: Request) {
  const requestId = requestIdFor(req);
  const gate = await requirePermission(req, "analytics.manage");
  if (!gate.ok) return gate.response;
  const user = gate.ctx.user;
  const userId = user?.id ?? null;

  let body: Record<string, unknown> = {};
  try {
    body = (await req.json()) as Record<string, unknown>;
  } catch {
    body = {};
  }

  const analyticsFlag = await isFlagEnabled("analytics", false);
  if (!analyticsFlag) {
    await writeAudit({
      actorType: "user", actorId: userId, action: "analytics.report.create", resource: "reports",
      result: "denied", requestId,
      metadata: { reason: "analytics_flag_off" },
    });
    return NextResponse.json({ errors: [{ code: "FLAG_DISABLED", detail: "analytics flag is OFF" }] }, { status: 423 });
  }

  const scope: AnalyticsScope = user ? await buScopeForUser(user.id) : { kind: "list", businessUnitIds: [] };

  // Resolve + authorize the requested scope.
  const buRaw = body.businessUnitId;
  let businessUnitId: number | null = null;
  if (buRaw != null) {
    if (typeof buRaw !== "number" || !Number.isInteger(buRaw) || buRaw <= 0) {
      return NextResponse.json({ errors: [{ code: "INVALID_BUSINESS_UNIT" }] }, { status: 400 });
    }
    if (scope.kind === "list" && !scope.businessUnitIds.includes(buRaw)) {
      // Existence of other BUs is not leaked to scope-limited callers.
      return NextResponse.json({ errors: [{ code: "NOT_FOUND" }] }, { status: 404 });
    }
    const exists = await query<{ id: number }>("SELECT id FROM business_units WHERE id = $1", [buRaw]);
    if (exists.length === 0) {
      return NextResponse.json({ errors: [{ code: "NOT_FOUND" }] }, { status: 404 });
    }
    businessUnitId = buRaw;
  } else if (scope.kind === "list") {
    return NextResponse.json({
      errors: [{ code: "FORBIDDEN_PLATFORM", detail: "platform-wide reports require an owner-level scope" }],
    }, { status: 403 });
  }

  const daysRaw = body.days;
  const days = typeof daysRaw === "number" && Number.isInteger(daysRaw) ? Math.max(1, Math.min(365, daysRaw)) : 30;
  const periodKey = periodKeyFor("on_demand", new Date());

  try {
    const { report, created } = await createReport({
      businessUnitId,
      periodKind: "on_demand",
      periodKey,
      title: businessUnitId == null ? `Platform on-demand digest (${periodKey})` : `BU #${businessUnitId} on-demand digest (${periodKey})`,
      createdByUserId: userId,
      metadata: { days, requestedVia: "admin_api" },
    });
    const finalReport = report.status === "ready"
      ? report
      : await runAndComplete(report.id, created, scope, userId, businessUnitId, days, requestId);
    return NextResponse.json(
      { data: { report: finalReport, created }, meta: { requestId } },
      { status: created ? 201 : 200 }
    );
  } catch (e) {
    const code = e instanceof AnalyticsServiceError ? e.code : "REPORT_CREATE_FAILED";
    const status = e instanceof AnalyticsServiceError ? e.httpStatus : 500;
    return NextResponse.json({ errors: [{ code }] }, { status });
  }
}

/** Runs the pipeline inline (unless another request already landed it) and returns the §99-visible record. */
async function runAndComplete(
  reportId: number,
  created: boolean,
  scope: AnalyticsScope,
  userId: number | null,
  businessUnitId: number | null,
  days: number,
  requestId: string
): Promise<ReportRecord> {
  let report = await getReportForScope(reportId, scope);
  if (!report) {
    throw new AnalyticsServiceError("NOT_FOUND", 404, `report ${reportId} not found`);
  }
  if (report.status !== "ready") {
    const { ai } = await import("@/lib/ai");
    const llm = ai.withAttribution({ businessUnitId: report.businessUnitId ?? undefined, purpose: "reporting" });
    await processReport(reportId, { llm, allowLlm: true, windowDays: days });
    report = await getReportForScope(reportId, scope);
    if (!report) {
      throw new AnalyticsServiceError("NOT_FOUND", 404, `report ${reportId} not found`);
    }
  }
  await writeAudit({
    actorType: "user", actorId: userId, action: "analytics.report.create", resource: "reports",
    resourceId: String(reportId), result: "success", requestId,
    metadata: { businessUnitId, days, created, degraded: report.degraded, generatedBy: report.generatedBy },
  });
  return report;
}

/**
 * GET — analytics.manage / audit.read: recent reports for the caller's
 * scope (read-side; the main GET surface also embeds this list).
 */
export async function GET(req: Request) {
  const requestId = requestIdFor(req);
  const gate = await requireAnyPermission(req, ["analytics.manage", "audit.read"]);
  if (!gate.ok) return gate.response;
  const user = gate.ctx.user;
  const scope: AnalyticsScope = user ? await buScopeForUser(user.id) : { kind: "list", businessUnitIds: [] };
  const reports = await listReports(scope, 50);
  return NextResponse.json({ data: { reports }, meta: { requestId } });
}
