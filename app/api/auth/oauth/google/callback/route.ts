import { NextResponse } from "next/server";
import { query } from "@/lib/db";
import {
  exchangeGoogleCode,
  fetchGoogleProfile,
  GoogleAuthError,
  nonceMatches,
  OAUTH_NEXT_COOKIE,
  OAUTH_NONCE_COOKIE,
  OAUTH_VERIFIER_COOKIE,
  clearOauthCookieHeaders,
  isOwnerAllowlisted,
  safeNextPath,
  verifySigninState,
} from "@/lib/auth/google";
import { createSession, cookieHeaderFor, parseCookies } from "@/lib/auth/sessions";
import { rateLimit, clientIp } from "@/lib/security/ratelimit";
import { writeAudit, requestIdFor } from "@/lib/audit";

export const runtime = "nodejs";

/**
 * GET /api/auth/oauth/google/callback — second leg of Sign-in with Google.
 * The provider redirect lands here with ?code=...&state=... (or ?error=...).
 *
 * Verification order (fail-closed):
 *   1. state MAC + TTL (constant time)        → else /login?error=oauth_state
 *   2. nonce double-submit (cookie ≡ state)   → else /login?error=oauth_state
 *   3. code exchange (PKCE verifier cookie)   → else oauth_exchange / provider_unreachable
 *   4. profile: email_verified must be true   → else email_unverified
 *
 * Identity resolution:
 *   - Existing user, active     → link provider_id (never re-link a different
 *     sub onto an already-linked account), create session, 302 → next path.
 *   - Existing user, disabled   → account_disabled (session never created).
 *   - No user + OWNER_EMAILS    → auto-provision the first/allowlisted owner
 *     (role owner, provider=google), audited with provisioned:true.
 *   - No user, not allowlisted  → not_authorized; nothing is created.
 *
 * Every branch is audited; codes/tokens/secret never enter audit metadata.
 * The oauth round-trip cookies are cleared on all exits.
 */
