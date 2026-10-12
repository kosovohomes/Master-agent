/**
 * Access & Identity Overhaul suite:
 *  - lib/auth/google.ts: state signing/verification, PKCE math, config
 *    detection, owner allowlist parsing, safe redirect paths
 *  - /api/auth/providers: fail-closed provider advertisement
 *  - /api/auth/oauth/google/start: authorize redirect + round-trip cookies
 *  - /api/auth/oauth/google/callback: full identity-resolution matrix with
 *    a mocked Google token/userinfo endpoint (link, allowlist provisioning,
 *    denial paths, CSRF binding, tamper/expiry)
 *  - /api/admin/recover: bearer-guarded inventory + password rotation
 */
import { query } from "../lib/db";
import { resetRateLimits } from "../lib/security/ratelimit";
import { hashPassword, verifyPassword } from "../lib/auth/password";
import { SESSION_COOKIE } from "../lib/auth/sessions";
import {
  buildSigninState,
  verifySigninState,
  nonceMatches,
  pkcePair,
  googleOAuthConfigured,
  ownerAllowlist,
  isOwnerAllowlisted,
  safeNextPath,
  buildGoogleAuthorizeUrl,
  GoogleAuthError,
  OAUTH_NONCE_COOKIE,
  OAUTH_VERIFIER_COOKIE,
  OAUTH_NEXT_COOKIE,
  OAUTH_COOKIE_MAX_AGE,
  setGoogleFetchImpl,
  GOOGLE_TOKEN_URL,
  GOOGLE_USERINFO_URL,
} from "../lib/auth/google";

const startRoute = await import("../app/api/auth/oauth/google/start/route");
const callbackRoute = await import("../app/api/auth/oauth/google/callback/route");
const providersRoute = await import("../app/api/auth/providers/route");
const recoverRoute = await import("../app/api/admin/recover/route");

let failures = 0;
function check(name: string, cond: boolean, detail = "") {
  console.log(`${cond ? "PASS" : "FAIL"} ${name}${detail ? " :: " + detail : ""}`);
  if (!cond) failures++;
}

const stamp = Date.now();
const createdUserIds: number[] = [];
const testEmails: string[] = [];

const ENV_SNAPSHOT = {
  GOOGLE_CLIENT_ID: process.env.GOOGLE_CLIENT_ID,
  GOOGLE_CLIENT_SECRET: process.env.GOOGLE_CLIENT_SECRET,
  OWNER_EMAILS: process.env.OWNER_EMAILS,
};
const ID = "test-google-client-id";
const SECRET = "test-google-client-secret";
process.env.GOOGLE_CLIENT_ID = ID;
process.env.GOOGLE_CLIENT_SECRET = SECRET;

async function createUser(email: string, password: string, roleKey: string): Promise<number> {
  const hash = await hashPassword(password);
  const [u] = await query<{ id: number }>(
    `INSERT INTO users (email, display_name, password_hash, status) VALUES ($1, $2, $3, 'active') RETURNING id`,
    [email, "OAuth Test", hash]
  );
  createdUserIds.push(u.id);
  testEmails.push(email);
  await query(`INSERT INTO user_roles (user_id, role_id) SELECT $1, id FROM roles WHERE key = $2`, [u.id, roleKey]);
  return u.id;
}

function setCookieHeaders(res: Response): string[] {
  const anyHeaders = res.headers as Headers & { getSetCookie?: () => string[] };
  if (typeof anyHeaders.getSetCookie === "function") return anyHeaders.getSetCookie();
  const single = res.headers.get("set-cookie");
  return single ? [single] : [];
}

function cookieValue(res: Response, name: string): string | null {
  for (const c of setCookieHeaders(res)) {
    if (c.startsWith(`${name}=`)) return decodeURIComponent(c.split(";")[0].slice(name.length + 1));
  }
  return null;
}

interface MockProfile { sub: string; email: string; email_verified: boolean; name?: string }
let mockProfile: MockProfile | null = null;

