import { NextResponse } from "next/server";
import { requirePermission, requireAnyPermission } from "@/lib/auth/guards";
import { updateCampaign, getCampaign, campaignRollup } from "@/lib/marketing/service";
import { MarketingServiceError } from "@/lib/marketing/types";
import { writeAudit, requestIdFor } from "@/lib/audit";

export const runtime = "nodejs";

/**
 * /api/admin/marketing/campaigns/[id] (Phase 11).
 *  GET    — marketing.manage / audit.read: campaign + metric rollup.
 *  PATCH  — marketing.manage: field edits {objective?, websiteId?,
 *           audienceSegmentId?, startsAt?, endsAt?, metadata?}. Blocked in
 *           terminal states by the service; NEVER touches FSM/approval
 *           columns (transitions are a separate audited route). Audited.
 */
export async function GET(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const requestId = requestIdFor(req);
  const gate = await requireAnyPermission(req, ["marketing.manage", "audit.read"]);
  if (!gate.ok) return gate.response;

  const { id: idRaw } = await ctx.params;
  const id = Number(idRaw);
  if (!Number.isInteger(id) || id <= 0) {
    return NextResponse.json({ errors: [{ code: "INVALID_ID" }] }, { status: 400 });
  }
  const campaign = await getCampaign(id);
  if (!campaign) return NextResponse.json({ errors: [{ code: "NOT_FOUND" }] }, { status: 404 });
  const rollup = await campaignRollup(id);
  return NextResponse.json({ data: { campaign, rollup }, meta: { requestId } });
}

export async function PATCH(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const requestId = requestIdFor(req);
  const gate = await requirePermission(req, "marketing.manage");
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

  try {
    const campaign = await updateCampaign(id, {
      objective: body.objective !== undefined ? (typeof body.objective === "string" ? body.objective : null) : undefined,
      websiteId: body.websiteId !== undefined ? Number(body.websiteId) : undefined,
      audienceSegmentId: body.audienceSegmentId !== undefined ? Number(body.audienceSegmentId) : undefined,
      startsAt: body.startsAt !== undefined ? (typeof body.startsAt === "string" ? body.startsAt : null) : undefined,
      endsAt: body.endsAt !== undefined ? (typeof body.endsAt === "string" ? body.endsAt : null) : undefined,
      metadata: (body.metadata as Record<string, unknown> | undefined) ?? undefined,
    });
    await writeAudit({
      actorType: "user",
      actorId: gate.ctx.user?.id ?? null,
      action: "marketing.campaign.update",
      resource: "campaigns",
      resourceId: campaign.id,
      result: "success",
      requestId,
      metadata: { status: campaign.status },
    });
    return NextResponse.json({ data: { campaign }, meta: { requestId } });
  } catch (e) {
    const code = e instanceof MarketingServiceError ? e.code : "CAMPAIGN_UPDATE_FAILED";
    const status =
      code === "NOT_FOUND" ? 404
      : code === "TERMINAL" ? 409
      : code === "BAD_WINDOW" || code === "SEGMENT_NOT_FOUND" ? 400
      : 500;
    return NextResponse.json({ errors: [{ code }] }, { status });
  }
}
