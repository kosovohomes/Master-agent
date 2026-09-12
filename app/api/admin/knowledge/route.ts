import { NextResponse } from "next/server";
import { requireAnyPermission, requirePermission } from "@/lib/auth/guards";
import {
  listKnowledgeSources,
  createKnowledgeSource,
  KnowledgeSourceError,
} from "@/lib/knowledge/service";
import { isFlagEnabled } from "@/lib/settings";
import { writeAudit, requestIdFor } from "@/lib/audit";

export const runtime = "nodejs";

const KINDS = ["sitemap", "upload", "api", "rss", "url", "github", "db"];
const ACCESS_LEVELS = ["public", "internal", "confidential"];
const REFRESH = ["manual", "hourly", "daily", "weekly"];

/**
 * /api/admin/knowledge (Phase 5 — knowledge system v2, §9.2).
 *  GET  — knowledge.manage / audit.read: source registry with scope +
 *         lifecycle metadata (and the knowledge_v2 flag state for the UI).
 *  POST — knowledge.manage: create a source
 *         {kind, ref, businessUnitId?, websiteId?, title?, description?,
 *          authorityLevel? 1..5, jurisdiction?, country?, stateProvince?,
 *          language?, documentType?, accessLevel?, refreshFrequency?,
 *          maxDocuments?}. Audited.
 */
export async function GET(req: Request) {
  const requestId = requestIdFor(req);
  const gate = await requireAnyPermission(req, ["knowledge.manage", "audit.read"]);
  if (!gate.ok) return gate.response;

  const url = new URL(req.url);
  const buRaw = url.searchParams.get("businessUnitId");
  const businessUnitId = buRaw && /^\d+$/.test(buRaw) ? Number(buRaw) : null;

  const [sources, flag] = await Promise.all([
    listKnowledgeSources(businessUnitId),
    isFlagEnabled("knowledge_v2", false),
  ]);
  return NextResponse.json({ data: { sources, knowledgeV2: flag }, meta: { requestId } });
}

export async function POST(req: Request) {
  const requestId = requestIdFor(req);
  const gate = await requirePermission(req, "knowledge.manage");
  if (!gate.ok) return gate.response;

  let body: Record<string, unknown>;
  try {
    body = (await req.json()) as Record<string, unknown>;
  } catch {
    return NextResponse.json({ errors: [{ code: "INVALID_JSON" }] }, { status: 400 });
  }

  const kind = String(body.kind ?? "");
  const ref = String(body.ref ?? "").trim();
  if (!KINDS.includes(kind)) {
    return NextResponse.json({ errors: [{ code: "INVALID_KIND", detail: `kind must be one of ${KINDS.join(", ")}` }] }, { status: 400 });
  }
  if (ref === "") {
    return NextResponse.json({ errors: [{ code: "REF_REQUIRED" }] }, { status: 400 });
  }
  const accessLevel = body.accessLevel != null ? String(body.accessLevel) : undefined;
  if (accessLevel != null && !ACCESS_LEVELS.includes(accessLevel)) {
    return NextResponse.json({ errors: [{ code: "INVALID_ACCESS_LEVEL" }] }, { status: 400 });
  }
  const refreshFrequency = body.refreshFrequency != null ? String(body.refreshFrequency) : undefined;
  if (refreshFrequency != null && !REFRESH.includes(refreshFrequency)) {
    return NextResponse.json({ errors: [{ code: "INVALID_REFRESH" }] }, { status: 400 });
  }

  try {
    const source = await createKnowledgeSource({
      kind: kind as never,
      ref,
      businessUnitId: body.businessUnitId != null ? Number(body.businessUnitId) : null,
      websiteId: body.websiteId != null ? Number(body.websiteId) : null,
      title: body.title != null ? String(body.title) : undefined,
      description: body.description != null ? String(body.description) : undefined,
      authorityLevel: body.authorityLevel != null ? Number(body.authorityLevel) : undefined,
      jurisdiction: body.jurisdiction != null ? String(body.jurisdiction) : null,
      country: body.country != null ? String(body.country) : null,
      stateProvince: body.stateProvince != null ? String(body.stateProvince) : null,
      language: body.language != null ? String(body.language) : null,
      documentType: body.documentType != null ? String(body.documentType) : null,
      accessLevel: accessLevel as never,
      refreshFrequency: refreshFrequency as never,
      maxDocuments: body.maxDocuments != null ? Number(body.maxDocuments) : undefined,
    });
    await writeAudit({
      actorType: "user",
      actorId: gate.ctx.user?.id ?? null,
      action: "knowledge.source.create",
      resource: "knowledge_sources",
      resourceId: source.id,
      result: "success",
      requestId,
      metadata: { kind: source.kind, ref: source.ref, businessUnitId: source.businessUnitId, jurisdiction: source.jurisdiction, authorityLevel: source.authorityLevel, accessLevel: source.accessLevel },
    });
    return NextResponse.json({ data: { source }, meta: { requestId } });
  } catch (e) {
    if (e instanceof KnowledgeSourceError) {
      return NextResponse.json({ errors: [{ code: e.code, detail: e.message }] }, { status: 400 });
    }
    throw e;
  }
}
