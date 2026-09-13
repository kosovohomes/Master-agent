import { NextResponse } from "next/server";
import { requirePermission, requireAnyPermission } from "@/lib/auth/guards";
import { listCompetitors, createCompetitor, ResearchServiceError } from "@/lib/research/service";
import { writeAudit, requestIdFor } from "@/lib/audit";

export const runtime = "nodejs";

/**
 * /api/admin/competitors (Phase 7 — §59 competitor registry).
 *  GET  — research.manage / audit.read: tracked competitors per BU.
 *  POST — research.manage: {businessUnitId, name, url?, notes?}.
 *         UNIQUE (business_unit_id, name) keeps the registry clean.
 */
export async function GET(req: Request) {
  const requestId = requestIdFor(req);
  const gate = await requireAnyPermission(req, ["research.manage", "audit.read"]);
  if (!gate.ok) return gate.response;

  const url = new URL(req.url);
  const buRaw = url.searchParams.get("businessUnitId");
  const businessUnitId = buRaw && /^\d+$/.test(buRaw) ? Number(buRaw) : null;
  const competitors = await listCompetitors(businessUnitId);
  return NextResponse.json({ data: { competitors }, meta: { requestId } });
}

export async function POST(req: Request) {
  const requestId = requestIdFor(req);
  const gate = await requirePermission(req, "research.manage");
  if (!gate.ok) return gate.response;

  let body: Record<string, unknown>;
  try {
    body = (await req.json()) as Record<string, unknown>;
  } catch {
    return NextResponse.json({ errors: [{ code: "INVALID_JSON" }] }, { status: 400 });
  }

  const businessUnitId = Number(body.businessUnitId);
  if (!Number.isInteger(businessUnitId) || businessUnitId <= 0) {
    return NextResponse.json({ errors: [{ code: "BUSINESS_UNIT_ID_REQUIRED" }] }, { status: 400 });
  }
  const name = String(body.name ?? "").trim();
  if (name === "" || name.length > 160) {
    return NextResponse.json({ errors: [{ code: "INVALID_NAME", detail: "name must be 1-160 chars" }] }, { status: 400 });
  }
  const url = body.url != null && String(body.url).trim() !== "" ? String(body.url).trim() : null;
  if (url !== null && !/^https?:\/\//i.test(url)) {
    return NextResponse.json({ errors: [{ code: "INVALID_URL", detail: "url must start with http(s)://" }] }, { status: 400 });
  }

  try {
    const competitor = await createCompetitor({
      businessUnitId,
      name,
      url,
      notes: body.notes != null ? String(body.notes).slice(0, 1000) : null,
    });
    await writeAudit({
      actorType: "user", actorId: gate.ctx.user?.id ?? null,
      action: "research.competitor.create", resource: "competitors", resourceId: competitor.id,
      result: "success", requestId, metadata: { businessUnitId, name: competitor.name },
    });
    return NextResponse.json({ data: { competitor }, meta: { requestId } });
  } catch (e) {
    if (e instanceof ResearchServiceError) {
      const status = e.code === "NOT_FOUND" ? 404 : e.code === "DUPLICATE" ? 409 : 400;
      await writeAudit({
        actorType: "user", actorId: gate.ctx.user?.id ?? null,
        action: "research.competitor.create", resource: "competitors",
        result: "denied", requestId, metadata: { code: e.code, detail: e.message },
      });
      return NextResponse.json({ errors: [{ code: e.code, detail: e.message }] }, { status });
    }
    throw e;
  }
}
