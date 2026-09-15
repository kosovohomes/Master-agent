import { NextResponse } from "next/server";
import { requirePermission } from "@/lib/auth/guards";
import { updateCampaign } from "@/lib/social/service";
import { SocialServiceError } from "@/lib/social/types";
import type { SocialCampaignStatus } from "@/lib/social/types";
import { writeAudit, requestIdFor } from "@/lib/audit";

export const runtime = "nodejs";

const STATUSES: SocialCampaignStatus[] = ["planning", "active", "paused", "completed"];

/**
 * /api/admin/social/campaigns/[id] (Phase 10).
 *  PATCH — social.manage: {status?, objective?, startsAt?, endsAt?}.
 *          Audited (status transitions are the interesting ones).
 */
export async function PATCH(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const requestId = requestIdFor(req);
  const gate = await requirePermission(req, "social.manage");
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

  if (body.status !== undefined && !STATUSES.includes(body.status as SocialCampaignStatus)) {
    return NextResponse.json(
      { errors: [{ code: "INVALID_STATUS", detail: `status must be one of ${STATUSES.join(", ")}` }] },
      { status: 400 }
    );
  }

  try {
    const campaign = await updateCampaign(id, {
      status: (body.status as SocialCampaignStatus) ?? undefined,
      objective: typeof body.objective === "string" ? body.objective : undefined,
      startsAt: typeof body.startsAt === "string" ? body.startsAt : undefined,
      endsAt: typeof body.endsAt === "string" ? body.endsAt : undefined,
    });
    await writeAudit({
      actorType: "user",
      actorId: gate.ctx.user?.id ?? null,
      action: "social.campaign.update",
      resource: "social_campaigns",
      resourceId: campaign.id,
      result: "success",
      requestId,
      metadata: { status: campaign.status },
    });
    return NextResponse.json({ data: { campaign }, meta: { requestId } });
  } catch (e) {
    const code = e instanceof SocialServiceError ? e.code : "CAMPAIGN_UPDATE_FAILED";
    const status = code === "NOT_FOUND" ? 404 : 500;
    return NextResponse.json({ errors: [{ code }] }, { status });
  }
}
