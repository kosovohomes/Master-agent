import { NextResponse } from "next/server";
import { requirePermission } from "@/lib/auth/guards";
import { getItem, reviewItem, ResearchServiceError } from "@/lib/research/service";
import { spawnTask } from "@/lib/tasks/queue";
import { isFlagEnabled } from "@/lib/settings";
import { writeAudit, requestIdFor } from "@/lib/audit";
import { ensureRegisteredForApi } from "@/lib/tasks/bootstrap";

export const runtime = "nodejs";

const ACTIONS = ["verify", "reject", "archive", "escalate", "process"] as const;
type Action = (typeof ACTIONS)[number];

/**
 * /api/admin/research/items/[id] (Phase 7).
 *  PATCH — research.manage: {action}
 *    verify | reject | archive | escalate → human review transitions
 *    process                              → re-analyze an 'unprocessed'
 *      item (spawns a research_run task restricted to the stored material;
 *      409 while the research flag is off, 409 when the item is not in the
 *      'unprocessed' state).
 *  All actions audited; findings/escalations stay immutable history apart
 *  from these explicit review transitions.
 */
export async function PATCH(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const requestId = requestIdFor(req);
  const gate = await requirePermission(req, "research.manage");
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

  const action = String(body.action ?? "") as Action;
  if (!ACTIONS.includes(action)) {
    return NextResponse.json({ errors: [{ code: "INVALID_ACTION", detail: `action must be one of ${ACTIONS.join(", ")}` }] }, { status: 400 });
  }

  const item = await getItem(id);
  if (!item) {
    return NextResponse.json({ errors: [{ code: "NOT_FOUND" }] }, { status: 404 });
  }

  const reviewer = gate.ctx.user?.email ?? `user:${gate.ctx.user?.id ?? "unknown"}`;

  if (action === "process") {
    if (item.status !== "unprocessed") {
      return NextResponse.json({ errors: [{ code: "NOT_UNPROCESSED", detail: `item status is ${item.status}` }] }, { status: 409 });
    }
    if (!(await isFlagEnabled("research", false))) {
      await writeAudit({
        actorType: "user", actorId: gate.ctx.user?.id ?? null,
        action: "research.item.process", resource: "research_items", resourceId: id,
        result: "denied", requestId, metadata: { reason: "research_flag_off" },
      });
      return NextResponse.json({ errors: [{ code: "RESEARCH_DISABLED", detail: "the research flag is OFF" }] }, { status: 409 });
    }
    ensureRegisteredForApi();
    const { taskId } = await spawnTask({
      businessUnitId: item.businessUnitId,
      kind: "research_run",
      payload: { researchItemId: item.id, agentSlug: item.agentSlug },
      priority: 10,
      maxAttempts: 3,
      createdBy: `user:${gate.ctx.user?.id ?? "unknown"}`,
    });
    await writeAudit({
      actorType: "user", actorId: gate.ctx.user?.id ?? null,
      action: "research.item.process", resource: "research_items", resourceId: id,
      result: "success", requestId, metadata: { taskId },
    });
    return NextResponse.json({ data: { taskId, itemId: id }, meta: { requestId } });
  }

  try {
    const updated = await reviewItem(id, action, reviewer);
    if (!updated) {
      return NextResponse.json({ errors: [{ code: "NOT_FOUND" }] }, { status: 404 });
    }
    await writeAudit({
      actorType: "user", actorId: gate.ctx.user?.id ?? null,
      action: `research.item.${action}`, resource: "research_items", resourceId: id,
      result: "success", requestId, metadata: { from: item.status, to: updated.status },
    });
    return NextResponse.json({ data: { item: updated }, meta: { requestId } });
  } catch (e) {
    if (e instanceof ResearchServiceError) {
      return NextResponse.json({ errors: [{ code: e.code, detail: e.message }] }, { status: 400 });
    }
    throw e;
  }
}
