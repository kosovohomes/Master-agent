import { NextResponse } from "next/server";
import { requireAnyPermission, requirePermission } from "@/lib/auth/guards";
import { createWebsiteConnector, listConnectors, ConnectorError } from "@/lib/connectors/service";
import { CONNECTOR_TYPES, CONNECTOR_CAPABILITIES } from "@/lib/connectors/types";
import { isFlagEnabled } from "@/lib/settings";
import { writeAudit, requestIdFor } from "@/lib/audit";

export const runtime = "nodejs";

/**
 * /api/admin/connectors (Phase 6 — website connectors, §12/§411).
 *  GET  — connectors.manage / audit.read: every connector with its website,
 *         capability grants, and 24h delivery stats (+ flag state for the UI).
 *  POST — connectors.manage: create a webhook connector for a website
 *         {websiteId, displayName?, type?}. The signing secret is returned
 *         EXACTLY ONCE in this response — encrypted at rest, never audited.
 */
export async function GET(req: Request) {
  const requestId = requestIdFor(req);
  const gate = await requireAnyPermission(req, ["connectors.manage", "audit.read"]);
  if (!gate.ok) return gate.response;

  const [connectors, flag] = await Promise.all([
    listConnectors(),
    isFlagEnabled("connectors", false),
  ]);
  return NextResponse.json({
    data: { connectors, flag, capabilityCatalog: CONNECTOR_CAPABILITIES },
    meta: { requestId },
  });
}

export async function POST(req: Request) {
  const requestId = requestIdFor(req);
  const gate = await requirePermission(req, "connectors.manage");
  if (!gate.ok) return gate.response;

  let body: Record<string, unknown>;
  try {
    body = (await req.json()) as Record<string, unknown>;
  } catch {
    return NextResponse.json({ errors: [{ code: "INVALID_JSON" }] }, { status: 400 });
  }

  const websiteId = Number(body.websiteId);
  if (!Number.isInteger(websiteId) || websiteId <= 0) {
    return NextResponse.json({ errors: [{ code: "WEBSITE_ID_REQUIRED" }] }, { status: 400 });
  }
  const type = body.type != null ? String(body.type) : "webhook";
  if (!(CONNECTOR_TYPES as readonly string[]).includes(type)) {
    return NextResponse.json(
      { errors: [{ code: "INVALID_TYPE", detail: `type must be one of ${CONNECTOR_TYPES.join(", ")}` }] },
      { status: 400 }
    );
  }
  const displayName = body.displayName != null ? String(body.displayName).slice(0, 120) : null;

  try {
    const { connector, signingSecret } = await createWebsiteConnector({ websiteId, type, displayName });
    await writeAudit({
      actorType: "user",
      actorId: gate.ctx.user?.id ?? null,
      action: "connector.create",
      resource: "website_integrations",
      resourceId: connector.id,
      result: "success",
      requestId,
      // signingSecret deliberately omitted — secrets never enter the audit log
      metadata: { websiteId, type, displayName },
    });
    return NextResponse.json(
      { data: { connector, signingSecret, warning: "Store this signing secret now — it is shown only once." }, meta: { requestId } },
      { status: 201 }
    );
  } catch (e) {
    if (e instanceof ConnectorError) {
      return NextResponse.json({ errors: [{ code: e.code, detail: e.message }] }, { status: 400 });
    }
    throw e;
  }
}
