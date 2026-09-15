import { NextResponse } from "next/server";
import { requirePermission } from "@/lib/auth/guards";
import { cancelPost, getPost, schedulePost } from "@/lib/social/service";
import { SocialServiceError } from "@/lib/social/types";
import { writeAudit, requestIdFor } from "@/lib/audit";

export const runtime = "nodejs";

/**
 * /api/admin/social/posts/[id] (Phase 10).
 *  PATCH — social.manage:
 *    {action: "schedule", scheduledAt, body?}  draft|failed|scheduled → scheduled
 *    {action: "cancel"}                        draft|scheduled|failed → cancelled
 *    {action: "reschedule", scheduledAt}       alias of schedule
 *  Audited. Publishing is NOT manually-triggerable here — the sweep owns
 *  the publishing transition (idempotency claim §88 lives there).
 */
export async function PATCH(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const requestId = requestIdFor(req);
  const gate = await requirePermission(req, "social.manage");
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

  const action = String(body.action ?? "");
  try {
    let post;
    if (action === "cancel") {
      post = await cancelPost(id);
    } else if (action === "schedule" || action === "reschedule") {
      const scheduledAt = typeof body.scheduledAt === "string" ? body.scheduledAt : null;
      if (!scheduledAt) {
        return NextResponse.json({ errors: [{ code: "SCHEDULED_AT_REQUIRED" }] }, { status: 400 });
      }
      post = await schedulePost(id, scheduledAt, {
        body: typeof body.body === "string" ? body.body : null,
      });
    } else {
      return NextResponse.json(
        { errors: [{ code: "INVALID_ACTION", detail: "action must be schedule | reschedule | cancel" }] },
        { status: 400 }
      );
    }
    await writeAudit({
      actorType: "user",
      actorId: gate.ctx.user?.id ?? null,
      action: `social.post.${action}`,
      resource: "social_posts",
      resourceId: post.id,
      result: "success",
      requestId,
      metadata: { status: post.status, scheduledAt: post.scheduledAt },
    });
    return NextResponse.json({ data: { post }, meta: { requestId } });
  } catch (e) {
    const code = e instanceof SocialServiceError ? e.code : "POST_UPDATE_FAILED";
    const status =
      code === "NOT_FOUND" ? 404 :
      code === "BAD_TRANSITION" ? 409 :
      code === "BAD_SCHEDULE" ? 400 : 500;
    return NextResponse.json({ errors: [{ code, detail: e instanceof Error ? e.message : undefined }] }, { status });
  }
}

export async function GET(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const requestId = requestIdFor(req);
  const gate = await requirePermission(req, "social.manage");
  if (!gate.ok) return gate.response;
  const { id: idRaw } = await ctx.params;
  const id = Number(idRaw);
  if (!Number.isInteger(id) || id <= 0) {
    return NextResponse.json({ errors: [{ code: "INVALID_ID" }] }, { status: 400 });
  }
  const post = await getPost(id);
  if (!post) return NextResponse.json({ errors: [{ code: "NOT_FOUND" }] }, { status: 404 });
  return NextResponse.json({ data: { post }, meta: { requestId } });
}
