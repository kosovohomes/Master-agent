import { NextResponse } from "next/server";
import { requirePermission } from "@/lib/auth/guards";
import { buScopeForUser } from "@/lib/auth/rbac";
import {
  getRecommendationForScope,
  transitionRecommendation,
  type AnalyticsScope,
} from "@/lib/analytics/service";
import { AnalyticsServiceError } from "@/lib/analytics/types";
import { writeAudit, requestIdFor } from "@/lib/audit";

export const runtime = "nodejs";

/**
 * /api/admin/analytics/recommendations/[id] (Phase 13).
 * POST — analytics.manage: THE human doorway on strategy advice.
 *   Body: { action: "accept" | "dismiss" }
 *   FSM: open → accepted|dismissed (both terminal; first transition wins,
 *   review stamp immutable). §99 privacy: scope-limited callers get 404
 *   for platform recommendations and other BUs' rows. Audited.
 */
export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const requestId = requestIdFor(req);
  const gate = await requirePermission(req, "analytics.manage");
  if (!gate.ok) return gate.response;
  const user = gate.ctx.user;
  const userId = user?.id ?? null;

  const { id: idRaw } = await ctx.params;
  const id = Number(idRaw);
  if (!Number.isInteger(id) || id <= 0) {
    return NextResponse.json({ errors: [{ code: "INVALID_ID" }] }, { status: 400 });
  }

  let body: Record<string, unknown> = {};
  try {
    body = (await req.json()) as Record<string, unknown>;
  } catch {
    return NextResponse.json({ errors: [{ code: "INVALID_JSON" }] }, { status: 400 });
  }
  const action = body.action;
  if (action !== "accept" && action !== "dismiss") {
    return NextResponse.json({ errors: [{ code: "INVALID_ACTION", detail: "action must be accept|dismiss" }] }, { status: 400 });
  }

  const scope: AnalyticsScope = user ? await buScopeForUser(user.id) : { kind: "list", businessUnitIds: [] };

  // Existence + visibility check BEFORE the transition (404 must not leak
  // cross-scope rows; the transition itself is scope-blind by id).
  const visible = await getRecommendationForScope(id, scope);
  if (!visible) {
    return NextResponse.json({ errors: [{ code: "NOT_FOUND" }] }, { status: 404 });
  }

  try {
    const rec = await transitionRecommendation(id, action, user ? `user:${user.id}` : "user:unknown");
    await writeAudit({
      actorType: "user", actorId: userId, action: "analytics.recommendation.transition", resource: "strategy_recommendations",
      resourceId: String(id), result: "success", requestId,
      metadata: { action, to: rec.status, kind: rec.kind, priority: rec.priority },
    });
    return NextResponse.json({ data: { recommendation: rec }, meta: { requestId } });
  } catch (e) {
    if (e instanceof AnalyticsServiceError) {
      await writeAudit({
        actorType: "user", actorId: userId, action: "analytics.recommendation.transition", resource: "strategy_recommendations",
        resourceId: String(id), result: "failure", requestId,
        metadata: { action, code: e.code },
      });
      return NextResponse.json({ errors: [{ code: e.code }] }, { status: e.httpStatus });
    }
    return NextResponse.json({ errors: [{ code: "TRANSITION_FAILED" }] }, { status: 500 });
  }
}
