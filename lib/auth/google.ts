/**
 * Sign-in with Google (Access & Identity Overhaul — owner directive:
 * "the OAuth needs to be completely changed and optimized").
 *
 * A dedicated FIRST-PARTY identity flow, distinct from the social-platform
 * OAuth lifecycle (lib/social/oauth.ts, SEC-L5 — connecting LinkedIn/X/
 * Instagram/TikTok posting accounts). This module is about signing the
 * OPERATOR into the Command Center:
 *
 *   /login ──► GET /api/auth/oauth/google/start ──► accounts.google.com
   (Google) ──► GET /api/auth/oauth/google/callback ──► session cookie
 *
 * Design (fail-closed by construction):
 * - Authorization Code flow with PKCE (S256) — verifier never leaves the
 *   server except as an httpOnly, 10-minute cookie bound to this round trip.
 * - CSRF: HMAC-SHA256-signed state (nonce + expiry, 10-min TTL) verified in
 *   constant time AND double-submitted via an httpOnly nonce cookie.
 * - Identity resolution is fail-closed:
 *     1. Google must report email_verified — otherwise deny.
 *     2. Existing user with that email  → link (provider/provider_id) and
 *        create a session (password hash untouched; both methods keep working).
 *     3. No user                        → auto-provision ONLY when the email
 *        is listed in OWNER_EMAILS (exact, case-insensitive); otherwise deny.
 * - When GOOGLE_CLIENT_ID/GOOGLE_CLIENT_SECRET are absent the provider is
 *   "not configured": /api/auth/providers hides the button and the start leg
 *   bounces back to /login with a friendly error. Nothing crashes.
 *
 * Secrets: client secret, codes and tokens are never logged and never
 * audited (audit carries codes + emails only, never tokens). The state MAC
 * key derives from GOOGLE_OAUTH_STATE_SECRET (32-byte hex) or, like the
 * social flow, from CHANNEL_ENC_KEY.
 */
import crypto from "node:crypto";

/** Minimal env view (lets tests pass partial env objects). */
export type EnvLike = Record<string, string | undefined>;

export class GoogleAuthError extends Error {
  constructor(
    public code:
      | "CONFIG_MISSING"
      | "OAUTH_STATE"
      | "OAUTH_EXCHANGE_FAILED"
      | "OAUTH_PROVIDER_UNREACHABLE"
      | "EMAIL_UNVERIFIED"
      | "EMAIL_NOT_ALLOWED"
      | "ACCOUNT_DISABLED",
    message: string
  ) {
    super(message);
    this.name = "GoogleAuthError";
  }
}

export const GOOGLE_AUTHORIZE_URL = "https://accounts.google.com/o/oauth2/v2/auth";
export const GOOGLE_TOKEN_URL = "https://oauth2.googleapis.com/token";
export const GOOGLE_USERINFO_URL = "https://openidconnect.googleapis.com/v1/userinfo";
export const GOOGLE_SCOPES = "openid email profile";

export function googleOAuthConfigured(env: EnvLike = process.env): boolean {
  return Boolean(env.GOOGLE_CLIENT_ID && env.GOOGLE_CLIENT_SECRET);
}

export function ownerAllowlist(env: EnvLike = process.env): string[] {
  return (env.OWNER_EMAILS ?? "")
    .split(",")
    .map((e) => e.trim().toLowerCase())
    .filter((e) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e));
}

export function isOwnerAllowlisted(email: string, env: EnvLike = process.env): boolean {
  return ownerAllowlist(env).includes(email.trim().toLowerCase());
}

/* ------------------------------------------------------------------ */
/* State signing (CSRF, 10-minute TTL) + PKCE                          */
/* ------------------------------------------------------------------ */

function stateKey(env: EnvLike): Buffer {
  const explicit = env.GOOGLE_OAUTH_STATE_SECRET;
  if (explicit) {
    const key = Buffer.from(explicit, "hex");
    if (key.length === 32) return key;
  }
  // Derive from the channel encryption key (always present in production).
  const base = env.CHANNEL_ENC_KEY ?? "";
  return crypto.createHash("sha256").update(`signin-state:${base}`).digest();
}

