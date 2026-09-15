/**
 * Phase 10 — OAuth account lifecycle (SEC-L5).
 *
 * Replaces pasted-token-only credential handling for the social workforce
 * with the full lifecycle: authorize URL construction (CSRF-protected with
 * HMAC-signed, TTL-bounded state), code exchange, refresh, expiry tracking
 * and status transitions (connected → expired → revoked/error). Manual
 * token connect remains a first-class path (source="manual") — many
 * operators start with a PAT; the lifecycle machinery does not change.
 *
 * Provider configuration is env-driven and DEGRADES CLEANLY: when client
 * credentials are absent (today's production), buildAuthorizeUrl throws
 * CONFIG_MISSING and the /social surface reports the platform as "OAuth not
 * configured — connect manually". Nothing crashes; the acceptance path is
 * manual connect + lifecycle transitions, both deterministic.
 *
 * Secrets: exchanged tokens are returned to the caller (service layer
 * encrypts via the SEC-L2 envelope) — nothing is logged here. State is
 * HMAC-SHA256 over a platform:BU:nonce:exp tuple with a key derived from
 * CHANNEL_ENC_KEY (or SOCIAL_OAUTH_STATE_SECRET when set), compared in
 * constant time.
 */
import crypto from "node:crypto";
import { SocialServiceError, type SocialPlatform } from "./types";

export interface OAuthProviderConfig {
  authorizeUrl: string;
  tokenUrl: string;
  /** Env var names, resolved at call time (never baked into config). */
  clientIdEnv: string;
  clientSecretEnv: string;
  scopes: string[];
  /** PKCE is mandatory for X (OAuth 2.0 + PKCE); others optional. */
  pkce: boolean;
  useBodyAuth: boolean; // token auth style: body (x, tiktok) vs Basic header (some)
}

export const OAUTH_PROVIDERS: Record<SocialPlatform, OAuthProviderConfig> = {
  linkedin: {
    authorizeUrl: "https://www.linkedin.com/oauth/v2/authorization",
    tokenUrl: "https://www.linkedin.com/oauth/v2/accessToken",
    clientIdEnv: "SOCIAL_LINKEDIN_CLIENT_ID",
    clientSecretEnv: "SOCIAL_LINKEDIN_CLIENT_SECRET",
    scopes: ["openid", "profile", "w_member_social"],
    pkce: false,
    useBodyAuth: true,
  },
  x: {
    authorizeUrl: "https://twitter.com/i/oauth2/authorize",
    tokenUrl: "https://api.twitter.com/2/oauth2/token",
    clientIdEnv: "SOCIAL_X_CLIENT_ID",
    clientSecretEnv: "SOCIAL_X_CLIENT_SECRET",
    scopes: ["tweet.read", "tweet.write", "users.read", "offline.access"],
    pkce: true,
    useBodyAuth: true,
  },
  instagram: {
    authorizeUrl: "https://www.facebook.com/v21.0/dialog/oauth",
    tokenUrl: "https://graph.facebook.com/v21.0/oauth/access_token",
    clientIdEnv: "SOCIAL_INSTAGRAM_CLIENT_ID",
    clientSecretEnv: "SOCIAL_INSTAGRAM_CLIENT_SECRET",
    scopes: ["instagram_basic", "instagram_content_publish", "pages_show_list"],
    pkce: false,
    useBodyAuth: true,
  },
  tiktok: {
    authorizeUrl: "https://www.tiktok.com/v2/auth/authorize/",
    tokenUrl: "https://open.tiktokapis.com/v2/oauth/token/",
    clientIdEnv: "SOCIAL_TIKTOK_CLIENT_KEY",
    clientSecretEnv: "SOCIAL_TIKTOK_CLIENT_SECRET",
    scopes: ["user.info.basic", "video.publish", "video.upload"],
    pkce: true,
    useBodyAuth: true,
  },
};

