import { NextResponse } from "next/server";
import { requireAnyPermission } from "@/lib/auth/guards";
import {
  listAccounts,
  listCampaigns,
  listPosts,
  calendar,
  metricsSummary,
} from "@/lib/social/service";
import type { SocialPlatform, SocialPostStatus } from "@/lib/social/types";
import { isFlagEnabled } from "@/lib/settings";
import { requestIdFor } from "@/lib/audit";
import { oauthConfigured } from "@/lib/social/oauth";

export const runtime = "nodejs";

/**
 * /api/admin/social (Phase 10 — social workforce control surface).
 *  GET — social.manage / audit.read: accounts (sans credentials — the
 *  service NEVER selects secrets), campaigns, posts, a 14-day calendar
 *  window (time semantics, §466), metrics summary, flag state and per-
 *  platform OAuth configuration status (SEC-L5 surface).
 */
export async function GET(req: Request) {
  const requestId = requestIdFor(req);
  const gate = await requireAnyPermission(req, ["social.manage", "audit.read"]);
  if (!gate.ok) return gate.response;

  const url = new URL(req.url);
  const buRaw = url.searchParams.get("businessUnitId");
  const businessUnitId = buRaw && /^\d+$/.test(buRaw) ? Number(buRaw) : null;

  const statusRaw = url.searchParams.get("postStatus");
  const postStatus = (["draft", "scheduled", "publishing", "posted", "failed", "cancelled"] as const).includes(statusRaw as never)
    ? (statusRaw as SocialPostStatus)
    : null;

  const now = Date.now();
  const from = new Date(now - 24 * 3600 * 1000); // yesterday …
  const to = new Date(now + 14 * 24 * 3600 * 1000); // … +14 days

  const [accounts, campaigns, posts, cal, metrics, socialFlag, igTiktokFlag, oauthStatus] =
    await Promise.all([
      listAccounts({ businessUnitId }),
      listCampaigns({ businessUnitId }),
      listPosts({ businessUnitId, status: postStatus, limit: 100 }),
      calendar({ businessUnitId, from, to }),
      metricsSummary({ businessUnitId, limit: 20 }),
      isFlagEnabled("social", false),
      isFlagEnabled("social_publish_ig_tiktok", false),
      Promise.resolve(
        Object.fromEntries(
          (["linkedin", "x", "instagram", "tiktok"] as SocialPlatform[]).map((p) => [p, oauthConfigured(p)])
        )
      ),
    ]);

  return NextResponse.json({
    data: {
      accounts,
      campaigns,
      posts,
      calendar: cal,
      metrics,
      flags: { social: socialFlag, social_publish_ig_tiktok: igTiktokFlag },
      oauthConfigured: oauthStatus,
    },
    meta: { requestId },
  });
}
