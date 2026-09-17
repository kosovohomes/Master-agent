import { NextResponse } from "next/server";
import { requirePermission } from "@/lib/auth/guards";
import { transitionCampaign } from "@/lib/marketing/service";
import { MarketingServiceError, CampaignStatus, CAMPAIGN_FLOW } from "@/lib/marketing/types";
import { writeAudit, requestIdFor } from "@/lib/audit";
import { emitEvent } from "@/lib/tasks/events";

export const runtime = "nodejs";

const STATUSES = Object.keys(CAMPAIGN_FLOW) as CampaignStatus[];

/**
 * /api/admin/marketing/campaigns/[id]/transition (Phase 11 — THE approval
 * doorway, §91).
 *
 *  POST — marketing.manage: {to: CampaignStatus}. The session user IS the
 *  approver identity for launch transitions (→ active): the service
 *  enforces that launch states require approverUserId, and this route is
 *  the only caller — there is no agent-callable path to an active
 *  campaign. Approval history is immutable: the service stamps
 *  approved_by/at on first launch and preserves them forever. Audited.
 */
export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
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

  const to = body.to as CampaignStatus;
  if (!STATUSES.includes(to)) {
    return NextResponse.json(
      { errors: [{ code: "INVALID_STATUS", detail: `to must be one of ${STATUSES.join(", ")}` }] },
      { status: 400 }
    );
  }

  const approverUserId = gate.ctx.user?.id ?? null;
  try {
    const campaign = await transitionCampaign(id, to, { approverUserId });
    await writeAudit({
      actorType: "user",
      actorId: approverUserId,
      action: "marketing.campaign.transition",
      resource: "campaigns",
      resourceId: campaign.id,
      result: "success",
      requestId,
      metadata: { to, status: campaign.status, approvedByUserId: campaign.approvedByUserId },
    });
    if (to === "active") {
      await emitEvent(campaign.businessUnitId, "marketing.campaign_activated", {
        campaignId: campaign.id, name: campaign.name, approverUserId,
      });
    }
    return NextResponse.json({ data: { campaign }, meta: { requestId } });
  } catch (e) {
    const code = e instanceof MarketingServiceError ? e.code : "CAMPAIGN_TRANSITION_FAILED";
    const status =
      code === "NOT_FOUND" ? 404
      : code === "BAD_TRANSITION" ? 409
      : code === "APPROVAL_REQUIRED" ? 403
      : 500;
    return NextResponse.json({ errors: [{ code }] }, { status });
  }
}