export async function GET(req: Request) {
  const requestId = requestIdFor(req);
  const url = new URL(req.url);
  const origin = url.origin;
  const ip = clientIp(req);

  const done = async (status: 302, path: string, extra: { sessionToken?: string } = {}) => {
    const res = NextResponse.redirect(`${origin}${path}`, status);
    for (const h of clearOauthCookieHeaders()) res.headers.append("Set-Cookie", h);
    if (extra.sessionToken) res.headers.append("Set-Cookie", cookieHeaderFor(extra.sessionToken));
    return res;
  };

  const rl = await rateLimit(`oauth-cb:${ip}`, 20, 5 * 60 * 1000);
  if (!rl.allowed) return done(302, "/login?error=rate_limited");

  // Provider-returned errors (user cancelled consent, etc.)
  const providerError = url.searchParams.get("error");
  if (providerError) {
    await writeAudit({ actorType: "anonymous", action: "auth.oauth.callback", resource: "sessions", result: "denied", requestId, ip, metadata: { provider: "google", code: providerError.slice(0, 40) } });
    return done(302, "/login?error=oauth_cancelled");
  }

  const code = url.searchParams.get("code");
  const state = url.searchParams.get("state");
  const cookies = parseCookies(req);

  try {
    // 1) state MAC + TTL
    const stateNonce = verifySigninState(state);
    // 2) double-submit nonce
    if (!nonceMatches(stateNonce, cookies[OAUTH_NONCE_COOKIE])) {
      throw new GoogleAuthError("OAUTH_STATE", "nonce cookie mismatch");
    }
    if (!code) throw new GoogleAuthError("OAUTH_STATE", "missing code");

    // 3) exchange (PKCE verifier from cookie)
    const verifier = cookies[OAUTH_VERIFIER_COOKIE] ?? "";
    if (!verifier) throw new GoogleAuthError("OAUTH_STATE", "missing PKCE verifier");
    const { accessToken } = await exchangeGoogleCode({
      code,
      redirectUri: `${origin}/api/auth/oauth/google/callback`,
      verifier,
    });

    // 4) profile
    const profile = await fetchGoogleProfile({ accessToken });
    if (!profile.emailVerified) {
      await writeAudit({ actorType: "anonymous", actorLabel: profile.email, action: "auth.oauth.callback", resource: "sessions", result: "denied", requestId, ip, metadata: { provider: "google", code: "email_unverified" } });
      return done(302, "/login?error=email_unverified");
    }

    const users = await query<{
      id: number; email: string; display_name: string | null; status: string;
      provider: string; provider_id: string | null;
    }>(
      "SELECT id, email, display_name, status, provider, provider_id FROM users WHERE email = $1",
      [profile.email]
    );

    const next = safeNextPath(cookies[OAUTH_NEXT_COOKIE]);

    if (users.length > 0) {
      const user = users[0];
      if (user.status !== "active") {
        await writeAudit({ actorType: "anonymous", actorId: user.id, actorLabel: user.email, action: "auth.oauth.callback", resource: "sessions", result: "denied", requestId, ip, metadata: { provider: "google", code: "account_disabled" } });
        return done(302, "/login?error=account_disabled");
      }
      if (user.provider_id && user.provider_id !== profile.sub) {
        // The stored Google identity for this email is a different account —
        // never silently re-link. (Possible only after Google email
        // reassignment; keep it strict, require ops intervention.)
        await writeAudit({ actorType: "anonymous", actorId: user.id, actorLabel: user.email, action: "auth.oauth.callback", resource: "sessions", result: "denied", requestId, ip, metadata: { provider: "google", code: "identity_conflict" } });
        return done(302, "/login?error=identity_conflict");
      }
      if (!user.provider_id) {
        await query(
          "UPDATE users SET provider = 'google', provider_id = $2, updated_at = now() WHERE id = $1",
          [user.id, profile.sub]
        );
      }
      const { token } = await createSession(user.id, { ip, userAgent: req.headers.get("user-agent") });
      await writeAudit({ actorType: "user", actorId: user.id, actorLabel: user.email, action: "auth.oauth.callback", resource: "sessions", result: "success", requestId, ip, metadata: { provider: "google", linked: !user.provider_id } });
      return done(302, next, { sessionToken: token });
    }

    // No user — auto-provision ONLY for the exact owner allowlist.
    if (!isOwnerAllowlisted(profile.email)) {
      await writeAudit({ actorType: "anonymous", actorLabel: profile.email, action: "auth.oauth.callback", resource: "sessions", result: "denied", requestId, ip, metadata: { provider: "google", code: "not_authorized" } });
      return done(302, "/login?error=not_authorized");
    }

    const ownerRole = await query<{ id: number }>("SELECT id FROM roles WHERE key = 'owner' AND is_active");
    if (ownerRole.length === 0) {
      return done(302, "/login?error=oauth_error");
    }
    const [created] = await query<{ id: number }>(
      `INSERT INTO users (email, display_name, password_hash, status, provider, provider_id)
       VALUES ($1, $2, '', 'active', 'google', $3) RETURNING id`,
      [profile.email, profile.name, profile.sub]
    );
    await query("INSERT INTO user_roles (user_id, role_id) VALUES ($1, $2)", [created.id, ownerRole[0].id]);
    const { token } = await createSession(created.id, { ip, userAgent: req.headers.get("user-agent") });
    await writeAudit({ actorType: "user", actorId: created.id, actorLabel: profile.email, action: "auth.oauth.callback", resource: "sessions", result: "success", requestId, ip, metadata: { provider: "google", provisioned: true, role: "owner" } });
    return done(302, next, { sessionToken: token });
  } catch (e) {
    const code = e instanceof GoogleAuthError ? e.code : "OAUTH_CALLBACK_FAILED";
    await writeAudit({ actorType: "anonymous", action: "auth.oauth.callback", resource: "sessions", result: "failure", requestId, ip, metadata: { provider: "google", code } });
    const loginError =
      code === "OAUTH_STATE" ? "oauth_state"
      : code === "OAUTH_EXCHANGE_FAILED" ? "oauth_exchange"
      : code === "OAUTH_PROVIDER_UNREACHABLE" ? "provider_unreachable"
      : "oauth_error";
    return done(302, `/login?error=${loginError}`);
  }
}