export interface SignedState {
  state: string;
  nonce: string;
  expiresAt: number;
}

export function buildSigninState(env: EnvLike = process.env): SignedState {
  const nonce = crypto.randomBytes(16).toString("hex");
  const expiresAt = Date.now() + 10 * 60 * 1000; // 10-minute TTL
  const payload = `signin:${nonce}:${expiresAt}`;
  const mac = crypto.createHmac("sha256", stateKey(env)).update(payload).digest("hex");
  return { state: `${payload}:${mac}`, nonce, expiresAt };
}

/** Constant-time verification; throws OAUTH_STATE on any tamper/expiry. Returns the nonce. */
export function verifySigninState(state: string | null | undefined, env: EnvLike = process.env): string {
  if (!state) throw new GoogleAuthError("OAUTH_STATE", "missing state");
  const parts = state.split(":");
  if (parts.length !== 4) throw new GoogleAuthError("OAUTH_STATE", "malformed signin state");
  const [kind, nonce, expRaw, mac] = parts;
  if (kind !== "signin") throw new GoogleAuthError("OAUTH_STATE", "unknown state kind");
  const payload = `${kind}:${nonce}:${expRaw}`;
  const expected = crypto.createHmac("sha256", stateKey(env)).update(payload).digest("hex");
  const a = Buffer.from(mac, "hex");
  const b = Buffer.from(expected, "hex");
  if (a.length !== b.length || a.length === 0 || !crypto.timingSafeEqual(a, b)) {
    throw new GoogleAuthError("OAUTH_STATE", "signin state MAC mismatch");
  }
  if (Number(expRaw) < Date.now()) throw new GoogleAuthError("OAUTH_STATE", "signin state expired");
  if (!/^[0-9a-f]{32}$/.test(nonce)) throw new GoogleAuthError("OAUTH_STATE", "malformed nonce");
  return nonce;
}

/** Timing-safe double-submit check: state nonce must equal the cookie nonce. */
export function nonceMatches(stateNonce: string, cookieNonce: string | null | undefined): boolean {
  if (!cookieNonce) return false;
  const a = Buffer.from(stateNonce);
  const b = Buffer.from(cookieNonce);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

export function pkcePair(): { verifier: string; challenge: string } {
  const verifier = crypto.randomBytes(32).toString("base64url");
  const challenge = crypto.createHash("sha256").update(verifier).digest("base64url");
  return { verifier, challenge };
}

/* ------------------------------------------------------------------ */
/* Authorize URL                                                       */
/* ------------------------------------------------------------------ */

export interface AuthorizeRedirect {
  authorizeUrl: string;
  state: string;
  nonce: string;
  verifier: string;
  expiresAt: number;
}

export function buildGoogleAuthorizeUrl(opts: { redirectUri: string; env?: EnvLike }): AuthorizeRedirect {
  const env = opts.env ?? process.env;
  const clientId = env.GOOGLE_CLIENT_ID;
  const clientSecret = env.GOOGLE_CLIENT_SECRET;
  if (!clientId || !clientSecret) {
    throw new GoogleAuthError("CONFIG_MISSING", "set GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET to enable Sign-in with Google");
  }
  const signed = buildSigninState(env);
  const pkce = pkcePair();
  const url = new URL(GOOGLE_AUTHORIZE_URL);
  url.searchParams.set("client_id", clientId);
  url.searchParams.set("redirect_uri", opts.redirectUri);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("scope", GOOGLE_SCOPES);
  url.searchParams.set("state", signed.state);
  url.searchParams.set("code_challenge", pkce.challenge);
  url.searchParams.set("code_challenge_method", "S256");
  // Let the operator pick among their Google accounts explicitly.
  url.searchParams.set("prompt", "select_account");
  return { authorizeUrl: url.toString(), state: signed.state, nonce: signed.nonce, verifier: pkce.verifier, expiresAt: signed.expiresAt };
}

/* ------------------------------------------------------------------ */
/* Token exchange + userinfo                                           */
/* ------------------------------------------------------------------ */

export interface GoogleProfile {
  sub: string;
  email: string;
  emailVerified: boolean;
  name: string | null;
}

interface TokenResponse {
  access_token?: string;
  id_token?: string;
  token_type?: string;
  expires_in?: number;
  error?: string;
  error_description?: string;
}

/** Injectable fetch for deterministic tests (defaults to global fetch). */
let fetchImpl: typeof fetch = (...args) => fetch(...args);
export function setGoogleFetchImpl(f: typeof fetch): void {
  fetchImpl = f;
}

export async function exchangeGoogleCode(opts: {
  code: string;
  redirectUri: string;
  verifier: string;
  env?: EnvLike;
}): Promise<{ accessToken: string }> {
  const env = opts.env ?? process.env;
  const clientId = env.GOOGLE_CLIENT_ID;
  const clientSecret = env.GOOGLE_CLIENT_SECRET;
  if (!clientId || !clientSecret) {
    throw new GoogleAuthError("CONFIG_MISSING", "Google OAuth client credentials absent");
  }
  let res: Response;
  try {
    res = await fetchImpl(GOOGLE_TOKEN_URL, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        code: opts.code,
        client_id: clientId,
        client_secret: clientSecret,
        redirect_uri: opts.redirectUri,
        grant_type: "authorization_code",
        code_verifier: opts.verifier,
      }).toString(),
    });
  } catch (e) {
    throw new GoogleAuthError("OAUTH_PROVIDER_UNREACHABLE", `token endpoint unreachable: ${String(e).slice(0, 120)}`);
  }
  const json = (await res.json().catch(() => ({}))) as TokenResponse;
  if (!res.ok || !json.access_token) {
    // Provider error detail is CODED, never echoed raw (no leakage).
    const reason = json.error ?? `http_${res.status}`;
    throw new GoogleAuthError("OAUTH_EXCHANGE_FAILED", `code exchange failed: ${reason}`);
  }
  return { accessToken: json.access_token };
}

