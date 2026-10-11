import { NextResponse } from "next/server";
import { rateLimit, clientIp } from "@/lib/security/ratelimit";
import { writeAudit, requestIdFor } from "@/lib/audit";

export const runtime = "nodejs";

/**
 * POST /api/v1/channels — RETIRED (Phase 14, roadmap P13: "Integration
 * management UI replaces the P1-guarded channels endpoint permanently").
 *
 * History: Phase 1 M0 (SEC-C1) found this endpoint as an UNAUTHENTICATED
 * mutation that let any internet caller plant publishing credentials for any
 * enumerable tenant; it was fail-closed (session + website.manage, rate
 * limited, audited) as an emergency stop-gap. P13 retires it for good:
 *  - website→platform integrations are WIRE-UP FREE via signed webhook
 *    connectors (POST /api/admin/connectors, reveal-once secret);
 *  - platform→platform publishing credentials are wired through the social
 *    OAuth surface (P9 social_accounts) and the connector model — never by
 *    raw token paste;
 *  - the legacy publishers keep READ-ONLY access to existing `channels`
 *    rows, so previously wired tenants continue to function; there is simply
 *    no remaining write path through this endpoint.
 *
 * The endpoint now answers 410 GONE (permanent), is rate limited, and every
 * attempt is audited — including the request SHAPE only (never any body
 * content; a body is not even read). Callers get the replacement surfaces.
 */
export async function POST(req: Request) {
  const requestId = requestIdFor(req);
  const ip = clientIp(req);

  const rl = await rateLimit(`channels-retired:${ip}`, 10, 10 * 60 * 1000);
  if (!rl.allowed) {
    await writeAudit({ actorType: "anonymous", actorLabel: "ip", action: "channels.wireup", resource: "channels", result: "denied", requestId, ip, metadata: { reason: "rate_limited", retired: true } });
    return NextResponse.json({ errors: [{ code: "RATE_LIMITED" }] }, { status: 429, headers: { "Retry-After": String(rl.retryAfterSec) } });
  }

  await writeAudit({ actorType: "anonymous", actorLabel: "ip", action: "channels.wireup", resource: "channels", result: "denied", requestId, ip, metadata: { reason: "endpoint_retired" } });
  return NextResponse.json(
    {
      errors: [
        {
          code: "ENDPOINT_RETIRED",
          detail:
            "POST /api/v1/channels was permanently retired in Phase 14. Wire website integrations via POST /api/admin/connectors (signed webhook connectors) and publishing credentials via the social accounts OAuth surface.",
        },
      ],
    },
    {
      status: 410,
      headers: { "Retry-After": "86400", "Link": '</api/admin/connectors>; rel="replacement"' },
    }
  );
}
