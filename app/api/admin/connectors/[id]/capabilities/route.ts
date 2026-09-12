import { NextResponse } from "next/server";
import { requireAnyPermission, requirePermission } from "@/lib/auth/guards";
import {
  getConnector,
  grantWebsiteCapability,
  listWebsiteCapabilities,
  ConnectorError,
} from "@/lib/connectors/service";
import { CONNECTOR_CAPABILITIES } from "@/lib/connectors/types";
import { writeAudit, requestIdFor } from "@/lib/audit";

export const runtime = "nodejs";

/**
 * /api/admin/connectors/[id]/capabilities (Phase 6 — §394 capability grants).
 * Grants live on the WEBSITE (website_capabilities) — this route manages them
 * through the connector for an ergonomic single-screen operator flow.
 *   GET — connectors.manage / audit.read: the grant rows for the website.
 *   PUT — connectors.manage: {capability, enabled} grant or revoke. Audited
 *         (connector.capability). `chat.answer` is reserved (§411, Phase 11).
 */
export async function GET(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const requestId = requestIdFor(req);
  const gate = await requireAnyPermission(req, ["connectors.manage", "audit.read"]);
  if (!gate.ok) return gate.response;
  const { id: idRaw } = await params;
  const id = Number(idRaw);
  if (!Number.isInteger(id) || id <= 0) {
    return NextResponse.json({ errors: [{ code: "INVALID_ID" }] }, { status: 400 });
  }
  const connector = await getConnector(id);
  if (!connector) return NextResponse.json({ errors: [{ code: "NOT_FOUND" }] }, { status: 404 });
  const grants = await listWebsiteCapabilities(connector.websiteId);
  return NextResponse.json({
    data: { grants, capabilityCatalog: CONNECTOR_CAPABILITIES, websiteId: connector.websiteId },
    meta: { requestId },
  });
}

export async function PUT(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const requestId = requestIdFor(req);
  const gate = await requirePermission(req, "connectors.manage");
  if (!gate.ok) return gate.response;
  const { id: idRaw } = await params;
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
  const capability = String(body.capability ?? "");
  const enabled = body.enabled === true;

  const connector = await getConnector(id);
  if (!connector) return NextResponse.json({ errors: [{ code: "NOT_FOUND" }] }, { status: 404 });

  try {
    const grant = await grantWebsiteCapability(connector.websiteId, capability, enabled);
    await writeAudit({
      actorType: "user",
      actorId: gate.ctx.user?.id ?? null,
      action: "connector.capability",
      resource: "website_capabilities",
      resourceId: connector.websiteId,
      result: "success",
      requestId,
      metadata: { connectorId: id, capability: grant.capability, enabled: grant.enabled },
    });
    return NextResponse.json({ data: { grant }, meta: { requestId } });
  } catch (e) {
    if (e instanceof ConnectorError) {
      return NextResponse.json({ errors: [{ code: e.code, detail: e.message }] }, { status: 400 });
    }
    throw e;
  }
}