export async function fetchGoogleProfile(opts: { accessToken: string }): Promise<GoogleProfile> {
  let res: Response;
  try {
    res = await fetchImpl(GOOGLE_USERINFO_URL, {
      headers: { Authorization: `Bearer ${opts.accessToken}` },
    });
  } catch (e) {
    throw new GoogleAuthError("OAUTH_PROVIDER_UNREACHABLE", `userinfo endpoint unreachable: ${String(e).slice(0, 120)}`);
  }
  const json = (await res.json().catch(() => ({}))) as {
    sub?: string; email?: string; email_verified?: boolean; name?: string;
  };
  if (!res.ok || !json.sub || !json.email) {
    throw new GoogleAuthError("OAUTH_EXCHANGE_FAILED", `userinfo failed: http_${res.status}`);
  }
  return {
    sub: json.sub,
    email: json.email.trim().toLowerCase(),
    emailVerified: json.email_verified === true,
    name: json.name ?? null,
  };
}

/* ------------------------------------------------------------------ */
/* Cookie plumbing for the round trip                                  */
/* ------------------------------------------------------------------ */

export const OAUTH_NONCE_COOKIE = "agentos_oauth_n";
export const OAUTH_VERIFIER_COOKIE = "agentos_oauth_v";
export const OAUTH_NEXT_COOKIE = "agentos_oauth_next";
export const OAUTH_COOKIE_MAX_AGE = 600; // 10 minutes — matches the state TTL

export function oauthCookieHeaderFor(name: string, value: string): string {
  return `${name}=${encodeURIComponent(value)}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${OAUTH_COOKIE_MAX_AGE}`;
}

export function clearOauthCookieHeaders(): string[] {
  return [OAUTH_NONCE_COOKIE, OAUTH_VERIFIER_COOKIE, OAUTH_NEXT_COOKIE].map(
    (name) => `${name}=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0`
  );
}

/** Same-origin relative path only (no protocol-relative "//", no schemes, no backslash tricks). */
export function safeNextPath(raw: string | null | undefined): string {
  if (raw && /^\/(?!\/)/.test(raw) && !raw.includes("://") && !raw.includes("\\") && raw.length <= 200) return raw;
  return "/dashboard";
}
