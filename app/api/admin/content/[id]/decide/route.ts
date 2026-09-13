import { NextResponse } from "next/server";
import { requirePermission } from "@/lib/auth/guards";
import { decideItem, ContentServiceError } from "@/lib/content/service";
import type { ApprovalDecision } from "@/lib/content/types";
import { writeAudit, requestIdFor } from "@/lib/audit";

export const runtime = "nodejs";

/**
 * POST /api/admin/content/[id]/decide (Phase 8 — approval center v2).
 * Human decision on an item in REVIEW: approve | reject | request_changes.
 * Writes the immutable approvals decision row (§72), the approval_actions
 * trail entry, and the lifecycle transition (REVIEW → APPROVED / ARCHIVED /
 * DRAFT). Audited; the decision reason is required for reject /
 * request_changes.
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

  const decision = String(body.decision ?? "");
  if (!["approve", "reject", "request_changes"].includes(decision)) {
    return NextResponse.json({ errors: [{ code: "INVALID_DECISION", detail: "decision must be approve | reject | request_changes" }] }, { status: 400 });
  }
  const comment = body.comment != null ? String(body.comment).slice(0, 2000) : null;
  if (decision !== "approve" && (comment == null || comment.trim() === "")) {
    return NextResponse.json({ errors: [{ code: "REASON_REQUIRED", detail: "reject / request_changes require a comment" }] }, { status: 400 });
  }
  const reviewerLabel = gate.ctx.user?.email ?? `user:${gate.ctx.user?.id ?? "unknown"}`;

  try {
    const item = await decideItem(id, {
      decision: decision as ApprovalDecision,
      comment,
      reviewerUserId: gate.ctx.user?.id ?? null,
      reviewerLabel,
    });
    await writeAudit({
      actorType: "user",
      actorId: gate.ctx.user?.id ?? null,
      action: `content.review.${decision}`,
      resource: "content_items",
      resourceId: id,
      result: "success",
      requestId,
      metadata: { decision, lifecycle: item.lifecycle, hasComment: comment != null },
    });
    return NextResponse.json({ data: { item }, meta: { requestId } });
  } catch (e) {
    if (e instanceof ContentServiceError) {
      const status = e.code === "NOT_FOUND" ? 404 : e.code === "NOT_IN_REVIEW" ? 409 : 400;
      await writeAudit({
        actorType: "user", actorId: gate.ctx.user?.id ?? null,
        action: `content.review.${decision}`, resource: "content_items", resourceId: id,
        result: "denied", requestId, metadata: { code: e.code, detail: e.message },
      });
      return NextResponse.json({ errors: [{ code: e.code, detail: e.message }] }, { status });
    }
    throw e;
  }
}
