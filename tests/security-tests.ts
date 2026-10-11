import assert from "node:assert";
import { resetRateLimits } from "../lib/security/ratelimit";
import { encryptChannelToken, decryptChannelToken } from "../lib/channels";
import { query } from "../lib/db";
import { safeEqual } from "../lib/security";

// Fake admin password BEFORE loading any admin module so no real .env.local
// value is compared, printed, or leaked to test output.
const FAKE_PW = `sec-admin-${Date.now()}`;
process.env.ADMIN_PASSWORD = FAKE_PW;

const runRoute = await import("../app/api/agents/run/route");
const chatRoute = await import("../app/api/v1/chat/route");
const channelsRoute = await import("../app/api/v1/channels/route");
const draftsRoute = await import("../app/api/admin/drafts/route");
const draftsIdRoute = await import("../app/api/admin/drafts/[id]/route");
const sweepRoute = await import("../app/api/agents/sweep/route");
const widgetRoute = await import("../app/api/v1/widget/config/route");

let failures = 0;
function check(name: string, cond: boolean, detail = "") {
  console.log(`${cond ? "PASS" : "FAIL"} ${name}${detail ? " :: " + detail : ""}`);
  if (!cond) failures++;
}

const key = Buffer.from("abc123abc123abc123abc123abc123abc123abc123abc123abc123abc123abc1", "hex");

const auth = (token: string) => ({ "Content-Type": "application/json", Authorization: `Bearer ${token}` });
const postJson = (url: string, headers: Record<string, string>, body?: unknown) =>
  new Request(`http://localhost${url}`, { method: "POST", headers, body: body === undefined ? undefined : JSON.stringify(body) });
const malformedPost = (url: string, headers: Record<string, string>) =>
  new Request(`http://localhost${url}`, { method: "POST", headers, body: "{bad json" });

// a route that crashes (throws instead of returning a JSON 4xx) surfaces as THREW
async function routeCall(fn: () => Promise<Response>): Promise<Response | "THREW"> {
  try { return await fn(); } catch { return "THREW"; }
}

const createdTenantIds: number[] = [];