/** Deterministic Google stand-in for token + userinfo endpoints. */
setGoogleFetchImpl(async (url: any, init?: any) => {
  const u = String(url);
  if (u === GOOGLE_TOKEN_URL) {
    return new Response(JSON.stringify({ access_token: "mock-access-token", expires_in: 3600 }), { status: 200 });
  }
  if (u === GOOGLE_USERINFO_URL) {
    if (!mockProfile) return new Response("{}", { status: 500 });
    return new Response(JSON.stringify(mockProfile), { status: 200, headers: { "Content-Type": "application/json" } });
  }
  return new Response("unexpected", { status: 404 });
});

/** Runs start → callback with consistent cookies; returns the callback response. */
async function runRoundTrip(opts: { email: string; emailVerified?: boolean; sub?: string; next?: string; dropCookies?: boolean; tamperState?: boolean; providerError?: string }): Promise<Response> {
  mockProfile = { sub: opts.sub ?? `sub-${stamp}-${Math.abs(hashCode(opts.email))}`, email: opts.email, email_verified: opts.emailVerified ?? true, name: "OAuth Test" };
  const startUrl = new URL("http://localhost/api/auth/oauth/google/start");
  if (opts.next) startUrl.searchParams.set("next", opts.next);
  const start = await startRoute.GET(new Request(startUrl.toString()));
  const loc = start.headers.get("location") ?? "";
  const state = new URL(loc).searchParams.get("state") ?? "";
  const nonce = cookieValue(start, OAUTH_NONCE_COOKIE) ?? "";
  const verifier = cookieValue(start, OAUTH_VERIFIER_COOKIE) ?? "";
  const nextCookie = cookieValue(start, OAUTH_NEXT_COOKIE) ?? "";

  let stateOut = state;
  if (opts.tamperState) stateOut = `${state.slice(0, -1)}${state.endsWith("a") ? "b" : "a"}`;

  const cb = new URL("http://localhost/api/auth/oauth/google/callback");
  if (opts.providerError) cb.searchParams.set("error", opts.providerError);
  else { cb.searchParams.set("code", "mock-code"); cb.searchParams.set("state", stateOut); }

  const cookies: string[] = [];
  if (!opts.dropCookies) {
    if (nonce) cookies.push(`${OAUTH_NONCE_COOKIE}=${nonce}`);
    if (verifier) cookies.push(`${OAUTH_VERIFIER_COOKIE}=${verifier}`);
    if (nextCookie) cookies.push(`${OAUTH_NEXT_COOKIE}=${encodeURIComponent(nextCookie)}`);
  }
  return callbackRoute.GET(new Request(cb.toString(), { headers: cookies.length ? { cookie: cookies.join("; ") } : {} }));
}

function hashCode(s: string): number {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (Math.imul(31, h) + s.charCodeAt(i)) | 0;
  return h;
}

