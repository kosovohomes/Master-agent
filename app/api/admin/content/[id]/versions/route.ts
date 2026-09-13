import { NextResponse } from "next/server";
import { requirePermission } from "@/lib/auth/guards";
import { addManualVersion, ContentServiceError } from "@/lib/content/service";
import { writeAudit, requestIdFor } from "@/lib/audit";

export const runtime = "nodejs";

/**
 * POST /api/admin/content/[id]/versions (Phase 8) — manual edit-before-approve.
 * Appends a NEW immutable version (never-overwrite §61) and records an
 * 'edit' row in approval_actions. Audited.
 */
export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const requestId = requestIdFor(req);
  const gate = await requirePermission(req, "content.manage");
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

  const bodyText = String(body.body ?? "");
  if (bodyText.trim().length < 10) {
    return NextResponse.json({ errors: [{ code: "INVALID_BODY", detail: "body must be at least 10 chars" }] }, { status: 400 });
  }
  const title = body.title != null ? String(body.title).trim().slice(0, 200) : undefined;
  const changeNote = body.changeNote != null ? String(body.changeNote).slice(0, 500) : null;
  const actorLabel = gate.ctx.user?.email ?? `user:${gate.ctx.user?.id ?? "unknown"}`;

  try {
    const version = await addManualVersion(id, {
      title: title || undefined,
      body: bodyText,
      changeNote,
      actorLabel,
      userId: gate.ctx.user?.id ?? null,
    });
    await writeAudit({
      actorType: "user",
      actorId: gate.ctx.user?.id ?? null,
      action: "content.version.create",
      resource: "content_versions",
      resourceId: version.id,
      result: "success",
      requestId,
      metadata: { itemId: id, version: version.version },
    });
    return NextResponse.json({ data: { version }, meta: { requestId } });
  } catch (e) {
    if (e instanceof ContentServiceError) {
      const status = e.code === "NOT_FOUND" ? 404 : 400;
      await writeAudit({
        actorType: "user", actorId: gate.ctx.user?.id ?? null,
        action: "content.version.create", resource: "content_versions",
        result: "denied", requestId, metadata: { code: e.code, itemId: id },
      });
      return NextResponse.json({ errors: [{ code: e.code, detail: e.message }] }, { status });
    }
    throw e;
  }
}
