import { NextResponse } from "next/server";
import {
  listBusinessUnits,
  createBusinessUnit,
  updateBusinessUnit,
  BuValidationError,
  type BusinessUnitRow,
} from "@/lib/bu";
import { buScopeForUser } from "@/lib/auth/rbac";
import { requireAnyPermission, requirePermission } from "@/lib/auth/guards";
import { writeAudit, requestIdFor } from "@/lib/audit";

export const runtime = "nodejs";

/**
 * /api/admin/business-units (Phase 1 M2).
 *  GET   — any authenticated staff read (owner/administrator: all;
 *          scoped roles: only their BUs). Powers the Command Center nav
 *          and the approvals picker for reviewers.
 *  POST  — bu.manage. Creates a business unit (configuration row only —
 *          no code changes for a new business).
 *  PATCH — bu.manage. Edits name/status/brand fields.
 * Mutations are audited.
 */
export async function GET(req: Request) {
  const requestId = requestIdFor(req);
  const gate = await requireAnyPermission(req, ["bu.manage", "website.manage", "drafts.read", "drafts.approve", "drafts.schedule"]);
  if (!gate.ok) return gate.response;
  const user = gate.ctx.user!;

  const rows: BusinessUnitRow[] = await listBusinessUnits();
  const scope = await buScopeForUser(user.id);
  const visible = scope.kind === "all" ? rows : rows.filter((bu) => scope.businessUnitIds.includes(bu.id));
  return NextResponse.json({ data: visible, meta: { requestId } });
}

export async function POST(req: Request) {
  const requestId = requestIdFor(req);
  const gate = await requirePermission(req, "bu.manage");
  if (!gate.ok) return gate.response;
  const actor = gate.ctx.user!;

  let body: { name?: string; slug?: string; brandVoice?: string; persona?: string; audience?: string; contactEmail?: string; metadata?: Record<string, unknown> };
  try {
    body = (await req.json()) as typeof body;
  } catch {
    return NextResponse.json({ errors: [{ code: "INVALID_JSON" }] }, { status: 400 });
  }
  if (typeof body.name !== "string" || body.name.trim() === "") {
    return NextResponse.json({ errors: [{ code: "INVALID_NAME" }] }, { status: 400 });
  }
  try {
    const bu = await createBusinessUnit({
      name: body.name.trim(),
      slug: body.slug,
      brandVoice: body.brandVoice,
      persona: body.persona,
      audience: body.audience,
      contactEmail: body.contactEmail,
      metadata: body.metadata,
    });
    await writeAudit({ actorType: "user", actorId: actor.id, action: "bu.create", resource: "business_units", resourceId: bu.id, result: "success", requestId, metadata: { slug: bu.slug, name: bu.name } });
    return NextResponse.json({ data: bu, meta: { requestId } });
  } catch (e) {
    if (e instanceof BuValidationError) {
      return NextResponse.json({ errors: [{ code: "SLUG_TAKEN", detail: e.message }] }, { status: 409 });
    }
    await writeAudit({ actorType: "user", actorId: actor.id, action: "bu.create", resource: "business_units", result: "failure", requestId, metadata: { name: body.name } });
    return NextResponse.json({ errors: [{ code: "BU_CREATE_FAILED" }] }, { status: 500 });
  }
}

export async function PATCH(req: Request) {
  const requestId = requestIdFor(req);
  const gate = await requirePermission(req, "bu.manage");
  if (!gate.ok) return gate.response;
  const actor = gate.ctx.user!;

  let body: { id?: number; name?: string; status?: string; brandVoice?: string; persona?: string; audience?: string; contactEmail?: string | null };
  try {
    body = (await req.json()) as typeof body;
  } catch {
    return NextResponse.json({ errors: [{ code: "INVALID_JSON" }] }, { status: 400 });
  }
  const id = Number(body.id);
  if (!Number.isInteger(id)) {
    return NextResponse.json({ errors: [{ code: "INVALID_BU" }] }, { status: 400 });
  }
  if (body.status !== undefined && body.status !== "active" && body.status !== "suspended") {
    return NextResponse.json({ errors: [{ code: "INVALID_STATUS" }] }, { status: 400 });
  }
  const updated = await updateBusinessUnit(id, {
    name: body.name,
    status: body.status as "active" | "suspended" | undefined,
    brandVoice: body.brandVoice,
    persona: body.persona,
    audience: body.audience,
    contactEmail: body.contactEmail,
  });
  if (!updated) {
    return NextResponse.json({ errors: [{ code: "UNKNOWN_BU" }] }, { status: 404 });
  }
  await writeAudit({ actorType: "user", actorId: actor.id, action: "bu.update", resource: "business_units", resourceId: id, result: "success", requestId, metadata: { fields: Object.keys(body).filter((k) => k !== "id") } });
  return NextResponse.json({ data: updated, meta: { requestId } });
}
