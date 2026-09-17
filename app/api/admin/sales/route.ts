import { NextResponse } from "next/server";
import { requireAnyPermission } from "@/lib/auth/guards";
import { query } from "@/lib/db";
import {
  salesSummary,
  listInquiries,
  listLeads,
  listConversations,
} from "@/lib/sales/service";
import { isFlagEnabled } from "@/lib/settings";
import { requestIdFor } from "@/lib/audit";

export const runtime = "nodejs";

/**
 * /api/admin/sales (Phase 12 — sales + customer workforce control surface).
 *  GET — sales.manage / audit.read: pipeline summary (inquiry + lead FSM
 *  counts, hot leads, conversation volume), recent inquiries/leads/
 *  conversations, flag state. Reads only — mutations are separate audited
 *  routes. businessUnitId query param defaults to the first BU (single-BU
 *  platform today; multi-BU dashboards are the P12 analytics phase).
 */
export async function GET(req: Request) {
  const requestId = requestIdFor(req);
  const gate = await requireAnyPermission(req, ["sales.manage", "audit.read"]);
  if (!gate.ok) return gate.response;

  const url = new URL(req.url);
  const buRaw = url.searchParams.get("businessUnitId");
  const buId =
    buRaw && /^\d+$/.test(buRaw)
      ? Number(buRaw)
      : (await query<{ id: number }>("SELECT id FROM business_units ORDER BY id ASC LIMIT 1"))[0]?.id;
  if (!buId) {
    return NextResponse.json({ errors: [{ code: "NO_BUSINESS_UNIT" }] }, { status: 400 });
  }

  const [summary, inquiries, leads, conversations, salesFlag, widgetIntegrations] = await Promise.all([
    salesSummary(buId),
    listInquiries(buId, 25),
    listLeads(buId, 25),
    listConversations(buId, 15),
    isFlagEnabled("sales", false),
    // Widget = website-registered connector #1 (§13): masked site keys for
    // the registration card. Never return the full key (SEC-L4 hygiene).
    query<{ websiteId: number; websiteName: string; status: string; siteKeyMasked: string | null }>(
      `SELECT w.id AS "websiteId", w.name AS "websiteName", wi.status,
              CASE WHEN wi.config->>'siteKey' IS NOT NULL
                   THEN left(wi.config->>'siteKey', 6) || '…' || right(wi.config->>'siteKey', 4)
                   ELSE NULL END AS "siteKeyMasked"
       FROM website_integrations wi
       JOIN websites w ON w.id = wi.website_id
       WHERE wi.integration_type = 'widget'
       ORDER BY w.id ASC`
    ),
  ]);

  return NextResponse.json({
    data: {
      businessUnitId: buId,
      summary,
      inquiries,
      leads,
      conversations,
      widgetIntegrations,
      flags: { sales: salesFlag },
    },
    meta: { requestId },
  });
}
