import { NextResponse } from "next/server";
import { requirePermission } from "@/lib/auth/guards";
import { getItem } from "@/lib/content/service";
import { spawnTask } from "@/lib/tasks/queue";
import { isFlagEnabled } from "@/lib/settings";
import { writeAudit, requestIdFor } from "@/lib/audit";
import { ensureRegisteredForApi } from "@/lib/tasks/bootstrap";

export const runtime = "nodejs";

/**
 * POST /api/admin/content/[id]/run (Phase 8) — run / reprocess now.
 * Spawns one content_run task for the item (chain: strategy → content →
 * fact_check). Flag-gated fail-closed (409 when the content workforce is
 * off), audited. Doubles as the degraded-mode reprocess path: a parked item
 * (RESEARCHING + unprocessed_reason) re-enters the chain with its preserved
 * brief once the LLM is available again.
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

  if (!(await isFlagEnabled("content", false))) {
    await writeAudit({
      actorType: "user", actorId: gate.ctx.user?.id ?? null,
      action: "content.item.run", resource: "content_items", resourceId: id,
      result: "denied", requestId, metadata: { reason: "content_flag_off" },
    });
    return NextResponse.json({ errors: [{ code: "CONTENT_DISABLED", detail: "the content flag is OFF" }] }, { status: 409 });
  }

  const item = await getItem(id);
  if (!item) return NextResponse.json({ errors: [{ code: "NOT_FOUND" }] }, { status: 404 });
  if (["APPROVED", "PUBLISHED", "SCHEDULED"].includes(item.lifecycle)) {
    return NextResponse.json({ errors: [{ code: "INVALID_STATE", detail: `item is ${item.lifecycle}; the chain no longer applies` }] }, { status: 409 });
  }

  ensureRegisteredForApi();
  const { taskId } = await spawnTask({
    businessUnitId: item.businessUnitId,
    kind: "content_run",
    payload: { contentItemId: item.id, type: item.type },
    priority: 40,
    maxAttempts: 3,
    createdBy: `user:${gate.ctx.user?.id ?? "unknown"}`,
  });
  await writeAudit({
    actorType: "user",
    actorId: gate.ctx.user?.id ?? null,
    action: "content.item.run",
    resource: "content_items",
    resourceId: id,
    result: "success",
    requestId,
    metadata: { taskId, reprocess: item.lifecycle === "RESEARCHING" && item.unprocessedReason != null },
  });
  return NextResponse.json({ data: { taskId, itemId: id }, meta: { requestId } });
}
