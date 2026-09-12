import { NextResponse } from "next/server";
import { requirePermission } from "@/lib/auth/guards";
import { getKnowledgeSource } from "@/lib/knowledge/service";
import { spawnTask } from "@/lib/tasks/queue";
import { writeAudit, requestIdFor } from "@/lib/audit";

export const runtime = "nodejs";

/**
 * POST /api/admin/knowledge/[id]/fetch (Phase 5): enqueue a durable
 * knowledge_fetch task for this source (Phase 3 machinery reused — the task
 * retries under backoff, records steps, and emits
 * knowledge.source.fetched|failed for the Operations screen). Idempotency
 * key prevents double-spawning while a fetch for the same revision window is
 * still pending. knowledge.manage, audited.
 */
export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const requestId = requestIdFor(req);
  const gate = await requirePermission(req, "knowledge.manage");
  if (!gate.ok) return gate.response;
  const { id: idRaw } = await params;
  const id = Number(idRaw);
  if (!Number.isInteger(id) || id <= 0) {
    return NextResponse.json({ errors: [{ code: "INVALID_ID" }] }, { status: 400 });
  }

  const source = await getKnowledgeSource(id);
  if (!source) {
    return NextResponse.json({ errors: [{ code: "NOT_FOUND" }] }, { status: 404 });
  }

  const { taskId, created } = await spawnTask({
    businessUnitId: source.businessUnitId,
    kind: "knowledge_fetch",
    payload: { knowledgeSourceId: source.id },
    idempotencyKey: `knowledge_fetch:${source.id}`,
    createdBy: gate.ctx.user ? `user:${gate.ctx.user.id}` : "user:unknown",
  });

  await writeAudit({
    actorType: "user",
    actorId: gate.ctx.user?.id ?? null,
    action: "knowledge.fetch",
    resource: "knowledge_sources",
    resourceId: source.id,
    result: "success",
    requestId,
    metadata: { taskId, created },
  });

  return NextResponse.json({
    data: { taskId, created, sourceId: source.id },
    meta: { requestId },
  });
}
