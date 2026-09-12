import { NextResponse } from "next/server";
import { requireAnyPermission } from "@/lib/auth/guards";
import { getConnector, recentDeliveries } from "@/lib/connectors/service";
import { requestIdFor } from "@/lib/audit";

export const runtime = "nodejs";

/**
 * /api/admin/connectors/[id]/deliveries (Phase 6) — the signed-webhook
 * receipt log for one connector: every attempt with its verdict
 * (signature_valid, accepted/rejected/failed, rejection reason, spawned
 * task). Read for connectors.manage / audit.read; ?limit=50 (max 200).
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

  const limitRaw = new URL(req.url).searchParams.get("limit");
  const limit = limitRaw && /^\d+$/.test(limitRaw) ? Number(limitRaw) : 50;
  const deliveries = await recentDeliveries(id, limit);
  return NextResponse.json({ data: { deliveries }, meta: { requestId } });
}
