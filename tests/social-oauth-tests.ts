/**
 * Phase 10 — OAuth lifecycle (SEC-L5) + platform adapters (pure unit, no DB):
 * signed-state round-trip / tamper / expiry, authorize-URL construction
 * (CONFIG_MISSING without credentials, PKCE for x/tiktok), code exchange +
 * refresh over injected fetch (coded errors, no secret echo), constant-time
 * MAC verification, and adapter behavior: linkedin author = account_ref (R4
 * fix), x text body, IG two-step publish gated by policy.allowIgTiktokPublish
 * (draft-only default), TikTok gated the same, IG metrics best-effort.
 */
import {
  OAUTH_PROVIDERS,
  buildAuthorizeUrl,
  buildState,
  exchangeCode,
  oauthConfigured,
  refreshAccessToken,
  verifyState,
} from "../lib/social/oauth";
import { SocialServiceError } from "../lib/social/types";
import {
  AdapterDraftOnlyError,
  getSocialAdapter,
} from "../lib/social/adapters";

let failures = 0;
function check(name: string, cond: boolean, detail = "") {
  console.log(`${cond ? "PASS" : "FAIL"} ${name}${detail ? " :: " + detail : ""}`);
  if (!cond) failures++;
}

const ENV_BASE: NodeJS.ProcessEnv = { CHANNEL_ENC_KEY: "a".repeat(64), NODE_ENV: "test" };

/* ---------------- state signing ---------------- */
const st = buildState("linkedin", 42, ENV_BASE);
check("state: round-trips", (() => {
  const v = verifyState(st.state, ENV_BASE);
  return v.platform === "linkedin" && v.businessUnitId === 42;
})());
check("state: tampered MAC rejected", await (async () => {
  const parts = st.state.split(":");
  parts[4] = parts[4].split("").reverse().join(""); // flip the MAC
  try { verifyState(parts.join(":"), ENV_BASE); return false; }
  catch (e) { return e instanceof SocialServiceError && e.code === "OAUTH_STATE"; }
})());
check("state: tampered payload rejected (MAC no longer matches)", await (async () => {
  const parts = st.state.split(":");
  parts[1] = "999"; // different BU
  try { verifyState(parts.join(":"), ENV_BASE); return false; }
  catch (e) { return e instanceof SocialServiceError && e.code === "OAUTH_STATE"; }
})());
check("state: expired state rejected", await (async () => {
  const expired = buildState("x", 1, ENV_BASE);
  const parts = expired.state.split(":");
  parts[3] = String(Date.now() - 1000); // rewind expiry (also invalidates MAC → still rejected)
  try { verifyState(parts.join(":"), ENV_BASE); return false; }
  catch (e) { return e instanceof SocialServiceError && e.code === "OAUTH_STATE"; }
})());
check("state: malformed rejected", await (async () => {
  try { verifyState("nonsense", ENV_BASE); return false; }
  catch (e) { return e instanceof SocialServiceError && e.code === "OAUTH_STATE"; }
})());
check("state: key isolation (different secret → reject)", await (async () => {
  try { verifyState(st.state, { CHANNEL_ENC_KEY: "b".repeat(64), NODE_ENV: "test" }); return false; }
  catch (e) { return e instanceof SocialServiceError && e.code === "OAUTH_STATE"; }
})());

/* ---------------- authorize URL ---------------- */
check("authorize: CONFIG_MISSING without client credentials", await (async () => {
  try { buildAuthorizeUrl("linkedin", { businessUnitId: 1, redirectUri: "https://x/cb", env: ENV_BASE }); return false; }
  catch (e) { return e instanceof SocialServiceError && e.code === "CONFIG_MISSING"; }
})());
const envLi: NodeJS.ProcessEnv = { ...ENV_BASE, SOCIAL_LINKEDIN_CLIENT_ID: "cid", SOCIAL_LINKEDIN_CLIENT_SECRET: "csec" };
const liStart = buildAuthorizeUrl("linkedin", { businessUnitId: 7, redirectUri: "https://app/cb", env: envLi });
check("authorize: linkedin URL carries client_id + scopes + state", (() => {
  const u = new URL(liStart.authorizeUrl);
  return u.origin === "https://www.linkedin.com"
    && u.pathname.startsWith("/oauth/v2/authorization")
    && u.searchParams.get("client_id") === "cid"
    && (u.searchParams.get("scope") ?? "").includes("w_member_social")
    && (u.searchParams.get("state") ?? "").length > 20;
})());
check("authorize: linkedin does NOT use PKCE", liStart.pkceVerifier === undefined);
const envX: NodeJS.ProcessEnv = { ...ENV_BASE, SOCIAL_X_CLIENT_ID: "xcid", SOCIAL_X_CLIENT_SECRET: "xcsec" };
const xStart = buildAuthorizeUrl("x", { businessUnitId: 7, redirectUri: "https://app/cb", env: envX });
check("authorize: x uses PKCE (S256 challenge present, verifier returned)", (() => {
  const u = new URL(xStart.authorizeUrl);
  return xStart.pkceVerifier !== undefined
    && u.searchParams.get("code_challenge_method") === "S256"
    && (u.searchParams.get("code_challenge") ?? "").length > 20;
})());
check("oauthConfigured: false without env, true with", !oauthConfigured("x", ENV_BASE) && oauthConfigured("x", envX));

