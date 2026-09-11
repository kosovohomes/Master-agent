import { NextResponse } from "next/server";
import { approveDraft, rejectDraft, scheduleDraft } from "@/lib/agents/approval";
import { sessionOrLegacyBearerAny, forbidden } from "@/lib/auth/guards";
import { writeAudit, requestIdFor } from "@/lib/audit";

export const runtime = "nodejs";

/**
 * POST /api/admin/drafts/[id] — approve / reject / schedule (Phase 1 M1).
 *
 * Auth model (§12.4 "session-or-legacy-bearer, reviewer recorded"):
 *  - session: per-action permission enforced server-side (drafts.approve for
 *    approve/reject, drafts.schedule for schedule); the acting user is
 *    recorded as approvals.reviewer_user_id
 *  - legacy bearer (flag-gated transition): permitted as before, reviewer null
 * Every action attempt is audited; FSM transitions are transactional (SEC-C7).
 */
export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const requestId = requestIdFor(req);
  const gate = await sessionOrLegacyBearerAny(req);
  if (!gate.ok) return gate.response;

  const user = gate.ctx.user;
  const via = gate.ctx.via;

  const draftId = Number((await params).id);
  let body: { action?: string; comment?: string };
  try {
    body = (await req.json()) as typeof body;
  } catch {
    return NextResponse.json({ errors: [{ code: "INVALID_JSON" }] }, { status: 400 });
  }

  // Action-specific permission, enforced server-side (session users only).
  const required = body.action === "schedule" ? "drafts.schedule" : "drafts.approve";
  if (user && !user.permissions.includes(required)) {
    await writeAudit({ actorType: "user", actorId: user.id, action: `draft.${body.action ?? "unknown"}`, resource: "drafts", resourceId: draftId, result: "denied", requestId, metadata: { reason: `missing:${required}` } });
    return forbidden();
  }

  const reviewer = user ? { userId: user.id } : undefined;

  try {
    if (body.action === "approve") await approveDraft(draftId, reviewer);
    else if (body.action === "reject") await rejectDraft(draftId, body.comment ?? "", reviewer);
    else if (body.action === "schedule") await scheduleDraft(draftId, reviewer);
    else return NextResponse.json({ errors: [{ code: "INVALID_ACTION" }] }, { status: 400 });

    await writeAudit({
      actorType: user ? "user" : "system",
      actorId: user?.id ?? null,
      actorLabel: user ? undefined : "ops:bearer",
      action: `draft.${body.action}`,
      resource: "drafts",
      resourceId: draftId,
      result: "success",
      requestId,
      metadata: { via, comment: body.comment ?? null },
    });
    return NextResponse.json({ data: { draftId } });
  } catch (e) {
    const notFound = e instanceof Error && e.message.startsWith("draft not found");
    const illegal = e instanceof Error && e.message.startsWith("illegal draft transition");
    await writeAudit({
      actorType: user ? "user" : "system",
      actorId: user?.id ?? null,
      action: `draft.${body.action ?? "unknown"}`,
      resource: "drafts",
      resourceId: draftId,
      result: "failure",
      requestId,
      metadata: { notFound, illegal, detail: e instanceof Error ? e.message : "unknown" },
    });
    return NextResponse.json({ errors: [{ code: "ACTION_FAILED", detail: "internal error" }] }, { status: 400 });
  }
}