export function oauthConfigured(platform: SocialPlatform, env: NodeJS.ProcessEnv = process.env): boolean {
  const cfg = OAUTH_PROVIDERS[platform];
  return Boolean(env[cfg.clientIdEnv] && env[cfg.clientSecretEnv]);
}

/* ------------------------------------------------------------------ */
/* State signing (CSRF protection, 10-minute TTL)                      */
/* ------------------------------------------------------------------ */

function stateKey(env: NodeJS.ProcessEnv): Buffer {
  const explicit = env.SOCIAL_OAUTH_STATE_SECRET;
  if (explicit) {
    const key = Buffer.from(explicit, "hex");
    if (key.length === 32) return key;
  }
  // Derive from the channel encryption key (always present in production).
  const base = env.CHANNEL_ENC_KEY ?? "";
  return crypto.createHash("sha256").update(`oauth-state:${base}`).digest();
}

export interface SignedState {
  state: string;
  expiresAt: number;
  nonce: string;
}

export function buildState(platform: SocialPlatform, businessUnitId: number, env: NodeJS.ProcessEnv = process.env): SignedState {
  const nonce = crypto.randomBytes(16).toString("hex");
  const expiresAt = Date.now() + 10 * 60 * 1000; // 10-minute TTL
  const payload = `${platform}:${businessUnitId}:${nonce}:${expiresAt}`;
  const mac = crypto.createHmac("sha256", stateKey(env)).update(payload).digest("hex");
  return { state: `${payload}:${mac}`, expiresAt, nonce };
}

export interface VerifiedState {
  platform: SocialPlatform;
  businessUnitId: number;
}

/** Constant-time verification of a signed state; throws OAUTH_STATE on any tamper/expiry. */
export function verifyState(state: string, env: NodeJS.ProcessEnv = process.env): VerifiedState {
  const parts = state.split(":");
  if (parts.length !== 5) throw new SocialServiceError("OAUTH_STATE", "malformed OAuth state");
  const [platform, buRaw, nonce, expRaw, mac] = parts;
  const payload = `${platform}:${buRaw}:${nonce}:${expRaw}`;
  const expected = crypto.createHmac("sha256", stateKey(env)).update(payload).digest("hex");
  const a = Buffer.from(mac, "hex");
  const b = Buffer.from(expected, "hex");
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) {
    throw new SocialServiceError("OAUTH_STATE", "OAuth state MAC mismatch");
  }
  if (Number(expRaw) < Date.now()) {
    throw new SocialServiceError("OAUTH_STATE", "OAuth state expired");
  }
  if (!["linkedin", "x", "instagram", "tiktok"].includes(platform)) {
    throw new SocialServiceError("OAUTH_STATE", `unknown platform in state: ${platform}`);
  }
  return { platform: platform as SocialPlatform, businessUnitId: Number(buRaw) };
}

/* ------------------------------------------------------------------ */
/* Authorize URL construction                                          */
/* ------------------------------------------------------------------ */

export interface AuthorizeStart {
  authorizeUrl: string;
  state: string;
  expiresAt: number;
  pkceVerifier?: string;
}

export function buildAuthorizeUrl(
  platform: SocialPlatform,
  opts: { businessUnitId: number; redirectUri: string; env?: NodeJS.ProcessEnv }
): AuthorizeStart {
  const env = opts.env ?? process.env;
  const cfg = OAUTH_PROVIDERS[platform];
  const clientId = env[cfg.clientIdEnv];
  const clientSecret = env[cfg.clientSecretEnv];
  if (!clientId || !clientSecret) {
    throw new SocialServiceError(
      "CONFIG_MISSING",
      `OAuth not configured for ${platform}: set ${cfg.clientIdEnv} and ${cfg.clientSecretEnv}`
    );
  }
  const signed = buildState(platform, opts.businessUnitId, env);
  const url = new URL(cfg.authorizeUrl);
  url.searchParams.set("client_id", clientId);
  url.searchParams.set("redirect_uri", opts.redirectUri);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("scope", cfg.scopes.join(platform === "linkedin" ? " " : ","));
  url.searchParams.set("state", signed.state);
  let pkceVerifier: string | undefined;
  if (cfg.pkce) {
    pkceVerifier = crypto.randomBytes(32).toString("base64url");
    const challenge = crypto.createHash("sha256").update(pkceVerifier).digest("base64url");
    url.searchParams.set("code_challenge", challenge);
    url.searchParams.set("code_challenge_method", "S256");
  }
  return { authorizeUrl: url.toString(), state: signed.state, expiresAt: signed.expiresAt, pkceVerifier };
}

