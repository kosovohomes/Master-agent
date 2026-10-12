import { NextResponse } from "next/server";
import {
  buildGoogleAuthorizeUrl,
  GoogleAuthError,
  OAUTH_NONCE_COOKIE,
  OAUTH_NEXT_COOKIE,
  OAUTH_VERIFIER_COOKIE,
  oauthCookieHeaderFor,
  safeNextPath,
} from "@/lib/auth/google";
import { rateLimit, clientIp } from "@/lib/security/ratelimit";
import { writeAudit, requestIdFor } from "@/lib/audit";

export const runtime = "nodejs";

/**
 * GET /api/auth/oauth/google/start — first leg of Sign-in with Google.
 * Redirects (302) to the Google consent screen with a HMAC-signed state and
 * PKCE challenge; the matching nonce + code verifier ride back in httpOnly,
 * 10-minute cookies (double-submit CSRF binding).
 *
 * Redirect URI handed to Google is ${origin}/api/auth/oauth/google/callback
 * — must be registered verbatim in the Google Cloud OAuth client.
 *
 * Unconfigured → 302 /login?error=oauth_unconfigured (audited). Rate limited
 * per IP (10 / 5 min). No secrets in audit metadata.
 */
export async function GET(req: Request) {
  const requestId = requestIdFor(req);
  const origin = new URL(req.url).origin;

  const rl = await rateLimit(`oauth-start:${clientIp(req)}`, 10, 5 * 60 * 1000);
  if (!rl.allowed) {
    return redirectToLogin(origin, "rate_limited");
  }

  const next = safeNextPath(new URL(req.url).searchParams.get("next"));
  try {
    const start = buildGoogleAuthorizeUrl({
      redirectUri: `${origin}/api/auth/oauth/google/callback`,
    });
    await writeAudit({
      actorType: "anonymous",
      action: "auth.oauth.start",
      resource: "sessions",
      result: "success",
      requestId,
      ip: clientIp(req),
      metadata: { provider: "google" },
    });
    // 302 (not 307): the browser must repeat this as a plain GET navigation.
    const res = NextResponse.redirect(start.authorizeUrl, 302);
    res.headers.append("Set-Cookie", oauthCookieHeaderFor(OAUTH_NONCE_COOKIE, start.nonce));
    res.headers.append("Set-Cookie", oauthCookieHeaderFor(OAUTH_VERIFIER_COOKIE, start.verifier));
    res.headers.append("Set-Cookie", oauthCookieHeaderFor(OAUTH_NEXT_COOKIE, next));
    return res;
  } catch (e) {
    const code = e instanceof GoogleAuthError ? e.code : "OAUTH_START_FAILED";
    await writeAudit({
      actorType: "anonymous",
      action: "auth.oauth.start",
      resource: "sessions",
      result: "failure",
      requestId,
      ip: clientIp(req),
      metadata: { provider: "google", code },
    });
    return redirectToLogin(origin, code === "CONFIG_MISSING" ? "oauth_unconfigured" : "oauth_error");
  }
}

function redirectToLogin(origin: string, error: string): NextResponse {
  return NextResponse.redirect(`${origin}/login?error=${encodeURIComponent(error)}`, 302);
}
