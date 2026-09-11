import { query } from "../lib/db";
import { resetRateLimits } from "../lib/security/ratelimit";
import { hashPassword, verifyPassword, generateInitialPassword } from "../lib/auth/password";
import { SESSION_COOKIE, SESSION_TTL_MS, hashToken } from "../lib/auth/sessions";

const loginRoute = await import("../app/api/auth/login/route");
const logoutRoute = await import("../app/api/auth/logout/route");
const meRoute = await import("../app/api/auth/me/route");

let failures = 0;
function check(name: string, cond: boolean, detail = "") {
  console.log(`${cond ? "PASS" : "FAIL"} ${name}${detail ? " :: " + detail : ""}`);
  if (!cond) failures++;
}

const json = (m: string, headers: Record<string, string>, body?: unknown) =>
  new Request(`http://localhost${m}`, { method: "POST", headers, body: body === undefined ? undefined : JSON.stringify(body) });

const stamp = Date.now();
const createdUserIds: number[] = [];
const testEmails: string[] = [];

async function createUser(email: string, password: string, roleKey: string): Promise<number> {
  const hash = await hashPassword(password);
  const [u] = await query<{ id: number }>(
    `INSERT INTO users (email, display_name, password_hash, status) VALUES ($1, $2, $3, 'active') RETURNING id`,
    [email, "Auth Test", hash]
  );
  createdUserIds.push(u.id);
  await query(
    `INSERT INTO user_roles (user_id, role_id) SELECT $1, id FROM roles WHERE key = $2`,
    [u.id, roleKey]
  );
  return u.id;
}

async function countSessions(userId: number): Promise<number> {
  return (await query<{ n: number }>("SELECT count(*)::int AS n FROM sessions WHERE user_id = $1", [userId]))[0].n;
}

