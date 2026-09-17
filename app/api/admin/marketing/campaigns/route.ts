import { NextResponse } from "next/server";
import { requirePermission } from "@/lib/auth/guards";
import { createCampaign } from "@/lib/marketing/service";
import { MarketingServiceError } from "@/lib/marketing/types";
import { writeAudit, requestIdFor } from "@/lib/audit";

export const runtime = "nodejs";

/**
 * /api/admin/marketing/campaigns (Phase 11).
 *  POST — marketing.manage: create a campaign. New campaigns ALWAYS start
 *  in 'draft' (§91: brief/creation is the AUTO leg; launch is APPROVAL —
 *  the only path to 'active' is the audited transition route with a human
 *  approver). Audited.
 */
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

  const businessUnitId = Number(body.businessUnitId);
  const name = typeof body.name === "string" ? body.name : "";
  if (!Number.isInteger(businessUnitId) || businessUnitId <= 0) {
    return NextResponse.json({ errors: [{ code: "INVALID_BUSINESS_UNIT" }] }, { status: 400 });
  }
  if (!name.trim()) {
    return NextResponse.json({ errors: [{ code: "INVALID_NAME" }] }, { status: 400 });
  }

  try {
    const campaign = await createCampaign({
      businessUnitId,
      name,
      objective: typeof body.objective === "string" ? body.objective : null,
      websiteId: body.websiteId != null ? Number(body.websiteId) : null,
      audienceSegmentId: body.audienceSegmentId != null ? Number(body.audienceSegmentId) : null,
      startsAt: typeof body.startsAt === "string" ? body.startsAt : null,
      endsAt: typeof body.endsAt === "string" ? body.endsAt : null,
      metadata: (body.metadata ?? {}) as Record<string, unknown>,
      userId: gate.ctx.user?.id ?? null,
      agentSlug: typeof body.agentSlug === "string" ? body.agentSlug : null,
    });
    await writeAudit({
      actorType: "user",
      actorId: gate.ctx.user?.id ?? null,
      action: "marketing.campaign.create",
      resource: "campaigns",
      resourceId: campaign.id,
      result: "success",
      requestId,
      metadata: { name: campaign.name, businessUnitId, agentSlug: campaign.createdByAgent },
    });
    return NextResponse.json({ data: { campaign }, meta: { requestId } }, { status: 201 });
  } catch (e) {
    const code = e instanceof MarketingServiceError ? e.code : "CAMPAIGN_CREATE_FAILED";
    const status =
      code === "DUPLICATE" ? 409
      : code === "BAD_NAME" || code === "BAD_WINDOW" || code === "SEGMENT_NOT_FOUND" ? 400
      : 500;
    return NextResponse.json({ errors: [{ code }] }, { status });
  }
}
