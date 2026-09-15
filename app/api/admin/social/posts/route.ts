import { NextResponse } from "next/server";
import { requireAnyPermission, requirePermission } from "@/lib/auth/guards";
import {
  createPosts,
  listPosts,
  type ContentItemRef,
} from "@/lib/social/service";
import { SocialServiceError } from "@/lib/social/types";
import { SOCIAL_PLATFORMS, isSocialPlatform, type SocialPlatform } from "@/lib/social/types";
import { getItem } from "@/lib/content/service";
import { ai } from "@/lib/ai";
import { loadSocialPrompt, makeVariantGenerator } from "@/lib/social/pipeline";
import { requestIdFor, writeAudit } from "@/lib/audit";
import { query } from "@/lib/db";

export const runtime = "nodejs";

/**
 * /api/admin/social/posts (Phase 10).
 *  GET  — social.manage / audit.read: posts (filterable).
 *  POST — social.manage: schedule posts for an APPROVED content item
 *         {businessUnitId, contentItemId, platforms[], scheduledAt,
 *         campaignId?, bodyByPlatform?}. The structural approval gate
 *         (§466) is enforced by the service: non-approved items are
 *         rejected 409 CONTENT_NOT_APPROVED. Variant bodies come from the
 *         social_media agent via the AI gateway (purpose="social") with a
 *         deterministic fallback; explicit bodyByPlatform entries skip the
 *         LLM. Audited.
 */
export async function GET(req: Request) {
  const requestId = requestIdFor(req);
  const gate = await requireAnyPermission(req, ["social.manage", "audit.read"]);
  if (!gate.ok) return gate.response;
  const url = new URL(req.url);
  const buRaw = url.searchParams.get("businessUnitId");
  const businessUnitId = buRaw && /^\d+$/.test(buRaw) ? Number(buRaw) : null;
  const statusRaw = url.searchParams.get("status");
  const posts = await listPosts({
    businessUnitId,
    status: (["draft", "scheduled", "publishing", "posted", "failed", "cancelled"] as const).includes(statusRaw as never)
      ? (statusRaw as never)
      : null,
    limit: 200,
  });
  return NextResponse.json({ data: { posts }, meta: { requestId } });
}

export async function POST(req: Request) {
  const requestId = requestIdFor(req);
  const gate = await requirePermission(req, "social.manage");
  if (!gate.ok) return gate.response;

  let body: Record<string, unknown>;
  try {
    body = (await req.json()) as Record<string, unknown>;
  } catch {
    return NextResponse.json({ errors: [{ code: "INVALID_JSON" }] }, { status: 400 });
  }

  const businessUnitId = Number(body.businessUnitId);
  const contentItemId = Number(body.contentItemId);
  const scheduledAt = typeof body.scheduledAt === "string" ? body.scheduledAt : null;
  const campaignId = Number.isInteger(body.campaignId as number) ? (body.campaignId as number) : null;

  if (!Number.isInteger(businessUnitId) || businessUnitId <= 0) {
    return NextResponse.json({ errors: [{ code: "BUSINESS_UNIT_ID_REQUIRED" }] }, { status: 400 });
  }
  if (!Number.isInteger(contentItemId) || contentItemId <= 0) {
    return NextResponse.json({ errors: [{ code: "CONTENT_ITEM_ID_REQUIRED" }] }, { status: 400 });
  }
  const platforms = Array.isArray(body.platforms)
    ? body.platforms.map(String).filter(isSocialPlatform)
    : [];
  if (platforms.length === 0) {
    return NextResponse.json(
      { errors: [{ code: "PLATFORMS_REQUIRED", detail: `platforms must be a non-empty subset of ${SOCIAL_PLATFORMS.join(", ")}` }] },
      { status: 400 }
    );
  }
  if (!scheduledAt) {
    return NextResponse.json({ errors: [{ code: "SCHEDULED_AT_REQUIRED" }] }, { status: 400 });
  }

  // Load the approved item's current version body for variant generation.
  const item = await getItem(contentItemId);
  if (!item) {
    return NextResponse.json({ errors: [{ code: "ITEM_NOT_FOUND" }] }, { status: 404 });
  }
  let versionBody = "";
  if (item.currentVersionId != null) {
    const current = await query<{ body: string }>(
      "SELECT body FROM content_versions WHERE content_item_id = $1 AND id = $2",
      [contentItemId, item.currentVersionId]
    );
    versionBody = current[0]?.body ?? "";
  }
  const itemRef: ContentItemRef = {
    id: item.id,
    businessUnitId: item.businessUnitId,
    lifecycle: item.lifecycle,
    title: item.title,
    currentVersionId: item.currentVersionId,
  };

  const overrides: Partial<Record<SocialPlatform, string>> = {};
  if (body.bodyByPlatform && typeof body.bodyByPlatform === "object") {
    for (const [k, v] of Object.entries(body.bodyByPlatform as Record<string, unknown>)) {
      if (isSocialPlatform(k) && typeof v === "string") overrides[k] = v;
    }
  }

  try {
    const prompt = await loadSocialPrompt();
    const generateBody = makeVariantGenerator(ai, prompt);
    const result = await createPosts({
      businessUnitId,
      contentItemId,
      platforms,
      scheduledAt,
      campaignId,
      bodyByPlatform: overrides,
      generateBody: (platform, ref) =>
        generateBody(platform, {
          id: ref.id,
          title: ref.title,
          // Version body carries the approved content; title anchors the hook.
          body: versionBody || ref.title || "",
          metadata: {},
        }),
      userId: gate.ctx.user?.id ?? null,
    });

    await writeAudit({
      actorType: "user",
      actorId: gate.ctx.user?.id ?? null,
      action: "social.posts.create",
      resource: "social_posts",
      resourceId: result.posts[0]?.id ?? null,
      result: "success",
      requestId,
      metadata: {
        businessUnitId,
        contentItemId,
        platforms,
        scheduledAt,
        created: result.posts.map((p) => p.id),
        skipped: result.skipped,
      },
    });
    return NextResponse.json({ data: result, meta: { requestId } });
  } catch (e) {
    const code = e instanceof SocialServiceError ? e.code : "POSTS_CREATE_FAILED";
    const status =
      code === "CONTENT_NOT_APPROVED" ? 409 :
      code === "SOCIAL_ACCOUNT_MISSING" ? 409 :
      code === "BU_MISMATCH" ? 409 :
      code === "ITEM_NOT_FOUND" ? 404 :
      code === "BAD_SCHEDULE" || code === "BAD_PLATFORMS" || code === "BAD_PLATFORM" ? 400 : 500;
    await writeAudit({
      actorType: "user",
      actorId: gate.ctx.user?.id ?? null,
      action: "social.posts.create",
      resource: "social_posts",
      result: "failure",
      requestId,
      metadata: { businessUnitId, contentItemId, platforms, code },
    });
    return NextResponse.json({ errors: [{ code, detail: e instanceof Error ? e.message : undefined }] }, { status });
  }
}