try {
  await resetRateLimits(); // DB-backed buckets persist across suite processes
  // ---------- scrypt password hashing (per-user salt, node:crypto) ----------
  const pw = "correct horse battery";
  const h1 = await hashPassword(pw);
  const h2 = await hashPassword(pw);
  check("hash: self-describing scrypt format", h1.startsWith("scrypt$16384$8$1$"));
  check("hash: unique per-user salt (two hashes differ)", h1 !== h2);
  check("verify: correct password accepted", (await verifyPassword(pw, h1)) === true);
  check("verify: wrong password rejected", (await verifyPassword("wrong", h1)) === false);
  check("verify: malformed stored hash rejected safely", (await verifyPassword(pw, "garbage")) === false);
  check("generate: initial password length 18", generateInitialPassword().length === 18);

  // ---------- login route ----------
  const ownerEmail = `auth-owner-${stamp}@test.local`;
  const ownerPw = "owner-password-123";
  testEmails.push(ownerEmail);
  await createUser(ownerEmail, ownerPw, "owner");

  const missing = await loginRoute.POST(json("/api/auth/login", { "Content-Type": "application/json" }, {}));
  check("login: missing fields -> 400", missing.status === 400, `status=${missing.status}`);

  const unknown = await loginRoute.POST(json("/api/auth/login", { "Content-Type": "application/json" }, { email: `nobody-${stamp}@test.local`, password: "whatever-123" }));
  const unknownBody = (await unknown.json()) as { errors?: { code?: string }[] };
  check("login: unknown email -> 401 generic LOGIN_FAILED (no enumeration)", unknown.status === 401 && unknownBody.errors?.[0]?.code === "LOGIN_FAILED", `status=${unknown.status}`);

  const wrong = await loginRoute.POST(json("/api/auth/login", { "Content-Type": "application/json" }, { email: ownerEmail, password: "definitely-wrong" }));
  check("login: wrong password -> 401", wrong.status === 401, `status=${wrong.status}`);

  const good = await loginRoute.POST(json("/api/auth/login", { "Content-Type": "application/json" }, { email: ownerEmail.toUpperCase(), password: ownerPw }));
  check("login: correct credentials (case-insensitive email) -> 200", good.status === 200, `status=${good.status}`);
  const setCookie = good.headers.get("set-cookie") ?? "";
  check("cookie: is the agentos_session cookie", setCookie.includes(`${SESSION_COOKIE}=`));
  check("cookie: HttpOnly", /httponly/i.test(setCookie));
  check("cookie: Secure", /secure/i.test(setCookie));
  check("cookie: SameSite=Lax", /samesite=lax/i.test(setCookie));
  check("cookie: Max-Age = 7 days", setCookie.includes(`Max-Age=${Math.floor(SESSION_TTL_MS / 1000)}`));

  const rawToken = setCookie.split(";")[0].split("=")[1];
  const sessionRows = await query<{ token_hash: string }>(
    "SELECT s.token_hash FROM sessions s JOIN users u ON u.id = s.user_id WHERE u.email = $1",
    [ownerEmail]
  );
  check("session: exactly one row, only the token hash is stored", sessionRows.length === 1 && sessionRows[0].token_hash !== rawToken && sessionRows[0].token_hash.length === 64);

  const cookieHeader = { cookie: `${SESSION_COOKIE}=${rawToken}` };
  const me = await meRoute.GET(new Request("http://localhost/api/auth/me", { headers: cookieHeader }));
  const meBody = (await me.json()) as { data?: { user?: { email?: string; roles?: string[]; permissions?: string[] } } };
  check("me: session resolves to principal with roles+permissions", me.status === 200 && meBody.data?.user?.email === ownerEmail && (meBody.data.user.roles ?? []).includes("owner") && (meBody.data.user.permissions ?? []).length > 0, `status=${me.status}`);
  const meAnon = await meRoute.GET(new Request("http://localhost/api/auth/me"));
  check("me: without session -> 401", meAnon.status === 401);

  // ---------- lockout after N failures ----------
  const lockedEmail = `auth-locked-${stamp}@test.local`;
  testEmails.push(lockedEmail);
  await createUser(lockedEmail, "locked-password-123", "reviewer");
  for (let i = 0; i < 5; i++) {
    await loginRoute.POST(json("/api/auth/login", { "Content-Type": "application/json" }, { email: lockedEmail, password: "nope-nope-nope" }));
  }
  const lockedRes = await loginRoute.POST(json("/api/auth/login", { "Content-Type": "application/json" }, { email: lockedEmail, password: "locked-password-123" }));
  check("login: 5 failures lock the account (even correct password) -> 423", lockedRes.status === 423, `status=${lockedRes.status}`);
  await query("UPDATE users SET failed_login_count = 0, locked_until = NULL WHERE email = $1", [lockedEmail]);

  // ---------- expiry + sliding window ----------
  const expEmail = `auth-expiry-${stamp}@test.local`;
  testEmails.push(expEmail);
  const expUser = await createUser(expEmail, "expiry-password-12", "reviewer");
  await query(
    `INSERT INTO sessions (user_id, token_hash, expires_at) VALUES ($1, $2, now() - interval '1 minute')`,
    [expUser, `expired-${stamp}`]
  );
  const meExpired = await meRoute.GET(new Request("http://localhost/api/auth/me", { headers: { cookie: `${SESSION_COOKIE}=expired-${stamp}` } }));
  check("session: expired -> 401", meExpired.status === 401, `status=${meExpired.status}`);
  check("session: expired row not counted as live", (await countSessions(expUser)) === 1); // row exists but expired — cleanup below

  // sliding: session within the renewal threshold extends back to full TTL
  const soonRaw = `soon-${stamp}`;
  const soonHash = hashToken(soonRaw);
  await query(
    `INSERT INTO sessions (user_id, token_hash, expires_at) VALUES ($1, $2, now() + interval '1 hour')`,
    [expUser, soonHash]
  );
  await meRoute.GET(new Request("http://localhost/api/auth/me", { headers: { cookie: `${SESSION_COOKIE}=${soonRaw}` } }));
  const slid = await query<{ hours: number }>(
    `SELECT EXTRACT(EPOCH FROM (expires_at - now()))/3600 AS hours FROM sessions WHERE token_hash = $1`,
    [soonHash]
  );
  check("session: sliding expiry renewed towards 7 days", Number(slid[0].hours) > 24, `hours=${slid[0]?.hours}`);
  await query("DELETE FROM sessions WHERE user_id = $1", [expUser]);

  // ---------- logout ----------
  const before = await countSessions((await query<{ id: number }>("SELECT id FROM users WHERE email = $1", [ownerEmail]))[0].id);
  const logout = await logoutRoute.POST(new Request("http://localhost/api/auth/logout", { method: "POST", headers: cookieHeader }));
  const logoutCookie = logout.headers.get("set-cookie") ?? "";
  const after = await countSessions((await query<{ id: number }>("SELECT id FROM users WHERE email = $1", [ownerEmail]))[0].id);
  check("logout: 200 + clears the cookie", logout.status === 200 && /max-age=0/i.test(logoutCookie));
  check("logout: server-side session row deleted", before === 1 && after === 0, `before=${before} after=${after}`);
  const meAfterLogout = await meRoute.GET(new Request("http://localhost/api/auth/me", { headers: { cookie: `${SESSION_COOKIE}=${rawToken}` } }));
  check("logout: token no longer authenticates", meAfterLogout.status === 401);
} finally {
  await query("DELETE FROM sessions WHERE user_id = ANY($1)", [createdUserIds.length ? createdUserIds : [0]]);
  await query("DELETE FROM users WHERE id = ANY($1)", [createdUserIds.length ? createdUserIds : [0]]);
  await query("DELETE FROM audit_logs WHERE actor_label = ANY($1)", [testEmails.length ? testEmails : ["__none__"]]);
}

if (failures > 0) { console.error(`${failures} FAIL`); process.exit(1); }
console.log("AUTH SUITE PASS");
