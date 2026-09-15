import { NextResponse } from "next/server";
import { requireAnyPermission, requirePermission } from "@/lib/auth/guards";
import { createCampaign, listCampaigns } from "@/lib/social/service";
import { SocialServiceError } from "@/lib/social/types";
import type { SocialCampaignStatus } from "@/lib/social/types";
import { writeAudit, requestIdFor } from "@/lib/audit";

export const runtime = "nodejs";

const STATUSES: SocialCampaignStatus[] = ["planning", "active", "paused", "completed"];

/**
 * /api/admin/social/campaigns (Phase 10).
 *  GET  — social.manage / audit.read: campaigns (BU-scoped).
 *  POST — social.manage: create {businessUnitId, name, objective?,
 *         websiteId?, startsAt?, endsAt?}. Audited.
 */
export async function GET(req: Request) {
  const requestId = requestIdFor(req);
  const gate = await requireAnyPermission(req, ["social.manage", "audit.read"]);
  if (!gate.ok) return gate.response;
  const url = new URL(req.url);
  const buRaw = url.searchParams.get("businessUnitId");
  const businessUnitId = buRaw && /^\d+$/.test(buRaw) ? Number(buRaw) : null;
  const campaigns = await listCampaigns({ businessUnitId });
  return NextResponse.json({ data: { campaigns }, meta: { requestId } });
}

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

  const businessUnitId = Number(body.businessUnitId);
  const name = typeof body.name === "string" ? body.name : "";
  if (!Number.isInteger(businessUnitId) || businessUnitId <= 0) {
    return NextResponse.json({ errors: [{ code: "BUSINESS_UNIT_ID_REQUIRED" }] }, { status: 400 });
  }
  if (!name.trim()) {
    return NextResponse.json({ errors: [{ code: "NAME_REQUIRED" }] }, { status: 400 });
  }

  try {
    const campaign = await createCampaign({
      businessUnitId,
      name,
      objective: typeof body.objective === "string" ? body.objective : null,
      websiteId: typeof body.websiteId === "number" ? body.websiteId : null,
      startsAt: typeof body.startsAt === "string" ? body.startsAt : null,
      endsAt: typeof body.endsAt === "string" ? body.endsAt : null,
      userId: gate.ctx.user?.id ?? null,
    });
    await writeAudit({
      actorType: "user",
      actorId: gate.ctx.user?.id ?? null,
      action: "social.campaign.create",
      resource: "social_campaigns",
      resourceId: campaign.id,
      result: "success",
      requestId,
      metadata: { businessUnitId, name },
    });
    return NextResponse.json({ data: { campaign }, meta: { requestId } });
  } catch (e) {
    const code = e instanceof SocialServiceError ? e.code : "CAMPAIGN_CREATE_FAILED";
    const status = code === "DUPLICATE" ? 409 : code === "BAD_NAME" ? 400 : 500;
    return NextResponse.json({ errors: [{ code }] }, { status });
  }
}
