import { NextResponse } from "next/server";
import { requirePermission } from "@/lib/auth/guards";
import { setKeywordStatus, SeoServiceError } from "@/lib/seo/service";
import type { SeoKeywordStatus } from "@/lib/seo/types";
import { writeAudit, requestIdFor } from "@/lib/audit";

export const runtime = "nodejs";

const STATUSES: SeoKeywordStatus[] = ["active", "retired"];

/**
 * /api/admin/seo/keywords/[id] (Phase 9).
 *  PATCH — seo.manage: {status: active | retired}. Owner-driven keyword
 *  curation: retiring a keyword takes it out of the active store (scans do
 *  not resurrect it; manual re-activation does). Audited.
 */
export async function PATCH(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const requestId = requestIdFor(req);
  const gate = await requirePermission(req, "seo.manage");
  if (!gate.ok) return gate.response;

  const { id: idRaw } = await ctx.params;
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

  const status = String(body.status ?? "") as SeoKeywordStatus;
  if (!STATUSES.includes(status)) {
    return NextResponse.json(
      { errors: [{ code: "INVALID_STATUS", detail: `status must be one of ${STATUSES.join(", ")}` }] },
      { status: 400 }
    );
  }

  try {
    const row = await setKeywordStatus(id, status);
    if (!row) {
      return NextResponse.json({ errors: [{ code: "NOT_FOUND" }] }, { status: 404 });
    }
    await writeAudit({
      actorType: "user",
      actorId: gate.ctx.user?.id ?? null,
      action: "seo.keyword.status",
      resource: "seo_keywords",
      resourceId: row.id,
      result: "success",
      requestId,
      metadata: { status, keyword: row.keyword },
    });
    return NextResponse.json({ data: { keyword: row }, meta: { requestId } });
  } catch (e) {
    const code = e instanceof SeoServiceError ? e.code : "KEYWORD_UPDATE_FAILED";
    await writeAudit({
      actorType: "user",
      actorId: gate.ctx.user?.id ?? null,
      action: "seo.keyword.status",
      resource: "seo_keywords",
      resourceId: id,
      result: "denied",
      requestId,
      metadata: { code, detail: e instanceof Error ? e.message : String(e) },
    });
    return NextResponse.json({ errors: [{ code }] }, { status: 400 });
  }
}