/* ------------------------------------------------------------------ */
/* Token exchange + refresh                                            */
/* ------------------------------------------------------------------ */

export interface TokenSet {
  accessToken: string;
  refreshToken: string | null;
  expiresAt: Date | null;
  scope: string | null;
  accountRefHint: string | null;
}

interface TokenResponse {
  access_token?: string;
  refresh_token?: string;
  expires_in?: number;
  scope?: string;
  open_id?: string;
  error?: string;
  error_description?: string;
}

async function tokenRequest(
  platform: SocialPlatform,
  body: Record<string, string>,
  opts: { env: NodeJS.ProcessEnv; fetchImpl?: typeof fetch }
): Promise<TokenSet> {
  const env = opts.env;
  const cfg = OAUTH_PROVIDERS[platform];
  const clientId = env[cfg.clientIdEnv];
  const clientSecret = env[cfg.clientSecretEnv];
  if (!clientId || !clientSecret) {
    throw new SocialServiceError("CONFIG_MISSING", `OAuth not configured for ${platform}`);
  }
  const fetchImpl = opts.fetchImpl ?? fetch;
  let res: Response;
  try {
    res = await fetchImpl(cfg.tokenUrl, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        client_id: clientId,
        client_secret: clientSecret,
        ...body,
      }).toString(),
    });
  } catch (e) {
    throw new SocialServiceError("OAUTH_PROVIDER_UNREACHABLE", `token endpoint unreachable: ${String(e).slice(0, 120)}`);
  }
  const json = (await res.json().catch(() => ({}))) as TokenResponse;
  if (!res.ok || !json.access_token) {
    // Provider error detail is CODED, not echoed raw (no secret/url leakage).
    const reason = json.error ?? `http_${res.status}`;
    throw new SocialServiceError("OAUTH_EXCHANGE_FAILED", `token exchange failed: ${reason}`);
  }
  return {
    accessToken: json.access_token,
    refreshToken: json.refresh_token ?? null,
    expiresAt: json.expires_in ? new Date(Date.now() + json.expires_in * 1000) : null,
    scope: json.scope ?? null,
    accountRefHint: json.open_id ?? null,
  };
}

export function exchangeCode(
  platform: SocialPlatform,
  opts: { code: string; redirectUri: string; env?: NodeJS.ProcessEnv; fetchImpl?: typeof fetch; codeVerifier?: string }
): Promise<TokenSet> {
  const body: Record<string, string> = {
    grant_type: "authorization_code",
    code: opts.code,
    redirect_uri: opts.redirectUri,
  };
  if (opts.codeVerifier) body.code_verifier = opts.codeVerifier;
  return tokenRequest(platform, body, { env: opts.env ?? process.env, fetchImpl: opts.fetchImpl });
}

export function refreshAccessToken(
  platform: SocialPlatform,
  opts: { refreshToken: string; env?: NodeJS.ProcessEnv; fetchImpl?: typeof fetch }
): Promise<TokenSet> {
  return tokenRequest(platform, { grant_type: "refresh_token", refresh_token: opts.refreshToken }, {
    env: opts.env ?? process.env,
    fetchImpl: opts.fetchImpl,
  });
}
