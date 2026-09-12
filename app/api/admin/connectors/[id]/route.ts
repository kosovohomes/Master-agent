import { NextResponse } from "next/server";
import { requirePermission } from "@/lib/auth/guards";
import {
  deleteConnector,
  getConnector,
  rotateConnectorSecret,
  setConnectorStatus,
  ConnectorError,
} from "@/lib/connectors/service";
import { writeAudit, requestIdFor } from "@/lib/audit";

export const runtime = "nodejs";

const STATUSES = ["active", "disabled", "error"];

/**
 * /api/admin/connectors/[id] (Phase 6). connectors.manage:
 *  PATCH  — {status} enable/disable a connector. Audited.
 *  POST   — rotate the signing secret (zero-downtime: previous secret stays
 *           valid inside the rotation window). The NEW secret is returned
 *           EXACTLY ONCE; never audited, never logged. Audited (rotate event).
 *  DELETE — remove the connector (delivery rows cascade via website FK
 *           semantics; receipts keep integration_id NULL lineage). Audited.
 */
export async function PATCH(req: Request, { params }: { params: Promise<{ id: string }> }) {
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

  const status = String(body.status ?? "");
  if (!STATUSES.includes(status)) {
    return NextResponse.json(
      { errors: [{ code: "INVALID_STATUS", detail: `status must be one of ${STATUSES.join(", ")}` }] },
      { status: 400 }
    );
  }

  const connector = await setConnectorStatus(id, status as "active" | "disabled" | "error");
  if (!connector) return NextResponse.json({ errors: [{ code: "NOT_FOUND" }] }, { status: 404 });
  await writeAudit({
    actorType: "user",
    actorId: gate.ctx.user?.id ?? null,
    action: "connector.update",
    resource: "website_integrations",
    resourceId: id,
    result: "success",
    requestId,
    metadata: { status },
  });
  return NextResponse.json({ data: { connector }, meta: { requestId } });
}

export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const requestId = requestIdFor(req);
  const gate = await requirePermission(req, "connectors.manage");
  if (!gate.ok) return gate.response;
  const { id: idRaw } = await params;
  const id = Number(idRaw);
  if (!Number.isInteger(id) || id <= 0) {
    return NextResponse.json({ errors: [{ code: "INVALID_ID" }] }, { status: 400 });
  }

  try {
    const { connector, signingSecret } = await rotateConnectorSecret(id);
    await writeAudit({
      actorType: "user",
      actorId: gate.ctx.user?.id ?? null,
      action: "connector.rotate",
      resource: "website_integrations",
      resourceId: id,
      result: "success",
      requestId,
      metadata: { websiteId: connector.websiteId, rotatedAt: connector.rotatedAt },
    });
    return NextResponse.json(
      { data: { connector, signingSecret, warning: "Store this signing secret now — it is shown only once." }, meta: { requestId } },
      { status: 200 }
    );
  } catch (e) {
    if (e instanceof ConnectorError && e.code === "NOT_FOUND") {
      return NextResponse.json({ errors: [{ code: "NOT_FOUND" }] }, { status: 404 });
    }
    throw e;
  }
}

export async function DELETE(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const requestId = requestIdFor(req);
  const gate = await requirePermission(req, "connectors.manage");
  if (!gate.ok) return gate.response;
  const { id: idRaw } = await params;
  const id = Number(idRaw);
  if (!Number.isInteger(id) || id <= 0) {
    return NextResponse.json({ errors: [{ code: "INVALID_ID" }] }, { status: 400 });
  }

  const before = await getConnector(id);
  const deleted = await deleteConnector(id);
  if (!deleted) return NextResponse.json({ errors: [{ code: "NOT_FOUND" }] }, { status: 404 });
  await writeAudit({
    actorType: "user",
    actorId: gate.ctx.user?.id ?? null,
    action: "connector.delete",
    resource: "website_integrations",
    resourceId: id,
    result: "success",
    requestId,
    metadata: { websiteId: before?.websiteId ?? null, type: before?.type ?? null },
  });
  return NextResponse.json({ data: { deleted: true }, meta: { requestId } });
}
