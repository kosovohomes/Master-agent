import { NextResponse } from "next/server";
import { listDraftsByTenant, listDraftsByTenants, type DraftStatus } from "@/lib/agents/approval";
import { sessionOrLegacyBearer, forbidden } from "@/lib/auth/guards";
import { permittedLegacyTenantIds } from "@/lib/bu";
import { writeAudit, requestIdFor } from "@/lib/audit";

/**
 * GET /api/admin/drafts — approval queue reads (Phase 1 M1).
 *
 * Legacy bearer (flag-gated transition): existing behavior — tenantId required.
 * Session: reads are scoped to the caller's BU access. Without a tenantId
 * parameter the route returns drafts across every permitted legacy tenant;
 * a tenantId outside the permitted set is a 403, never a silent filter.
 */
export async function GET(req: Request) {
  const requestId = requestIdFor(req);
  const gate = await sessionOrLegacyBearer(req, "drafts.read");
  if (!gate.ok) return gate.response;

  const rawTenant = new URL(req.url).searchParams.get("tenantId");
  const statusParam = new URL(req.url).searchParams.get("status");
  const status = (["pending", "approved", "rejected", "scheduled", "posted", "failed"] as const).includes(statusParam as DraftStatus)
    ? (statusParam as DraftStatus)
    : undefined;

  if (gate.ctx.via === "legacy-bearer") {
    if (rawTenant === null || !/^\d+$/.test(rawTenant)) {
      return NextResponse.json({ errors: [{ code: "INVALID_TENANT" }] }, { status: 400 });
    }
    return NextResponse.json({ data: await listDraftsByTenant(Number(rawTenant), status) });
  }

  const user = gate.ctx.user!;
  const scope = await permittedLegacyTenantIds(user.id);

  if (rawTenant !== null) {
    if (!/^\d+$/.test(rawTenant)) {
      return NextResponse.json({ errors: [{ code: "INVALID_TENANT" }] }, { status: 400 });
    }
    const tenantId = Number(rawTenant);
    if (scope.kind === "list" && !scope.tenantIds.includes(tenantId)) {
      await writeAudit({ actorType: "user", actorId: user.id, action: "drafts.read", resource: "drafts", resourceId: tenantId, result: "denied", requestId, metadata: { reason: "bu_scope" } });
      return forbidden("BU_SCOPE_DENIED");
    }
    return NextResponse.json({ data: await listDraftsByTenant(tenantId, status) });
  }

  if (scope.kind === "all") {
    // Global roles read across all tenants.
    const rows = await listDraftsByTenants(
      (await queryAllTenantIds()),
      status
    );
    return NextResponse.json({ data: rows });
  }
  return NextResponse.json({ data: await listDraftsByTenants(scope.tenantIds, status) });
}

async function queryAllTenantIds(): Promise<number[]> {
  const { query } = await import("@/lib/db");
  const rows = await query<{ id: number }>("SELECT id FROM tenants");
  return rows.map((r) => r.id);
}
