import { NextResponse } from "next/server";
import { requirePermission } from "@/lib/auth/guards";
import {
  getKnowledgeSource,
  updateKnowledgeSource,
  deleteKnowledgeSource,
  KnowledgeSourceError,
} from "@/lib/knowledge/service";
import { writeAudit, requestIdFor } from "@/lib/audit";

export const runtime = "nodejs";

const ACCESS_LEVELS = ["public", "internal", "confidential"];
const REFRESH = ["manual", "hourly", "daily", "weekly"];
const STATUSES = ["active", "disabled", "error"];

/**
 * /api/admin/knowledge/[id] (Phase 5). knowledge.manage:
 *  PATCH  — update lifecycle/metadata fields (title, description,
 *           authorityLevel, jurisdiction, ..., accessLevel,
 *           refreshFrequency, maxDocuments, status, websiteId). Audited.
 *  DELETE — remove a source (documents keep ON DELETE SET NULL lineage).
 *           Audited.
 */
export async function PATCH(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const requestId = requestIdFor(req);
  const gate = await requirePermission(req, "knowledge.manage");
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

  if (body.accessLevel != null && !ACCESS_LEVELS.includes(String(body.accessLevel))) {
    return NextResponse.json({ errors: [{ code: "INVALID_ACCESS_LEVEL" }] }, { status: 400 });
  }
  if (body.refreshFrequency != null && !REFRESH.includes(String(body.refreshFrequency))) {
    return NextResponse.json({ errors: [{ code: "INVALID_REFRESH" }] }, { status: 400 });
  }
  if (body.status != null && !STATUSES.includes(String(body.status))) {
    return NextResponse.json({ errors: [{ code: "INVALID_STATUS" }] }, { status: 400 });
  }

  try {
    const source = await updateKnowledgeSource(id, {
      title: body.title != null ? String(body.title) : undefined,
      description: body.description != null ? String(body.description) : undefined,
      authorityLevel: body.authorityLevel != null ? Number(body.authorityLevel) : undefined,
      jurisdiction: body.jurisdiction !== undefined ? (body.jurisdiction == null ? null : String(body.jurisdiction)) : undefined,
      stateProvince: body.stateProvince !== undefined ? (body.stateProvince == null ? null : String(body.stateProvince)) : undefined,
      country: body.country !== undefined ? (body.country == null ? null : String(body.country)) : undefined,
      language: body.language !== undefined ? (body.language == null ? null : String(body.language)) : undefined,
      documentType: body.documentType !== undefined ? (body.documentType == null ? null : String(body.documentType)) : undefined,
      accessLevel: body.accessLevel != null ? (String(body.accessLevel) as never) : undefined,
      refreshFrequency: body.refreshFrequency != null ? (String(body.refreshFrequency) as never) : undefined,
      maxDocuments: body.maxDocuments != null ? Number(body.maxDocuments) : undefined,
      status: body.status != null ? (String(body.status) as never) : undefined,
      websiteId: body.websiteId !== undefined ? (body.websiteId == null ? null : Number(body.websiteId)) : undefined,
    });
    if (!source) {
      return NextResponse.json({ errors: [{ code: "NOT_FOUND" }] }, { status: 404 });
    }
    await writeAudit({
      actorType: "user",
      actorId: gate.ctx.user?.id ?? null,
      action: "knowledge.source.update",
      resource: "knowledge_sources",
      resourceId: id,
      result: "success",
      requestId,
      metadata: { fields: Object.keys(body) },
    });
    return NextResponse.json({ data: { source }, meta: { requestId } });
  } catch (e) {
    if (e instanceof KnowledgeSourceError) {
      return NextResponse.json({ errors: [{ code: e.code, detail: e.message }] }, { status: 400 });
    }
    throw e;
  }
}

export async function DELETE(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const requestId = requestIdFor(req);
  const gate = await requirePermission(req, "knowledge.manage");
  if (!gate.ok) return gate.response;
  const { id: idRaw } = await params;
  const id = Number(idRaw);
  if (!Number.isInteger(id) || id <= 0) {
    return NextResponse.json({ errors: [{ code: "INVALID_ID" }] }, { status: 400 });
  }

  const existing = await getKnowledgeSource(id);
  if (!existing) {
    return NextResponse.json({ errors: [{ code: "NOT_FOUND" }] }, { status: 404 });
  }
  await deleteKnowledgeSource(id);
  await writeAudit({
    actorType: "user",
    actorId: gate.ctx.user?.id ?? null,
    action: "knowledge.source.delete",
    resource: "knowledge_sources",
    resourceId: id,
    result: "success",
    requestId,
    metadata: { kind: existing.kind, ref: existing.ref },
  });
  return NextResponse.json({ data: { deleted: true }, meta: { requestId } });
}
