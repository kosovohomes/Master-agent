import { NextResponse } from "next/server";
import { requirePermission } from "@/lib/auth/guards";
import { transitionRecommendation, SeoServiceError } from "@/lib/seo/service";
import type { SeoRecommendationStatus } from "@/lib/seo/types";
import { writeAudit, requestIdFor } from "@/lib/audit";

export const runtime = "nodejs";

const ACTIONS: Record<string, SeoRecommendationStatus> = {
  approve: "approved",
  dismiss: "dismissed",
  complete: "done",
};

/**
 * /api/admin/seo/recommendations/[id] (Phase 9 — approval flags).
 *  PATCH — seo.manage: {action: approve | dismiss | complete}
 *    approve   open → approved   (reviewer identity stamped immutably)
 *    dismiss   open → dismissed  (terminal)
 *    complete  approved → done   (work executed; approved → done only)
 *  Transitions are the FSM in lib/seo/service: illegal jumps 400,
 *  concurrent decisions 400/conflict (exactly one caller wins, §72 class).
 *  Every decision is audited WITH the reviewer identity; no secrets.
 */
export async function PATCH(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const requestId = requestIdFor(req);
  const gate = await requirePermission(req, "seo.manage");
  if (!gate.ok) return gate.response;

  const { id: idRaw } = await ctx.params;
  const id = Number(idRaw);
  if (!Number.isInteger(id) || id <= 0) {
    return NextResponse.json({ errors: [{ code: "INVALID_ID" }] }, { status: 400 });
  }

  let body: Record<string, unknown>;
  try {
    body = (await req.json()) as Record<string, unknown>;
  } catch {
    return NextResponse.json({ errors: [{ code: "INVALID_JSON" }] }, { status: 400 });
  }

  const action = String(body.action ?? "");
  const next = ACTIONS[action];
  if (!next) {
    return NextResponse.json(
      { errors: [{ code: "INVALID_ACTION", detail: `action must be one of ${Object.keys(ACTIONS).join(", ")}` }] },
      { status: 400 }
    );
  }

  const reviewer = gate.ctx.user?.email ?? `user:${gate.ctx.user?.id ?? "unknown"}`;

  try {
    const row = await transitionRecommendation(id, next, reviewer);
    await writeAudit({
      actorType: "user",
      actorId: gate.ctx.user?.id ?? null,
      action: `seo.recommendation.${action}`,
      resource: "seo_recommendations",
      resourceId: row.id,
      result: "success",
      requestId,
      metadata: { to: next, title: row.title.slice(0, 120), reviewer },
    });
    return NextResponse.json({ data: { recommendation: row }, meta: { requestId } });
  } catch (e) {
    if (e instanceof SeoServiceError) {
      const status = e.code === "not_found" ? 404 : e.code === "conflict" ? 409 : 400;
      await writeAudit({
        actorType: "user",
        actorId: gate.ctx.user?.id ?? null,
        action: `seo.recommendation.${action}`,
        resource: "seo_recommendations",
        resourceId: id,
        result: "denied",
        requestId,
        metadata: { code: e.code, detail: e.message },
      });
      return NextResponse.json({ errors: [{ code: e.code.toUpperCase(), detail: e.message }] }, { status });
    }
    throw e;
  }
}
