import { NextResponse } from "next/server";
import {
  listWebsites,
  listWebsitesForBusinessUnits,
  createWebsite,
  updateWebsite,
  BuValidationError,
} from "@/lib/bu";
import { buScopeForUser } from "@/lib/auth/rbac";
import { requireAnyPermission, requirePermission } from "@/lib/auth/guards";
import { writeAudit, requestIdFor } from "@/lib/audit";

export const runtime = "nodejs";

/**
 * /api/admin/websites (Phase 1 M2).
 *  GET   — authenticated staff read, scoped to the caller's BU access
 *          (optional ?businessUnitId= filter, which must be within scope).
 *  POST  — website.manage. Creates a website under a business unit.
 *  PATCH — website.manage. Edits name/domain/environment/status/locale.
 * Mutations are audited. No code change is ever required to add a website.
 */
export async function GET(req: Request) {
  const requestId = requestIdFor(req);
  const gate = await requireAnyPermission(req, ["bu.manage", "website.manage", "drafts.read", "drafts.approve", "drafts.schedule"]);
  if (!gate.ok) return gate.response;
  const user = gate.ctx.user!;

  const scope = await buScopeForUser(user.id);
  const rawBu = new URL(req.url).searchParams.get("businessUnitId");

  if (rawBu !== null) {
    if (!/^\d+$/.test(rawBu)) {
      return NextResponse.json({ errors: [{ code: "INVALID_BU" }] }, { status: 400 });
    }
    const buId = Number(rawBu);
    if (scope.kind === "list" && !scope.businessUnitIds.includes(buId)) {
      return NextResponse.json({ errors: [{ code: "BU_SCOPE_DENIED" }] }, { status: 403 });
    }
    return NextResponse.json({ data: await listWebsites(buId), meta: { requestId } });
  }

  if (scope.kind === "all") {
    return NextResponse.json({ data: await listWebsites(), meta: { requestId } });
  }
  return NextResponse.json({ data: await listWebsitesForBusinessUnits(scope.businessUnitIds), meta: { requestId } });
}

export async function POST(req: Request) {
  const requestId = requestIdFor(req);
  const gate = await requirePermission(req, "website.manage");
  if (!gate.ok) return gate.response;
  const actor = gate.ctx.user!;

  let body: { businessUnitId?: number; name?: string; slug?: string; domain?: string; environment?: string; defaultLocale?: string; metadata?: Record<string, unknown> };
  try {
    body = (await req.json()) as typeof body;
  } catch {
    return NextResponse.json({ errors: [{ code: "INVALID_JSON" }] }, { status: 400 });
  }
  if (!Number.isInteger(body.businessUnitId) || typeof body.name !== "string" || body.name.trim() === "") {
    return NextResponse.json({ errors: [{ code: "INVALID_INPUT" }] }, { status: 400 });
  }
  const env = body.environment;
  if (env !== undefined && !["production", "staging", "development"].includes(env)) {
    return NextResponse.json({ errors: [{ code: "INVALID_ENVIRONMENT" }] }, { status: 400 });
  }
  try {
    const website = await createWebsite({
      businessUnitId: body.businessUnitId as number,
      name: body.name.trim(),
      slug: body.slug,
      domain: body.domain,
      environment: env as "production" | "staging" | "development" | undefined,
      defaultLocale: body.defaultLocale,
      metadata: body.metadata,
    });
    await writeAudit({ actorType: "user", actorId: actor.id, action: "website.create", resource: "websites", resourceId: website.id, result: "success", requestId, metadata: { slug: website.slug, businessUnitId: website.businessUnitId } });
    return NextResponse.json({ data: website, meta: { requestId } });
  } catch (e) {
    if (e instanceof BuValidationError) {
      return NextResponse.json({ errors: [{ code: "WEBSITE_CONFLICT", detail: e.message }] }, { status: 409 });
    }
    await writeAudit({ actorType: "user", actorId: actor.id, action: "website.create", resource: "websites", result: "failure", requestId, metadata: { businessUnitId: body.businessUnitId, name: body.name } });
    return NextResponse.json({ errors: [{ code: "WEBSITE_CREATE_FAILED" }] }, { status: 500 });
  }
}

export async function PATCH(req: Request) {
  const requestId = requestIdFor(req);
  const gate = await requirePermission(req, "website.manage");
  if (!gate.ok) return gate.response;
  const actor = gate.ctx.user!;

  let body: { id?: number; name?: string; domain?: string | null; environment?: string; status?: string; defaultLocale?: string };
  try {
    body = (await req.json()) as typeof body;
  } catch {
    return NextResponse.json({ errors: [{ code: "INVALID_JSON" }] }, { status: 400 });
  }
  const id = Number(body.id);
  if (!Number.isInteger(id)) {
    return NextResponse.json({ errors: [{ code: "INVALID_WEBSITE" }] }, { status: 400 });
  }
  if (body.status !== undefined && !["active", "inactive", "pending"].includes(body.status)) {
    return NextResponse.json({ errors: [{ code: "INVALID_STATUS" }] }, { status: 400 });
  }
  if (body.environment !== undefined && !["production", "staging", "development"].includes(body.environment)) {
    return NextResponse.json({ errors: [{ code: "INVALID_ENVIRONMENT" }] }, { status: 400 });
  }
  const updated = await updateWebsite(id, {
    name: body.name,
    domain: body.domain,
    environment: body.environment as "production" | "staging" | "development" | undefined,
    status: body.status as "active" | "inactive" | "pending" | undefined,
    defaultLocale: body.defaultLocale,
  });
  if (!updated) {
    return NextResponse.json({ errors: [{ code: "UNKNOWN_WEBSITE" }] }, { status: 404 });
  }
  await writeAudit({ actorType: "user", actorId: actor.id, action: "website.update", resource: "websites", resourceId: id, result: "success", requestId, metadata: { fields: Object.keys(body).filter((k) => k !== "id") } });
  return NextResponse.json({ data: updated, meta: { requestId } });
}