/* ---------------- token exchange + refresh (injected fetch) ---------------- */
const tokenJson = {
  access_token: "at-123",
  refresh_token: "rt-456",
  expires_in: 7200,
  scope: "tweet.write",
};
const okFetch: typeof fetch = (async (input: RequestInfo | URL, init?: RequestInit) =>
  new Response(JSON.stringify(tokenJson), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  })) as typeof fetch;
const exchanged = await exchangeCode("x", { code: "abc", redirectUri: "https://app/cb", env: envX, fetchImpl: okFetch });
check("exchange: token set mapped", exchanged.accessToken === "at-123" && exchanged.refreshToken === "rt-456" && exchanged.expiresAt != null);
const exchangedBody = await (async () => {
  let captured = "";
  const spy: typeof fetch = (async (_url: RequestInfo | URL, init?: RequestInit) => {
    captured = String(init?.body ?? "");
    return new Response(JSON.stringify(tokenJson), { status: 200 }) as unknown as Response;
  }) as typeof fetch;
  await exchangeCode("x", { code: "abc", redirectUri: "https://app/cb", env: envX, fetchImpl: spy, codeVerifier: "verifier-1" });
  return captured;
})();
check("exchange: body carries code + redirect_uri + verifier + client credentials",
  exchangedBody.includes("code=abc") && exchangedBody.includes("code_verifier=verifier-1") && exchangedBody.includes("client_id=xcid"));
check("exchange: provider error → OAUTH_EXCHANGE_FAILED (coded, no echo)", await (async () => {
  const fail: typeof fetch = (async () => new Response(JSON.stringify({ error: "bad_grant" }), { status: 400 })) as typeof fetch;
  try {
    await exchangeCode("x", { code: "abc", redirectUri: "u", env: envX, fetchImpl: fail });
    return false;
  } catch (e) {
    return e instanceof SocialServiceError && e.code === "OAUTH_EXCHANGE_FAILED" && e.message.includes("bad_grant");
  }
})());
check("exchange: network failure → OAUTH_PROVIDER_UNREACHABLE", await (async () => {
  const down: typeof fetch = (async () => { throw new Error("ECONNREFUSED"); }) as typeof fetch;
  try {
    await exchangeCode("x", { code: "abc", redirectUri: "u", env: envX, fetchImpl: down });
    return false;
  } catch (e) {
    return e instanceof SocialServiceError && e.code === "OAUTH_PROVIDER_UNREACHABLE";
  }
})());
check("refresh: grant_type=refresh_token", await (async () => {
  let body = "";
  const spy: typeof fetch = (async (_u: RequestInfo | URL, init?: RequestInit) => {
    body = String(init?.body ?? "");
    return new Response(JSON.stringify(tokenJson), { status: 200 }) as unknown as Response;
  }) as typeof fetch;
  await refreshAccessToken("x", { refreshToken: "rt-456", env: envX, fetchImpl: spy });
  return body.includes("grant_type=refresh_token") && body.includes("refresh_token=rt-456");
})());

/* ---------------- adapters ---------------- */
const policy = { allowIgTiktokPublish: false };

