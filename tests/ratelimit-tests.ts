import { query } from "../lib/db";
import { resetRateLimits, rateLimit, hitDailyLlmCap, clientIp } from "../lib/security/ratelimit";
import { SESSION_COOKIE } from "../lib/auth/sessions";
import { hashPassword } from "../lib/auth/password";
import { createSession } from "../lib/auth/sessions";

/**
 * Rate limiting (Phase 1 M0 acceptance: rate-limited endpoints return 429
 * when limits are exceeded; daily caps enforced per tenant).
 */
const loginRoute = await import("../app/api/auth/login/route");
const runRoute = await import("../app/api/agents/run/route");
const chatRoute = await import("../app/api/v1/chat/route");

let failures = 0;
function check(name: string, cond: boolean, detail = "") {
  console.log(`${cond ? "PASS" : "FAIL"} ${name}${detail ? " :: " + detail : ""}`);
  if (!cond) failures++;
}

const stamp = Date.now();
const createdTenantIds: number[] = [];
const createdUserIds: number[] = [];

const post = (m: string, headers: Record<string, string>, body?: unknown) =>
  new Request(`http://localhost${m}`, { method: "POST", headers, body: body === undefined ? undefined : JSON.stringify(body) });

async function seedTenant(): Promise<number> {
  const [t] = await query<{ id: number }>(`INSERT INTO tenants (slug, name) VALUES ($1, $2) RETURNING id`, [`rl-${stamp}-${Math.floor(Math.random() * 1e6)}`, "RL Co"]);
  createdTenantIds.push(t.id);
  return t.id;
}

try {
  const floodTenant = await seedTenant();

  // ---------- unit: token bucket ----------
  resetRateLimits();
  const rl1 = rateLimit("unit:x", 3, 60_000);
  const rl2 = rateLimit("unit:x", 3, 60_000);
  const rl3 = rateLimit("unit:x", 3, 60_000);
  const rl4 = rateLimit("unit:x", 3, 60_000);
  check("bucket: allows up to limit", rl1.allowed && rl2.allowed && rl3.allowed);
  check("bucket: 4th request denied with 429 semantics", rl4.allowed === false && rl4.remaining === 0 && rl4.retryAfterSec >= 1);
  resetRateLimits();
  const rl5 = rateLimit("unit:x", 3, 60_000);
  check("bucket: reset clears state", rl5.allowed);
  check("bucket: independent keys", rateLimit("unit:y", 1, 60_000).allowed);

  // clientIp: x-forwarded-for first hop wins
  const ipReq = new Request("http://localhost/", { headers: { "x-forwarded-for": "203.0.113.7, 10.0.0.1", "x-real-ip": "198.51.100.1" } });
  check("clientIp: first x-forwarded-for hop", clientIp(ipReq) === "203.0.113.7");

  // ---------- route: login flood -> 429 ----------
  resetRateLimits();
  let saw429 = false;
  for (let i = 0; i < 12; i++) {
    const r = await loginRoute.POST(post("/api/auth/login", { "Content-Type": "application/json" }, { email: `flood-${i}-${stamp}@test.local`, password: "whatever-xyz" }));
    if (r.status === 429) saw429 = true;
  }
  check("login flood: 429 after 10/5min per IP", saw429);
  resetRateLimits();

  // ---------- route: agents/run flood -> 429 (before auth even matters) ----------
  let run429 = false;
  let run401 = 0;
  for (let i = 0; i < 7; i++) {
    const r = await runRoute.POST(post("/api/agents/run", { "Content-Type": "application/json" }, { tenantId: 1 }));
    if (r.status === 429) run429 = true;
    if (r.status === 401) run401++;
  }
  check("run flood: unauthenticated 401s then 429", run401 === 5 && run429, `401s=${run401} 429=${run429}`);
  resetRateLimits();

  // ---------- route: chat flood -> 429 (public endpoint) ----------
  let chat429 = false;
  for (let i = 0; i < 12; i++) {
    const r = await chatRoute.POST(post("/api/v1/chat", { "Content-Type": "application/json" }, { tenantId: floodTenant, question: `q${i}` }));
    if (r.status === 429) chat429 = true;
  }
  check("chat flood: 429 after 10/min per IP", chat429);
  resetRateLimits();

  // ---------- per-tenant daily LLM cap (DB-backed) ----------
  process.env.DAILY_TENANT_LLM_CAP = "2";
  const t = { id: await seedTenant() }; // fresh tenant: flood traffic must not consume its cap budget
  const c1 = await hitDailyLlmCap(t.id);
  const c2 = await hitDailyLlmCap(t.id);
  const c3 = await hitDailyLlmCap(t.id);
  check("daily cap: first two calls allowed", c1.allowed && c2.allowed && c1.cap === 2);
  check("daily cap: third call denied", c3.allowed === false && c3.used === 3, `used=${c3.used}`);
  const usageRow = await query<{ llm_calls: number }>("SELECT llm_calls FROM tenant_usage_daily WHERE tenant_id = $1", [t.id]);
  check("daily cap: persisted in tenant_usage_daily", usageRow[0]?.llm_calls === 3);
  delete process.env.DAILY_TENANT_LLM_CAP;

  // session user still passes the IP limiter (fresh) — cap denial takes
  // priority over execution even for authenticated callers
  const hash = await hashPassword(`pw-${stamp}`);
  const [u] = await query<{ id: number }>(
    `INSERT INTO users (email, password_hash, status) VALUES ($1, $2, 'active') RETURNING id`,
    [`rl-op-${stamp}@test.local`, hash]
  );
  createdUserIds.push(u.id);
  await query(`INSERT INTO user_roles (user_id, role_id) SELECT $1, id FROM roles WHERE key = 'operator'`, [u.id]);
  const { token } = await createSession(u.id);
  process.env.DAILY_TENANT_LLM_CAP = "3";
  const cappedRun = await runRoute.POST(post("/api/agents/run", { "Content-Type": "application/json", cookie: `${SESSION_COOKIE}=${token}` }, { tenantId: t.id, topic: "x", channel: "x" }));
  check("daily cap: authenticated run over cap -> 429 DAILY_LLM_CAP_REACHED", cappedRun.status === 429 && (await cappedRun.json()).errors?.[0]?.code === "DAILY_LLM_CAP_REACHED", `status=${cappedRun.status}`);
  delete process.env.DAILY_TENANT_LLM_CAP;
} finally {
  resetRateLimits();
  await query("DELETE FROM sessions WHERE user_id = ANY($1)", [createdUserIds.length ? createdUserIds : [0]]);
  await query("DELETE FROM users WHERE id = ANY($1)", [createdUserIds.length ? createdUserIds : [0]]);
  await query("DELETE FROM tenants WHERE id = ANY($1)", [createdTenantIds.length ? createdTenantIds : [0]]);
  await query("DELETE FROM audit_logs WHERE action IN ('agents.run','chat.answer','auth.login') AND created_at > now() - interval '5 minutes' AND actor_label LIKE 'flood-%'");
}

if (failures > 0) { console.error(`${failures} FAIL`); process.exit(1); }
console.log("RATELIMIT SUITE PASS");
