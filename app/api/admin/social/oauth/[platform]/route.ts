import { NextResponse } from "next/server";
import { requirePermission } from "@/lib/auth/guards";
import { connectAccount } from "@/lib/social/service";
import { SocialServiceError } from "@/lib/social/types";
import type { SocialPlatform } from "@/lib/social/types";
import {
  buildAuthorizeUrl,
  exchangeCode,
  oauthConfigured,
  verifyState,
} from "@/lib/social/oauth";
import { writeAudit, requestIdFor } from "@/lib/audit";

export const runtime = "nodejs";

const PLATFORMS: SocialPlatform[] = ["linkedin", "x", "instagram", "tiktok"];

/**
 * /api/admin/social/oauth/[platform] (Phase 10 — SEC-L5 OAuth lifecycle).
 *
 *  GET ?action=start&businessUnitId=N&redirectUri=...
 *      — social.manage: build the provider authorize URL (HMAC-signed,
 *        10-min-TTL state with CSRF protection; PKCE for x/tiktok).
 *        CONFIG_MISSING (409) when platform app credentials are absent —
 *        the operator falls back to manual connect.
 *
 *  GET ?code=...&state=...
 *      — the provider redirect lands here. state is verified (MAC +
 *        expiry), the code exchanged, and the account connected
 *        (source="oauth", credentials encrypted via the SEC-L2 envelope).
 *        Audited; secrets never logged.
 */
export async function GET(req: Request, ctx: { params: Promise<{ platform: string }> }) {
  const requestId = requestIdFor(req);
  const { platform: platformRaw } = await ctx.params;
  const platform = platformRaw as SocialPlatform;
  if (!PLATFORMS.includes(platform)) {
    return NextResponse.json({ errors: [{ code: "INVALID_PLATFORM" }] }, { status: 400 });
  }

  const url = new URL(req.url);
  const code = url.searchParams.get("code");
  const state = url.searchParams.get("state");

  /* ---------------- callback leg (provider redirect) ---------------- */
  if (code && state) {
    try {
      const verified = verifyState(state);
      if (verified.platform !== platform) {
        throw new SocialServiceError("OAUTH_STATE", "state platform mismatch");
      }
      const redirectUri = `${url.origin}${url.pathname}`;
      const tokens = await exchangeCode(platform, { code, redirectUri });
      const account = await connectAccount({
        businessUnitId: verified.businessUnitId,
        platform,
        token: tokens.accessToken,
        accountRef: tokens.accountRefHint,
        source: "oauth",
        scopes: tokens.scope,
        tokenExpiresAt: tokens.expiresAt,
      });
      await writeAudit({
        actorType: "user",
        action: "social.oauth.callback",
        resource: "social_accounts",
        resourceId: account.id,
        result: "success",
        requestId,
        metadata: { platform, businessUnitId: verified.businessUnitId, source: "oauth" },
      });
      return NextResponse.json({
        data: { connected: true, account, refreshTokenStored: Boolean(tokens.refreshToken) },
        meta: { requestId },
      });
    } catch (e) {
      const code2 = e instanceof SocialServiceError ? e.code : "OAUTH_CALLBACK_FAILED";
      const status = code2 === "OAUTH_STATE" || code2 === "CONFIG_MISSING" ? 400 : 502;
      await writeAudit({
        actorType: "anonymous",
        action: "social.oauth.callback",
        resource: "social_accounts",
        result: "failure",
        requestId,
        metadata: { platform, code: code2 },
      });
      return NextResponse.json({ errors: [{ code: code2 }] }, { status });
    }
  }

  /* ---------------- start leg (operator-driven) ---------------- */
  const gate = await requirePermission(req, "social.manage");
  if (!gate.ok) return gate.response;

  const action = url.searchParams.get("action") ?? "start";
  if (action !== "start") {
    return NextResponse.json({ errors: [{ code: "INVALID_ACTION" }] }, { status: 400 });
  }
  const businessUnitId = Number(url.searchParams.get("businessUnitId"));
  if (!Number.isInteger(businessUnitId) || businessUnitId <= 0) {
    return NextResponse.json({ errors: [{ code: "BUSINESS_UNIT_ID_REQUIRED" }] }, { status: 400 });
  }

  try {
    const start = buildAuthorizeUrl(platform, {
      businessUnitId,
      redirectUri: `${url.origin}${url.pathname}`,
    });
    await writeAudit({
      actorType: "user",
      actorId: gate.ctx.user?.id ?? null,
      action: "social.oauth.start",
      resource: "social_accounts",
      result: "success",
      requestId,
      metadata: { platform, businessUnitId },
    });
    // The verifier is returned to the caller (kept client-side for the
    // callback round; never persisted server-side).
    return NextResponse.json({
      data: { authorizeUrl: start.authorizeUrl, expiresAt: start.expiresAt, pkce: Boolean(start.pkceVerifier) },
      meta: { requestId },
    });
  } catch (e) {
    const code2 = e instanceof SocialServiceError ? e.code : "OAUTH_START_FAILED";
    const status = code2 === "CONFIG_MISSING" ? 409 : 500;
    return NextResponse.json(
      { errors: [{ code: code2, detail: e instanceof Error ? e.message : undefined, oauthConfigured: oauthConfigured(platform) }] },
      { status }
    );
  }
}
