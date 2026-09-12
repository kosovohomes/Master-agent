import { NextResponse } from "next/server";
import { query } from "@/lib/db";
import { isFlagEnabled } from "@/lib/settings";
import { rateLimit } from "@/lib/security/ratelimit";
import { verifySignedPayload } from "@/lib/connectors/crypto";
import {
  connectorSecrets,
  getWebsiteConnector,
  markDeliveryOutcome,
  recordDelivery,
  websiteHasCapability,
} from "@/lib/connectors/service";
import { EVENT_CAPABILITIES, type ConnectorWebsite } from "@/lib/connectors/types";
import { makeConnectorEventHandler, ConnectorEventError } from "@/lib/connectors/events";

export const runtime = "nodejs";

/**
 * POST /api/integrations/:siteId/events — the signed inbound webhook
 * (Phase 6; Phase 0.5 §411, SEC-L4 §77, capability grants §394).
 *
 * Verification order (fail closed, generic errors — no oracle for probing):
 *   1. feature flag            → OFF: 404 (endpoint does not exist)
 *   2. site + active connector → missing/disabled: 404
 *   3. rate limit              → 429 (60/min per website)
 *   4. delivery id header      → missing: 400
 *   5. HMAC signature + timestamp (constant-time, 5-min window) → 401/400
 *   6. JSON body + event envelope → 400
 *   7. capability grant (§394) → 403
 *   8. replay cache (UNIQUE website+delivery) → 409
 *   9. event router (Phase 5 sync machinery) → 202
 *
 * Every attempt is written to connector_deliveries with its verdict — the
 * receipt log doubles as the replay cache and the operator's debug surface.
 * Secrets never appear in any response or log. A failing site never affects
 * another site: state is keyed by website from step 2 onward (§144).
 */
