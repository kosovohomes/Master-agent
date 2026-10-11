import { NextResponse } from "next/server";
import { requirePermission } from "@/lib/auth/guards";
import { onboardWebsite, OnboardError, type OnboardPayload } from "@/lib/connectors/onboard";
import { writeAudit, requestIdFor } from "@/lib/audit";

export const runtime = "nodejs";

/**
 * POST /api/admin/websites/onboard (Phase 14 — roadmap P13, §121–§123).
 *
 * The Add-Website wizard endpoint: executes the full §121 sequence
 * (business unit → website → agents → integrations → knowledge →
 * permissions → autonomy → activate) as PURE CONFIGURATION. No code,
 * migration, or redeploy is required to add a site — that is the acceptance
 * gate this endpoint exists to demonstrate.
 *
 * Permission model (least privilege):
 *  - website.manage is always required (the operation's core);
 *  - creating a NEW business unit additionally requires bu.manage — callers
 *    holding only website.manage must reference an existing businessUnit.id.
 *
 * Response carries per-step results. Connector credentials (webhook signing
 * secret / widget site key) are returned EXACTLY ONCE — on the call that
 * created them; resumed onboardings report "existing" and reveal nothing.
 * Secrets are never audited.
 */
export async function POST(req: Request) {
  const requestId = requestIdFor(req);
  const gate = await requirePermission(req, "website.manage");
  if (!gate.ok) return gate.response;
  const actor = gate.ctx.user!;

  let body: OnboardPayload;
  try {
    body = (await req.json()) as OnboardPayload;
  } catch {
    return NextResponse.json({ errors: [{ code: "INVALID_JSON" }] }, { status: 400 });
  }

  // Escalation check: a payload that would CREATE a business unit needs
  // bu.manage as well (the individual BU endpoint enforces the same).
  const createsBu = body?.businessUnit?.id === undefined && body?.businessUnit?.slug === undefined;
  if (createsBu) {
    const buGate = await requirePermission(req, "bu.manage");
    if (!buGate.ok) return buGate.response;
  }

  try {
    const result = await onboardWebsite(body, {
      actorId: actor.id,
      requestId,
      ip: req.headers.get("x-forwarded-for")?.split(",")[0]?.trim(),
    });
    const created = result.steps.some((s) => s.status === "created");
    await writeAudit({
      actorType: "user",
      actorId: actor.id,
      action: "onboard.complete",
      resource: "websites",
      resourceId: result.websiteId,
      result: "success",
      requestId,
      metadata: {
        businessUnitId: result.businessUnitId,
        websiteSlug: result.websiteSlug,
        // step manifest only — credentials deliberately omitted
        steps: result.steps.map(({ step, status, ref, id, detail }) => ({ step, status, ref, id, detail })),
      },
    });
    return NextResponse.json({ data: result, meta: { requestId } }, { status: created ? 201 : 200 });
  } catch (e) {
    if (e instanceof OnboardError) {
      await writeAudit({
        actorType: "user",
        actorId: actor.id,
        action: "onboard.complete",
        resource: "websites",
        result: "failure",
        requestId,
        metadata: { code: e.code },
      });
      return NextResponse.json({ errors: [{ code: e.code, detail: e.message }] }, { status: 400 });
    }
    await writeAudit({
      actorType: "user",
      actorId: actor.id,
      action: "onboard.complete",
      resource: "websites",
      result: "failure",
      requestId,
      metadata: {},
    });
    return NextResponse.json({ errors: [{ code: "ONBOARD_FAILED", detail: "internal error" }] }, { status: 500 });
  }
}