try {
  await resetRateLimits();

  /* ---------------- lib: state + PKCE + config ---------------- */
  const st = buildSigninState();
  check("state: verify roundtrip returns the nonce", verifySigninState(st.state) === st.nonce);
  const [kind, nonceP, expP] = st.state.split(":");
  const tampered = `${kind}:${nonceP}:${expP}:deadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef`;
  let threw = "no";
  try { verifySigninState(tampered); } catch (e) { threw = e instanceof GoogleAuthError ? e.code : "other"; }
  check("state: tampered MAC rejected as OAUTH_STATE", threw === "OAUTH_STATE", `threw=${threw}`);
  threw = "no";
  try { verifySigninState(`${kind}:${nonceP}:123:deadbeef`); } catch (e) { threw = e instanceof GoogleAuthError ? e.code : "other"; }
  check("state: expired state rejected", threw === "OAUTH_STATE");
  threw = "no";
  try { verifySigninState(null); } catch (e) { threw = e instanceof GoogleAuthError ? e.code : "other"; }
  check("state: missing state rejected", threw === "OAUTH_STATE");
  check("nonce: double-submit positive", nonceMatches(st.nonce, st.nonce) === true);
  check("nonce: double-submit negative", nonceMatches(st.nonce, "0".repeat(32)) === false);
  check("nonce: missing cookie negative", nonceMatches(st.nonce, null) === false);

  const pkce = pkcePair();
  const crypto = await import("node:crypto");
  const expectedChallenge = crypto.createHash("sha256").update(pkce.verifier).digest("base64url");
  check("pkce: challenge is S256(verifier)", pkce.challenge === expectedChallenge);

  check("config: unconfigured when env absent", googleOAuthConfigured({}) === false);
  check("config: configured with id+secret", googleOAuthConfigured({ GOOGLE_CLIENT_ID: "a", GOOGLE_CLIENT_SECRET: "b" }) === true);

  check("allowlist: parses + lowercases", JSON.stringify(ownerAllowlist({ OWNER_EMAILS: " A@X.io ,b@y.io,not-an-email" })) === JSON.stringify(["a@x.io", "b@y.io"]));
  check("allowlist: membership case-insensitive", isOwnerAllowlisted("A@X.io", { OWNER_EMAILS: "a@x.io" }) === true);
  check("allowlist: empty env = empty list", ownerAllowlist({}).length === 0);

  check("next: accepts root path", safeNextPath("/dashboard") === "/dashboard");
  check("next: accepts nested path", safeNextPath("/supervisor") === "/supervisor");
  check("next: rejects protocol-relative", safeNextPath("//evil.example") === "/dashboard");
  check("next: rejects absolute URL", safeNextPath("https://evil.example") === "/dashboard");
  check("next: rejects backslash scheme", safeNextPath("/\\evil") === "/dashboard");
  check("next: defaults empty", safeNextPath(null) === "/dashboard");

  const noCfg = (() => { try { buildGoogleAuthorizeUrl({ redirectUri: "http://localhost/cb", env: {} }); return "no-throw"; } catch (e) { return e instanceof GoogleAuthError ? e.code : "other"; } })();
  check("authorize: CONFIG_MISSING without credentials", noCfg === "CONFIG_MISSING", `got=${noCfg}`);

  const startBuilt = buildGoogleAuthorizeUrl({ redirectUri: "http://localhost/cb", env: { GOOGLE_CLIENT_ID: "cid", GOOGLE_CLIENT_SECRET: "sec" } });
  const authUrl = new URL(startBuilt.authorizeUrl);
  check("authorize: targets accounts.google.com", authUrl.origin === "https://accounts.google.com");
  check("authorize: carries client_id + code response type", authUrl.searchParams.get("client_id") === "cid" && authUrl.searchParams.get("response_type") === "code");
  check("authorize: carries state + S256 challenge + select_account", Boolean(authUrl.searchParams.get("state")) && authUrl.searchParams.get("code_challenge_method") === "S256" && authUrl.searchParams.get("prompt") === "select_account");
  check("authorize: redirect_uri is the callback", authUrl.searchParams.get("redirect_uri") === "http://localhost/cb");
  verifySigninState(startBuilt.state, { GOOGLE_CLIENT_ID: "cid", GOOGLE_CLIENT_SECRET: "sec" }); // must not throw (same env as signing)

  /* ---------------- providers route (fail-closed advertisement) ---------------- */
  delete process.env.GOOGLE_CLIENT_ID;
  const provOff = await providersRoute.GET();
  const provOffBody = (await provOff.json()) as { data: { password: boolean; google: boolean } };
  check("providers: google hidden when unconfigured", provOff.status === 200 && provOffBody.data.google === false && provOffBody.data.password === true);
  process.env.GOOGLE_CLIENT_ID = ID;
  const provOn = await providersRoute.GET();
  check("providers: google advertised when configured", ((await provOn.json()) as any).data.google === true);

  /* ---------------- start leg ---------------- */
  const ownerEmail = `oauth-owner-${stamp}@test.local`;
  const ownerPw = "oauth-owner-password-1";
  process.env.OWNER_EMAILS = `${ownerEmail},second-${stamp}@test.local`;

  const start1 = await startRoute.GET(new Request("http://localhost/api/auth/oauth/google/start?next=/supervisor"));
  check("start: 302 to accounts.google.com", start1.status === 302 && (start1.headers.get("location") ?? "").startsWith("https://accounts.google.com/o/oauth2/v2/auth"));
  const sc = setCookieHeaders(start1).join("\n");
  check("start: sets nonce + verifier + next cookies", sc.includes(`${OAUTH_NONCE_COOKIE}=`) && sc.includes(`${OAUTH_VERIFIER_COOKIE}=`) && sc.includes(`${OAUTH_NEXT_COOKIE}=%2Fsupervisor`));
  check("start: cookies are HttpOnly Secure SameSite=Lax with 10-min TTL", /httponly/i.test(sc) && /secure/i.test(sc) && /samesite=lax/i.test(sc) && sc.includes(`Max-Age=${OAUTH_COOKIE_MAX_AGE}`));

  const startNoCfg = await (async () => {
    delete process.env.GOOGLE_CLIENT_ID;
    const r = await startRoute.GET(new Request("http://localhost/api/auth/oauth/google/start"));
    process.env.GOOGLE_CLIENT_ID = ID;
    return r;
  })();
  check("start: unconfigured bounces to /login?error=oauth_unconfigured", startNoCfg.status === 302 && (startNoCfg.headers.get("location") ?? "").includes("/login?error=oauth_unconfigured"));

  /* ---------------- callback: identity resolution matrix ---------------- */
  const linkedSub = `sub-linked-${stamp}`;
  await createUser(ownerEmail, ownerPw, "owner");

  const linkRes = await runRoundTrip({ email: ownerEmail, sub: linkedSub, next: "/supervisor" });
  check("callback: existing user → 302 to requested next path", linkRes.status === 302 && (linkRes.headers.get("location") ?? "").endsWith("/supervisor"), `loc=${linkRes.headers.get("location")}`);
  check("callback: session cookie set", setCookieHeaders(linkRes).some((c) => c.startsWith(`${SESSION_COOKIE}=`)));
  const [linkedRow] = await query<{ provider: string; provider_id: string | null }>("SELECT provider, provider_id FROM users WHERE email = $1", [ownerEmail]);
  check("callback: user linked to google identity", linkedRow.provider === "google" && linkedRow.provider_id === linkedSub, JSON.stringify(linkedRow));
  const tokenOut = setCookieHeaders(linkRes).find((c) => c.startsWith(`${SESSION_COOKIE}=`));
  const linkedToken = tokenOut ? tokenOut.split(";")[0].split("=")[1] : "";
  const [sessionRow] = await query<{ n: number }>("SELECT count(*)::int AS n FROM sessions WHERE token_hash = encode(sha256($1::bytea), 'hex')", [Buffer.from(linkedToken, "utf8")]);
  check("callback: server-side session row created", sessionRow.n === 1);

  // second sign-in must NOT re-link or fail (same sub)
  const relink = await runRoundTrip({ email: ownerEmail, sub: linkedSub });
  check("callback: repeat sign-in with same sub succeeds", relink.status === 302 && (relink.headers.get("location") ?? "").endsWith("/dashboard"));

  // conflict: different sub on an already-linked account
  const conflict = await runRoundTrip({ email: ownerEmail, sub: `${linkedSub}-x` });
  check("callback: different sub → identity_conflict, no session", (conflict.headers.get("location") ?? "").includes("error=identity_conflict") && !setCookieHeaders(conflict).some((c) => c.startsWith(`${SESSION_COOKIE}=`)));

  // provisioning from allowlist
  const freshEmail = `oauth-provisioned-${stamp}@test.local`;
  testEmails.push(freshEmail);
  process.env.OWNER_EMAILS = `${ownerEmail},${freshEmail}`;
  const provRes = await runRoundTrip({ email: freshEmail, sub: `sub-prov-${stamp}` });
  const [provUser] = await query<{ id: number; provider: string; provider_id: string | null }>("SELECT id, provider, provider_id FROM users WHERE email = $1", [freshEmail]);
  check("callback: allowlisted email auto-provisions owner", Boolean(provUser) && provUser.provider === "google", `loc=${provRes.headers.get("location")}`);
  if (provUser) createdUserIds.push(provUser.id);
  const [provRole] = await query<{ n: number }>(
    `SELECT count(*)::int AS n FROM user_roles ur JOIN roles r ON r.id = ur.role_id WHERE ur.user_id = $1 AND r.key = 'owner'`,
    provUser ? [provUser.id] : [0]
  );
  check("callback: provisioned user holds owner role", provRole.n === 1);
  const [provHash] = await query<{ password_hash: string }>("SELECT password_hash FROM users WHERE email = $1", [freshEmail]);
  check("callback: provisioned user has no usable password", (await verifyPassword("anything", provHash.password_hash)) === false);
  check("callback: provisioned user gets a session", setCookieHeaders(provRes).some((c) => c.startsWith(`${SESSION_COOKIE}=`)));

  // denial: unknown + not allowlisted
  const stranger = `oauth-stranger-${stamp}@test.local`;
  testEmails.push(stranger);
  const deny = await runRoundTrip({ email: stranger, sub: `sub-stranger-${stamp}` });
  const [strangerRow] = await query<{ n: number }>("SELECT count(*)::int AS n FROM users WHERE email = $1", [stranger]);
  check("callback: non-allowlisted stranger denied, nothing created", (deny.headers.get("location") ?? "").includes("error=not_authorized") && strangerRow.n === 0);

  // denial: unverified email on an existing user
  const unverified = await runRoundTrip({ email: ownerEmail, sub: linkedSub, emailVerified: false });
  check("callback: unverified email rejected", (unverified.headers.get("location") ?? "").includes("error=email_unverified"));

  // denial: disabled user
  await query("UPDATE users SET status = 'disabled' WHERE email = $1", [ownerEmail]);
  const disabled = await runRoundTrip({ email: ownerEmail, sub: linkedSub });
  check("callback: disabled user rejected, no session", (disabled.headers.get("location") ?? "").includes("error=account_disabled") && !setCookieHeaders(disabled).some((c) => c.startsWith(`${SESSION_COOKIE}=`)));
  await query("UPDATE users SET status = 'active' WHERE email = $1", [ownerEmail]);

  // CSRF: state without matching nonce cookie
  const csrf = await runRoundTrip({ email: ownerEmail, sub: linkedSub, dropCookies: true });
  check("callback: missing nonce cookie → oauth_state (CSRF bound)", (csrf.headers.get("location") ?? "").includes("error=oauth_state"));

  // tampered state
  const tamper = await runRoundTrip({ email: ownerEmail, sub: linkedSub, tamperState: true });
  check("callback: tampered state → oauth_state", (tamper.headers.get("location") ?? "").includes("error=oauth_state"));

  // provider error leg (user cancelled consent)
  const cancelled = await runRoundTrip({ email: ownerEmail, providerError: "access_denied" });
  check("callback: provider error → oauth_cancelled", (cancelled.headers.get("location") ?? "").includes("error=oauth_cancelled"));

  // oauth cookies cleared on every exit
  check("callback: round-trip cookies cleared on exit", setCookieHeaders(deny).filter((c) => /agentos_oauth_n=;/.test(c) || /Max-Age=0/.test(c)).length >= 1);

  /* ---------------- recover route ---------------- */
  const noBearer = await recoverRoute.POST(new Request("http://localhost/api/admin/recover", { method: "POST", body: JSON.stringify({}) }));
  check("recover: no bearer → 401", noBearer.status === 401);
  const badBearer = await recoverRoute.POST(new Request("http://localhost/api/admin/recover", { method: "POST", headers: { authorization: "Bearer wrong-token" }, body: JSON.stringify({}) }));
  check("recover: wrong bearer → 401", badBearer.status === 401);

  process.env.OPS_TOKEN = `ops-test-${stamp}`;
  const inventory = await recoverRoute.POST(new Request("http://localhost/api/admin/recover", { method: "POST", headers: { authorization: `Bearer ${process.env.OPS_TOKEN}` }, body: JSON.stringify({}) }));
  const invBody = (await inventory.json()) as { data: { users: { email: string; roles: string[]; hasPassword: boolean }[] } };
  check("recover: inventory lists users with roles", inventory.status === 200 && invBody.data.users.some((u) => u.email === ownerEmail && u.roles.includes("owner")));

  // rotate: old password stops working, sessions destroyed, lockout cleared
  const victimEmail = `oauth-rotated-${stamp}@test.local`;
  await createUser(victimEmail, "old-password-123", "administrator");
  await query(
    `UPDATE users SET failed_login_count = 5, locked_until = now() + interval '10 minutes' WHERE email = $1`,
    [victimEmail]
  );
  const [victimBefore] = await query<{ id: number }>("SELECT id FROM users WHERE email = $1", [victimEmail]);
  await query(`INSERT INTO sessions (user_id, token_hash, expires_at) VALUES ($1, 'stale-hash', now() + interval '1 hour')`, [victimBefore.id]);
  const rotate = await recoverRoute.POST(new Request("http://localhost/api/admin/recover", { method: "POST", headers: { authorization: `Bearer ${process.env.OPS_TOKEN}`, "content-type": "application/json" }, body: JSON.stringify({ email: victimEmail.toUpperCase() }) }));
  const rotBody = (await rotate.json()) as { data: { userId: number; email: string; initialPassword: string } };
  check("recover: rotate returns one-time initial password", rotate.status === 200 && rotBody.data.initialPassword.length === 18 && rotBody.data.email === victimEmail, `status=${rotate.status}`);
  const [rotRow] = await query<{ password_hash: string; failed_login_count: number; locked_until: Date | null }>("SELECT password_hash, failed_login_count, locked_until FROM users WHERE email = $1", [victimEmail]);
  check("recover: lockout + counters cleared", rotRow.failed_login_count === 0 && rotRow.locked_until === null);
  check("recover: old password no longer verifies", (await verifyPassword("old-password-123", rotRow.password_hash)) === false);
  check("recover: new initial password verifies", (await verifyPassword(rotBody.data.initialPassword, rotRow.password_hash)) === true);
  const [staleSessions] = await query<{ n: number }>("SELECT count(*)::int AS n FROM sessions WHERE user_id = $1", [victimBefore.id]);
  check("recover: existing sessions destroyed", staleSessions.n === 0);

  const unknown = await recoverRoute.POST(new Request("http://localhost/api/admin/recover", { method: "POST", headers: { authorization: `Bearer ${process.env.OPS_TOKEN}`, "content-type": "application/json" }, body: JSON.stringify({ email: `nobody-${stamp}@test.local` }) }));
  check("recover: unknown email → 404", unknown.status === 404);
} finally {
  setGoogleFetchImpl((...args) => fetch(...args));
  for (const [k, v] of Object.entries(ENV_SNAPSHOT)) {
    if (v === undefined) delete (process.env as any)[k];
    else (process.env as any)[k] = v;
  }
  await query("DELETE FROM sessions WHERE user_id = ANY($1)", [createdUserIds.length ? createdUserIds : [0]]);
  await query("DELETE FROM users WHERE id = ANY($1)", [createdUserIds.length ? createdUserIds : [0]]);
  await query("DELETE FROM audit_logs WHERE actor_label = ANY($1)", [testEmails.length ? testEmails : ["__none__"]]);
  await query("DELETE FROM audit_logs WHERE action IN ('auth.oauth.start','auth.oauth.callback','auth.recover') AND created_at > now() - interval '1 hour' AND (metadata->>'provider' = 'google' OR metadata->>'mode' IN ('inventory','rotate'))");
}

if (failures > 0) { console.error(`${failures} FAIL`); process.exit(1); }
console.log("AUTH-OAUTH SUITE PASS");
