import { NextResponse } from "next/server";
import { requireAnyPermission } from "@/lib/auth/guards";
import { listSegments, listCampaigns, metricsSummary } from "@/lib/marketing/service";
import type { CampaignStatus } from "@/lib/marketing/types";
import { isFlagEnabled } from "@/lib/settings";
import { requestIdFor } from "@/lib/audit";

export const runtime = "nodejs";

/**
 * /api/admin/marketing (Phase 11 — marketing workforce control surface).
 *  GET — marketing.manage / audit.read: audience segments, campaigns,
 *  metric rollups, flag state. Reads only — mutations are separate audited
 *  routes (segments, campaigns, transitions, metrics, brief, sweep).
 */
export async function GET(req: Request) {
  const requestId = requestIdFor(req);
  const gate = await requireAnyPermission(req, ["marketing.manage", "audit.read"]);
  if (!gate.ok) return gate.response;

  const url = new URL(req.url);
  const buRaw = url.searchParams.get("businessUnitId");
  const businessUnitId = buRaw && /^\d+$/.test(buRaw) ? Number(buRaw) : null;

  const statusRaw = url.searchParams.get("status");
  const status = (["draft", "active", "paused", "completed", "cancelled"] as const).includes(statusRaw as never)
    ? (statusRaw as CampaignStatus)
    : null;

  const [segments, campaigns, metrics, marketingFlag] = await Promise.all([
    listSegments({ businessUnitId }),
    listCampaigns({ businessUnitId, status }),
    metricsSummary({ businessUnitId, limit: 20 }),
    isFlagEnabled("marketing", false),
  ]);

  return NextResponse.json({
    data: {
      segments,
      campaigns,
      metrics,
      flags: { marketing: marketingFlag },
    },
    meta: { requestId },
  });
}
