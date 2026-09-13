import { NextResponse } from "next/server";
import { requireAnyPermission, requirePermission } from "@/lib/auth/guards";
import {
  listItems,
  listPendingReviews,
  stats,
  createItem,
  CONTENT_TYPES,
  ContentServiceError,
} from "@/lib/content/service";
import type { ContentLifecycle, ContentType } from "@/lib/content/types";
import { isFlagEnabled } from "@/lib/settings";
import { writeAudit, requestIdFor } from "@/lib/audit";
import { ensureRegisteredForApi } from "@/lib/tasks/bootstrap";
import { spawnTask } from "@/lib/tasks/queue";

export const runtime = "nodejs";

/**
 * /api/admin/content (Phase 8 — content workforce control surface).
 *  GET  — content.manage / audit.read: items (filterable), pending reviews,
 *         per-lifecycle stats, flag state.
 *  POST — content.manage:
 *         {mode:"item", businessUnitId, type?, title?, brief?, websiteId?,
 *          researchItemId?, body?}          → create the artifact (IDEA/DRAFT)
 *         {mode:"run", businessUnitId, brief|researchItemId|contentItemId,
 *          type?, websiteId?}               → spawn a content_run task
 *         Audited. The chain itself is flag-gated at execution time.
 */
export async function GET(req: Request) {
  const requestId = requestIdFor(req);
  const gate = await requireAnyPermission(req, ["content.manage", "audit.read"]);
  if (!gate.ok) return gate.response;

  const url = new URL(req.url);
  const buRaw = url.searchParams.get("businessUnitId");
  const businessUnitId = buRaw && /^\d+$/.test(buRaw) ? Number(buRaw) : null;
  const lifecycleRaw = url.searchParams.get("lifecycle");
  const lifecycle = lifecycleRaw && lifecycleRaw !== "" ? (lifecycleRaw as ContentLifecycle) : null;

  const [items, pending, statRows, flag] = await Promise.all([
    listItems({ businessUnitId, lifecycle, limit: 100 }),
    listPendingReviews(businessUnitId, 50),
    stats(businessUnitId),
    isFlagEnabled("content", false),
  ]);
  return NextResponse.json({
    data: { items, pending, stats: statRows, flag },
    meta: { requestId },
  });
}

export async function POST(req: Request) {
  const requestId = requestIdFor(req);
  const gate = await requirePermission(req, "content.manage");
  if (!gate.ok) return gate.response;

  let body: Record<string, unknown>;
  try {
    body = (await req.json()) as Record<string, unknown>;
  } catch {
    return NextResponse.json({ errors: [{ code: "INVALID_JSON" }] }, { status: 400 });
  }

  const mode = String(body.mode ?? "item");
  const businessUnitId = Number(body.businessUnitId);
  if (!Number.isInteger(businessUnitId) || businessUnitId <= 0) {
    return NextResponse.json({ errors: [{ code: "BUSINESS_UNIT_ID_REQUIRED" }] }, { status: 400 });
  }
  const typeRaw = body.type != null ? String(body.type) : "article";
  if (!CONTENT_TYPES.includes(typeRaw as ContentType)) {
    return NextResponse.json({ errors: [{ code: "INVALID_TYPE", detail: `type must be one of ${CONTENT_TYPES.join(", ")}` }] }, { status: 400 });
  }
  const websiteId = body.websiteId != null && /^\d+$/.test(String(body.websiteId)) ? Number(body.websiteId) : null;

  try {
    if (mode === "run") {
      // Fail-closed at the API surface (same contract as the research
      // run-now route): the flag OFF means no chain execution — the handler
      // would skip anyway, but the caller gets an explicit 409 here.
      if (!(await isFlagEnabled("content", false))) {
        await writeAudit({
          actorType: "user", actorId: gate.ctx.user?.id ?? null,
          action: "content.run.spawn", resource: "content_items",
          result: "denied", requestId, metadata: { reason: "content_flag_off" },
        });
        return NextResponse.json({ errors: [{ code: "CONTENT_DISABLED", detail: "the content flag is OFF" }] }, { status: 409 });
      }
      const brief = body.brief != null ? String(body.brief).trim() : "";
      const researchItemId = body.researchItemId != null && /^\d+$/.test(String(body.researchItemId)) ? Number(body.researchItemId) : undefined;
      const contentItemId = body.contentItemId != null && /^\d+$/.test(String(body.contentItemId)) ? Number(body.contentItemId) : undefined;
      if (!brief && researchItemId == null && contentItemId == null) {
        return NextResponse.json({ errors: [{ code: "INVALID_RUN_INPUT", detail: "one of brief | researchItemId | contentItemId is required" }] }, { status: 400 });
      }
      ensureRegisteredForApi();
      const { taskId } = await spawnTask({
        businessUnitId,
        kind: "content_run",
        payload: {
          brief: brief || undefined,
          researchItemId,
          contentItemId,
          type: typeRaw,
          websiteId: websiteId ?? undefined,
        },
        priority: 40,
        maxAttempts: 3,
        createdBy: `user:${gate.ctx.user?.id ?? "unknown"}`,
      });
      await writeAudit({
        actorType: "user",
        actorId: gate.ctx.user?.id ?? null,
        action: "content.run.spawn",
        resource: "content_items",
        resourceId: taskId,
        result: "success",
        requestId,
        metadata: { businessUnitId, mode: "run", researchItemId: researchItemId ?? null, contentItemId: contentItemId ?? null, hasBrief: brief !== "" },
      });
      return NextResponse.json({ data: { taskId }, meta: { requestId } });
    }

    // mode === "item" (default)
    const title = body.title != null ? String(body.title).trim().slice(0, 200) : null;
    const briefObj = body.brief != null && typeof body.brief === "object" && !Array.isArray(body.brief)
      ? (body.brief as Record<string, unknown>)
      : typeof body.brief === "string" && body.brief.trim() !== ""
        ? { text: String(body.brief).slice(0, 8000) }
        : {};
    const researchItemId = body.researchItemId != null && /^\d+$/.test(String(body.researchItemId)) ? Number(body.researchItemId) : null;
    const bodyText = body.body != null ? String(body.body) : null;

    const item = await createItem({
      businessUnitId,
      websiteId,
      researchItemId,
      type: typeRaw as ContentType,
      title,
      brief: briefObj,
      body: bodyText && bodyText.trim().length >= 50 ? bodyText : null,
    });
    await writeAudit({
      actorType: "user",
      actorId: gate.ctx.user?.id ?? null,
      action: "content.item.create",
      resource: "content_items",
      resourceId: item.id,
      result: "success",
      requestId,
      metadata: { businessUnitId, type: item.type, lifecycle: item.lifecycle, researchItemId },
    });
    return NextResponse.json({ data: { item }, meta: { requestId } });
  } catch (e) {
    if (e instanceof ContentServiceError) {
      const status = e.code === "NOT_FOUND" ? 404 : 400;
      await writeAudit({
        actorType: "user", actorId: gate.ctx.user?.id ?? null,
        action: "content.item.create", resource: "content_items",
        result: "denied", requestId, metadata: { code: e.code, detail: e.message },
      });
      return NextResponse.json({ errors: [{ code: e.code, detail: e.message }] }, { status });
    }
    throw e;
  }
}
