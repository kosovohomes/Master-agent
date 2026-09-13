import { NextResponse } from "next/server";
import { requireAnyPermission, requirePermission } from "@/lib/auth/guards";
import {
  getItem,
  listVersions,
  listApprovalsForItem,
  listActionsForItem,
  transitionItem,
  ContentServiceError,
} from "@/lib/content/service";
import type { ContentLifecycle } from "@/lib/content/types";
import { writeAudit, requestIdFor } from "@/lib/audit";

export const runtime = "nodejs";

/**
 * /api/admin/content/[id] (Phase 8).
 *  GET   — content.manage / audit.read: item + versions + decisions + trail.
 *  PATCH — content.manage: explicit lifecycle transition {lifecycle}. The FSM
 *          table (lib/content/types) is the only legality authority; illegal
 *          moves 400. Audited. Used for the operator path (APPROVED →
 *          SCHEDULED/PUBLISHED/ARCHIVED, IDEA → ARCHIVED, …).
 */
export async function GET(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const requestId = requestIdFor(req);
  const gate = await requireAnyPermission(req, ["content.manage", "audit.read"]);
  if (!gate.ok) return gate.response;

  const { id: idRaw } = await ctx.params;
  const id = Number(idRaw);
  if (!Number.isInteger(id) || id <= 0) {
    return NextResponse.json({ errors: [{ code: "INVALID_ID" }] }, { status: 400 });
  }

  const item = await getItem(id);
  if (!item) return NextResponse.json({ errors: [{ code: "NOT_FOUND" }] }, { status: 404 });

  const [versions, approvals, actions] = await Promise.all([
    listVersions(id),
    listApprovalsForItem(id),
    listActionsForItem(id),
  ]);
  return NextResponse.json({ data: { item, versions, approvals, actions }, meta: { requestId } });
}

export async function PATCH(req: Request, ctx: { params: Promise<{ id: string }> }) {
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

  const to = String(body.lifecycle ?? "");
  const ALLOWED: readonly ContentLifecycle[] = ["ARCHIVED", "SCHEDULED", "PUBLISHED", "DRAFT", "REVIEW", "FACT_CHECK", "RESEARCHING", "APPROVED", "IDEA"];
  if (!ALLOWED.includes(to as ContentLifecycle)) {
    return NextResponse.json({ errors: [{ code: "INVALID_LIFECYCLE" }] }, { status: 400 });
  }

  try {
    const item = await transitionItem(id, to as ContentLifecycle, {
      actorLabel: gate.ctx.user?.email ?? `user:${gate.ctx.user?.id ?? "unknown"}`,
      userId: gate.ctx.user?.id ?? null,
    });
    await writeAudit({
      actorType: "user",
      actorId: gate.ctx.user?.id ?? null,
      action: "content.item.transition",
      resource: "content_items",
      resourceId: id,
      result: "success",
      requestId,
      metadata: { to },
    });
    return NextResponse.json({ data: { item }, meta: { requestId } });
  } catch (e) {
    if (e instanceof ContentServiceError) {
      const status = e.code === "NOT_FOUND" ? 404 : e.code === "ILLEGAL_TRANSITION" ? 409 : 400;
      await writeAudit({
        actorType: "user", actorId: gate.ctx.user?.id ?? null,
        action: "content.item.transition", resource: "content_items", resourceId: id,
        result: "denied", requestId, metadata: { code: e.code, to, detail: e.message },
      });
      return NextResponse.json({ errors: [{ code: e.code, detail: e.message }] }, { status });
    }
    throw e;
  }
}