export async function POST(req: Request, { params }: { params: Promise<{ siteId: string }> }) {
  // 1. feature flag — rollback is a single flag flip, zero deploys
  const flagOn = await isFlagEnabled("connectors", false);
  if (!flagOn) return notFound();

  // 2. site + active webhook connector
  const { siteId } = await params;
  if (!/^\d+$/.test(siteId)) return notFound();
  const websiteId = Number(siteId);
  const website = await getWebsite(websiteId);
  if (!website || website.status !== "active") return notFound();
  const connector = await getWebsiteConnector(websiteId, "webhook");
  if (!connector || connector.status !== "active") return notFound();

  // 3. rate limit
  const rl = await rateLimit(`connector:${websiteId}`, 60, 60_000);
  if (!rl.allowed) {
    return NextResponse.json(
      { errors: [{ code: "RATE_LIMITED" }] },
      { status: 429, headers: { "Retry-After": String(rl.retryAfterSec) } }
    );
  }

  // 4. delivery id
  const deliveryId = (req.headers.get("x-agentos-delivery") ?? "").trim();
  if (deliveryId === "" || deliveryId.length > 200) {
    return NextResponse.json({ errors: [{ code: "DELIVERY_ID_REQUIRED" }] }, { status: 400 });
  }

  const rawBody = await req.text();

  // 5. HMAC signature + timestamp (constant-time; rotation window handled)
  const secrets = await connectorSecrets(connector.id);
  const verify = verifySignedPayload({
    secrets: [
      ...(secrets.current ? [{ secret: secrets.current }] : []),
      ...(secrets.previous ? [{ secret: secrets.previous, isPrevious: true, rotatedAt: secrets.rotatedAt }] : []),
    ],
    header: req.headers.get("x-agentos-signature"),
    rawBody,
  });
  if (!verify.ok) {
    await recordDelivery({
      websiteId,
      integrationId: connector.id,
      deliveryId,
      eventType: "unknown",
      signatureValid: false,
      status: "rejected",
      rejectionReason: verify.reason,
    });
    const status = verify.reason === "stale_timestamp" ? 400 : 401;
    return NextResponse.json({ errors: [{ code: "SIGNATURE_INVALID", detail: verify.reason }] }, { status });
  }

  // 6. body + envelope
  let payload: { type?: unknown; data?: unknown; sentAt?: unknown };
  try {
    payload = JSON.parse(rawBody) as typeof payload;
  } catch {
    await recordRejected(connector.id, websiteId, deliveryId, "invalid_json");
    return NextResponse.json({ errors: [{ code: "INVALID_JSON" }] }, { status: 400 });
  }
  const eventType = typeof payload.type === "string" ? payload.type.trim().slice(0, 100) : "";
  const data =
    payload.data && typeof payload.data === "object" && !Array.isArray(payload.data)
      ? (payload.data as Record<string, unknown>)
      : {};
  if (eventType === "") {
    await recordRejected(connector.id, websiteId, deliveryId, "event_type_required");
    return NextResponse.json({ errors: [{ code: "EVENT_TYPE_REQUIRED" }] }, { status: 400 });
  }

  // 7. capability grant (§394 — deterministic, server-side)
  const requiredCapability = EVENT_CAPABILITIES[eventType];
  if (requiredCapability) {
    const granted = await websiteHasCapability(websiteId, requiredCapability);
    if (!granted) {
      await recordRejected(connector.id, websiteId, deliveryId, "capability_not_granted", eventType, data);
      return NextResponse.json(
        { errors: [{ code: "CAPABILITY_NOT_GRANTED", detail: requiredCapability }] },
        { status: 403 }
      );
    }
  }

  // 8. replay cache — an accepted delivery id can never be re-processed;
  //    a previously failed/rejected one CAN be re-recorded (sender retries).
  const receipt = await recordDelivery({
    websiteId,
    integrationId: connector.id,
    deliveryId,
    eventType,
    signatureValid: true,
    status: "received",
    payload: { type: eventType, sentAt: typeof payload.sentAt === "string" ? payload.sentAt : null },
    overwriteRetryable: true,
  });
  if (!receipt.recorded || receipt.deliveryRowId == null) {
    return NextResponse.json({ errors: [{ code: "DELIVERY_REPLAY" }] }, { status: 409 });
  }

  // 9. route the event (Phase 5 sync machinery for content events)
  try {
    const handler = makeConnectorEventHandler();
    const result = await handler({
      website,
      integrationId: connector.id,
      eventType,
      data,
      deliveryId,
    });
    await markDeliveryOutcome(receipt.deliveryRowId, {
      status: "accepted",
      taskId: result.taskIds?.[0] ?? null,
    });
    return NextResponse.json(
      {
        data: {
          received: true,
          action: result.action,
          taskId: result.taskIds?.[0] ?? null,
          sourceIds: result.sourceIds ?? [],
          detail: result.detail ?? null,
        },
      },
      { status: 202 }
    );
  } catch (e) {
    if (e instanceof ConnectorEventError) {
      await markDeliveryOutcome(receipt.deliveryRowId, {
        status: "rejected",
        rejectionReason: "sync_target_required",
      });
      return NextResponse.json({ errors: [{ code: e.code, detail: e.message }] }, { status: 400 });
    }
    // Failure containment (§144): scoped to this delivery; the delivery id
    // stays retryable, other sites are untouched.
    const msg = (e instanceof Error ? e.message : String(e)).slice(0, 500);
    await markDeliveryOutcome(receipt.deliveryRowId, { status: "failed", rejectionReason: msg }).catch(() => {});
    return NextResponse.json({ errors: [{ code: "PROCESSING_FAILED" }] }, { status: 500 });
  }
}

export async function GET() {
  return NextResponse.json({ errors: [{ code: "METHOD_NOT_ALLOWED" }] }, { status: 405 });
}

async function getWebsite(id: number): Promise<ConnectorWebsite | null> {
  const rows = await query<any>(
    `SELECT id, business_unit_id, slug, name, domain, status FROM websites WHERE id = $1`,
    [id]
  );
  if (rows.length === 0) return null;
  const r = rows[0];
  return {
    id: Number(r.id),
    businessUnitId: Number(r.business_unit_id),
    slug: r.slug,
    name: r.name,
    domain: r.domain ?? null,
    status: r.status,
  };
}

async function recordRejected(
  integrationId: number,
  websiteId: number,
  deliveryId: string,
  reason: string,
  eventType = "unknown",
  data: Record<string, unknown> = {}
): Promise<void> {
  await recordDelivery({
    websiteId,
    integrationId,
    deliveryId,
    eventType,
    signatureValid: true,
    status: "rejected",
    rejectionReason: reason,
    payload: Object.keys(data).length > 0 ? { data } : null,
  }).catch(() => {});
}

function notFound() {
  return NextResponse.json({ errors: [{ code: "NOT_FOUND" }] }, { status: 404 });
}