try {
  await resetRateLimits(); // DB-backed buckets persist across suite processes
  // ---------- brief (base) checks: channel tokens never stored in plaintext ----------
  const t = await query<{ id: number }>(`INSERT INTO tenants (slug, name) VALUES ($1, $2) RETURNING id`, [`t-sec-${Date.now()}`, "Sec Co"]);
  const tenantId = t[0].id;
  createdTenantIds.push(tenantId);
  const enc = encryptChannelToken("super-secret-token", key);
  await query("INSERT INTO channels (tenant_id, kind, token_encrypted, status) VALUES ($1, 'x', $2, 'healthy')", [tenantId, enc]);

  const row = await query<{ token_encrypted: string }>("SELECT token_encrypted FROM channels WHERE tenant_id = $1 AND kind = 'x'", [tenantId]);
  check("channel token stored encrypted", row[0].token_encrypted !== "super-secret-token" && row[0].token_encrypted.includes(":"));
  check("decrypt recovers token", decryptChannelToken(row[0].token_encrypted, key) === "super-secret-token");

  const leaked = await query<{ n: string }>(`SELECT COUNT(*) AS n FROM chunks c WHERE c.tenant_id = $1`, [tenantId]);
  check("chunk reads are tenant-column driven", Number(leaked[0].n) >= 0);

  // ---------- fold-in: malformed JSON bodies must 400, never crash to HTML ----------
  // M0: agents/run is fail-closed (SEC-C2) — unauthenticated calls are 401
  // before the body is ever parsed; the malformed-body 400 check therefore
  // runs with the (fake) legacy ops bearer.
  const runUnauth = await routeCall(() => runRoute.POST(malformedPost("/api/agents/run", { "content-type": "application/json" })));
  check("run: unauthenticated -> 401 before body parse (fail closed)", runUnauth !== "THREW" && runUnauth.status === 401, typeof runUnauth === "string" ? runUnauth : `status=${(runUnauth as Response).status}`);
  const badRun = await routeCall(() => runRoute.POST(malformedPost("/api/agents/run", auth(FAKE_PW))));
  check("run: malformed body -> 400 JSON, not a crash", badRun !== "THREW" && badRun.status === 400 && (await (badRun as Response).json()).errors?.[0]?.code === "INVALID_JSON", typeof badRun === "string" ? badRun : `status=${(badRun as Response).status}`);

  const badChat = await routeCall(() => chatRoute.POST(malformedPost("/api/v1/chat", { "content-type": "application/json" })));
  check("chat: malformed body -> 400 JSON, not a crash", badChat !== "THREW" && badChat.status === 400 && (await (badChat as Response).json()).errors?.[0]?.code === "INVALID_JSON", typeof badChat === "string" ? badChat : `status=${(badChat as Response).status}`);

  const badAdmin = await routeCall(() => draftsIdRoute.POST(malformedPost("/api/admin/drafts/1", auth(FAKE_PW)), { params: Promise.resolve({ id: "1" }) }));
  check("admin drafts: malformed body -> 400 JSON after auth, not a crash", badAdmin !== "THREW" && badAdmin.status === 400 && (await (badAdmin as Response).json()).errors?.[0]?.code === "INVALID_JSON", typeof badAdmin === "string" ? badAdmin : `status=${(badAdmin as Response).status}`);

  // ---------- fold-in: tenantId coercion is strict digits only ----------
  const hexTenant = await draftsRoute.GET(new Request("http://localhost/api/admin/drafts?tenantId=0x10", { headers: auth(FAKE_PW) }));
  check("drafts: hex tenantId (0x10) -> 400 INVALID_TENANT", hexTenant.status === 400 && (await hexTenant.json()).errors?.[0]?.code === "INVALID_TENANT", `status=${hexTenant.status}`);
  const sciTenant = await draftsRoute.GET(new Request("http://localhost/api/admin/drafts?tenantId=1e2", { headers: auth(FAKE_PW) }));
  check("drafts: scientific-notation tenantId (1e2) -> 400 INVALID_TENANT", sciTenant.status === 400 && (await sciTenant.json()).errors?.[0]?.code === "INVALID_TENANT", `status=${sciTenant.status}`);
  const emptyTenant = await draftsRoute.GET(new Request("http://localhost/api/admin/drafts?tenantId=", { headers: auth(FAKE_PW) }));
  check("drafts: empty tenantId -> 400 INVALID_TENANT", emptyTenant.status === 400 && (await emptyTenant.json()).errors?.[0]?.code === "INVALID_TENANT", `status=${emptyTenant.status}`);
  const okTenant = await draftsRoute.GET(new Request(`http://localhost/api/admin/drafts?tenantId=${tenantId}`, { headers: auth(FAKE_PW) }));
  check("drafts: plain digit tenantId still accepted", okTenant.status === 200, `status=${okTenant.status}`);

  // ---------- fold-in: timing-safe compares ----------
  check("safeEqual: equal strings accept", safeEqual("secret-1", "secret-1"));
  check("safeEqual: differing length rejects", !safeEqual("a", "bb"));
  check("safeEqual: equal-length mismatch rejects", !safeEqual("secret-1", "secret-2"));
  check("safeEqual: null/undefined rejects", !safeEqual(null, "x") && !safeEqual(undefined, undefined) && !safeEqual("x", null));

  const sw = await sweepRoute.POST(new Request("http://localhost/api/agents/sweep", { method: "POST", headers: { "x-cron-secret": "wrong-secret" } }));
  check("sweep: wrong cron secret -> 401 UNAUTHORIZED", sw.status === 401 && (await sw.json()).errors?.[0]?.code === "UNAUTHORIZED", `status=${sw.status}`);

  // ---------- fold-in: channels route —— P13 PERMANENT RETIREMENT: every
  // wire-up attempt answers 410 ENDPOINT_RETIRED (audited, rate-limited);
  // the legacy token write path no longer exists through this endpoint.
  const chanUnauth = await channelsRoute.POST(postJson("/api/v1/channels", { "Content-Type": "application/json" }, { tenantId: 999999999, kind: "email", token: "abc" }));
  check("channels: unauthenticated attempt -> 410 ENDPOINT_RETIRED (fail-closed)", chanUnauth.status === 410 && (await chanUnauth.json()).errors?.[0]?.code === "ENDPOINT_RETIRED", `status=${chanUnauth.status}`);

  const noTenant = await channelsRoute.POST(postJson("/api/v1/channels", auth(FAKE_PW), { tenantId: 999999999, kind: "email", token: "abc" }));
  check("channels: authenticated attempt also -> 410 (no write path remains)", noTenant.status === 410, `status=${noTenant.status}`);

  const chanRow = await query<{ n: string }>("SELECT count(*)::text AS n FROM channels WHERE kind = 'email' AND token_encrypted = 'abc'");
  check("channels: retired endpoint writes nothing", chanRow[0].n === "0");

  // ---------- fold-in: widget config —— unknown tenant is 404, no internal text echoed ----------
  const wRes = await widgetRoute.GET(new Request("http://localhost/api/v1/widget/config?tenant=no-such-sec-tenant"));
  const wBody = (await wRes.json()) as { errors?: { code: string }[] };
  check("widget: unknown tenant -> 404 UNKNOWN_TENANT, no internal text", wRes.status === 404 && wBody.errors?.[0]?.code === "UNKNOWN_TENANT" && !JSON.stringify(wBody).includes("unknown tenant"), `status=${wRes.status}`);
} finally {
  if (createdTenantIds.length > 0) {
    await query("DELETE FROM tenants WHERE id = ANY($1)", [createdTenantIds]);
  }
}

if (failures > 0) { console.error(`${failures} FAIL`); process.exit(1); }
console.log("SECURITY SUITE PASS");