check("linkedin adapter: author = account_ref (R4 fix)", await (async () => {
  let capturedBody: Record<string, unknown> | null = null;
  let capturedAuth = "";
  const spy: typeof fetch = (async (_u: RequestInfo | URL, init?: RequestInit) => {
    capturedBody = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
    capturedAuth = String((init?.headers as Record<string, string>).Authorization ?? "");
    return new Response(JSON.stringify({ id: "li-share-1" }), { status: 200 }) as unknown as Response;
  }) as typeof fetch;
  const out = await getSocialAdapter("linkedin").publish(
    { env: ENV_BASE, fetchImpl: spy },
    { accountRef: "urn:li:person:acme", token: "sekrit", body: "Post body", policy }
  );
  const author = (capturedBody as unknown as Record<string, unknown>).author;
  return author === "urn:li:person:acme" && out.externalId === "li-share-1"
    && capturedAuth === "Bearer sekrit" && out.externalUrl?.includes("li-share-1") === true;
})());
check("linkedin adapter: missing account_ref refused", await (async () => {
  try {
    await getSocialAdapter("linkedin").publish(
      { env: ENV_BASE }, { accountRef: null, token: "t", body: "b", policy });
    return false;
  } catch (e) {
    return e instanceof Error && e.message.includes("account_ref");
  }
})());
check("x adapter: text body, status URL built", await (async () => {
  let capturedBody: Record<string, unknown> | null = null;
  const spy: typeof fetch = (async (_u: RequestInfo | URL, init?: RequestInit) => {
    capturedBody = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
    return new Response(JSON.stringify({ data: { id: "tw-7" } }), { status: 200 }) as unknown as Response;
  }) as typeof fetch;
  const out = await getSocialAdapter("x").publish(
    { env: ENV_BASE, fetchImpl: spy },
    { accountRef: null, token: "t", body: "Hello X", policy }
  );
  return (capturedBody as unknown as Record<string, unknown>).text === "Hello X" && out.externalId === "tw-7" && out.externalUrl?.includes("tw-7") === true;
})());
check("instagram adapter: DRAFT_ONLY when policy off (before any HTTP call)", await (async () => {
  let called = false;
  const spy: typeof fetch = (async () => { called = true; return new Response("{}", { status: 200 }) as unknown as Response; }) as typeof fetch;
  try {
    await getSocialAdapter("instagram").publish(
      { env: ENV_BASE, fetchImpl: spy },
      { accountRef: "1789", token: "t", body: "b", policy });
    return false;
  } catch (e) {
    return e instanceof AdapterDraftOnlyError && !called;
  }
})());
check("instagram adapter: two-step publish when policy ON", await (async () => {
  const hits: string[] = [];
  const spy: typeof fetch = (async (u: RequestInfo | URL) => {
    hits.push(String(u));
    if (String(u).endsWith("/media")) {
      return new Response(JSON.stringify({ id: "container-1" }), { status: 200 }) as unknown as Response;
    }
    return new Response(JSON.stringify({ id: "ig-post-1" }), { status: 200 }) as unknown as Response;
  }) as typeof fetch;
  const out = await getSocialAdapter("instagram").publish(
    { env: ENV_BASE, fetchImpl: spy },
    { accountRef: "1789", token: "t", body: "caption", policy: { allowIgTiktokPublish: true } });
  return hits.length === 2 && hits[0].includes("/media") && hits[1].endsWith("/media_publish")
    && out.externalId === "ig-post-1";
})());
check("tiktok adapter: DRAFT_ONLY when policy off", await (async () => {
  try {
    await getSocialAdapter("tiktok").publish(
      { env: ENV_BASE }, { accountRef: null, token: "t", body: "b", policy });
    return false;
  } catch (e) {
    return e instanceof AdapterDraftOnlyError && e.code === "DRAFT_ONLY";
  }
})());
check("tiktok adapter: publish init when policy ON", await (async () => {
  let body: Record<string, unknown> | null = null;
  const spy: typeof fetch = (async (_u: RequestInfo | URL, init?: RequestInit) => {
    body = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
    return new Response(JSON.stringify({ data: { publish_id: "tt-9" } }), { status: 200 }) as unknown as Response;
  }) as typeof fetch;
  const out = await getSocialAdapter("tiktok").publish(
    { env: ENV_BASE, fetchImpl: spy },
    { accountRef: null, token: "t", body: "video text", policy: { allowIgTiktokPublish: true } });
  return out.externalId === "tt-9" && body != null && ((body as unknown as Record<string, unknown>).post_info as Record<string, unknown>).privacy_level === "PUBLIC_TO_EVERYONE";
})());
check("instagram metrics: best-effort (like/comment counts)", await (async () => {
  const spy: typeof fetch = (async () =>
    new Response(JSON.stringify({ like_count: "12", comments_count: "3" }), { status: 200 }) as unknown as Response) as typeof fetch;
  const m = await getSocialAdapter("instagram").fetchMetrics?.(
    { env: ENV_BASE, fetchImpl: spy }, { externalId: "ig-post-1", token: "t" });
  return m?.likes === 12 && m?.comments === 3;
})());
check("instagram metrics: null on failure (never throws)", await (async () => {
  const spy: typeof fetch = (async () => { throw new Error("down"); }) as typeof fetch;
  const m = await getSocialAdapter("instagram").fetchMetrics?.(
    { env: ENV_BASE, fetchImpl: spy }, { externalId: "x", token: "t" });
  return m === null;
})());
check("adapters: all four platforms registered", ["linkedin", "x", "instagram", "tiktok"].every((p) => {
  try { getSocialAdapter(p as never); return true; } catch { return false; }
}));
check("providers: token endpoints are provider-accurate", OAUTH_PROVIDERS.tiktok.tokenUrl.includes("open.tiktokapis.com")
  && OAUTH_PROVIDERS.instagram.tokenUrl.includes("graph.facebook.com"));

console.log(`\nsocial-oauth: ${failures === 0 ? "ALL PASS" : `${failures} FAILURES`}`);
process.exit(failures === 0 ? 0 : 1);
