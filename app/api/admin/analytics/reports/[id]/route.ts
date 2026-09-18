import { NextResponse } from "next/server";
import { requireAnyPermission } from "@/lib/auth/guards";
import { buScopeForUser } from "@/lib/auth/rbac";
import { getReportForScope, type AnalyticsScope } from "@/lib/analytics/service";
import { requestIdFor } from "@/lib/audit";

export const runtime = "nodejs";

/**
 * /api/admin/analytics/reports/[id] (Phase 13).
 * GET — analytics.manage / audit.read: the full report record (payload +
 * narrative + provenance). §99 privacy: a scope-limited caller gets 404
 * for platform reports and for other BUs' reports — existence is not
 * leaked, and the payload itself is aggregate-only by construction.
 */
export async function GET(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const requestId = requestIdFor(req);
  const gate = await requireAnyPermission(req, ["analytics.manage", "audit.read"]);
  if (!gate.ok) return gate.response;
  const user = gate.ctx.user;

  const { id: idRaw } = await ctx.params;
  const id = Number(idRaw);
  if (!Number.isInteger(id) || id <= 0) {
    return NextResponse.json({ errors: [{ code: "INVALID_ID" }] }, { status: 400 });
  }

  const scope: AnalyticsScope = user ? await buScopeForUser(user.id) : { kind: "list", businessUnitIds: [] };
  const report = await getReportForScope(id, scope);
  if (!report) {
    return NextResponse.json({ errors: [{ code: "NOT_FOUND" }] }, { status: 404 });
  }
  return NextResponse.json({ data: { report }, meta: { requestId } });
}
