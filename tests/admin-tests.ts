import { readFile } from "node:fs/promises";
import { resetRateLimits } from "../lib/security/ratelimit";

// Fake admin password BEFORE loading any admin module so no real .env.local
// value is compared, printed, or leaked to test output.
const FAKE_PW = `admin-fake-${Date.now()}`;
process.env.ADMIN_PASSWORD = FAKE_PW;

const { authorizeAdmin, listDraftsForAdmin } = await import("../lib/admin");
const listRoute = await import("../app/api/admin/drafts/route");
const actionRoute = await import("../app/api/admin/drafts/[id]/route");
const { createDraft } = await import("../lib/agents/approval");
const { query } = await import("../lib/db");

let failures = 0;
function check(name: string, cond: boolean, detail = "") {
  console.log(`${cond ? "PASS" : "FAIL"} ${name}${detail ? " :: " + detail : ""}`);
  if (!cond) failures++;
}

const auth = (token: string) => ({ "Content-Type": "application/json", Authorization: `Bearer ${token}` });
const json = (m: string, headers: Record<string, string>, body?: unknown) =>
  new Request(`http://localhost${m}`, { method: "POST", headers, body: body === undefined ? undefined : JSON.stringify(body) });

const db = {
  draftCount: async (id: number) => (await query<{ n: string }>("SELECT count(*)::text AS n FROM approvals WHERE draft_id = $1", [id]))[0].n,
  draftStatus: async (id: number) => (await query<{ status: string }>("SELECT status FROM drafts WHERE id = $1", [id]))[0]?.status,
};

const stamp = Date.now();
const createdTenantIds: number[] = [];

try {
  await resetRateLimits(); // DB-backed buckets persist across suite processes
  // ---------- pure auth helper (env injection seam) ----------
  check("authorizeAdmin: fake token accepted", authorizeAdmin(FAKE_PW) === true);
  check("authorizeAdmin: null token rejected", authorizeAdmin(null) === false);
  check("authorizeAdmin: wrong token rejected", authorizeAdmin("wrong-password") === false);
  check("authorizeAdmin: empty token rejected", authorizeAdmin("") === false);

  // ---------- seeds: tenant A (several drafts), tenant B (isolation) ----------
  const [a] = await query<{ id: number }>(
    `INSERT INTO tenants (slug, name) VALUES ($1, $2) RETURNING id`, [`t-admin-${stamp}`, "Admin Co"]
  );
  createdTenantIds.push(a.id);
  const tenantA = a.id;

  const { draftId: dUnauth } = await createDraft({ tenantId: tenantA, agent: "marketing", channel: "x", content: "pending post" });
  const { draftId: dSched } = await createDraft({ tenantId: tenantA, agent: "sales", channel: "email", content: "schedule me" });
  const { draftId: dReject } = await createDraft({ tenantId: tenantA, agent: "marketing", channel: "linkedin", content: "reject me" });
  const { draftId: dBad } = await createDraft({ tenantId: tenantA, agent: "sales", channel: "x", content: "bad action" });

  // ---------- lib level: list reads only the requested tenant ----------
  const libList = await listDraftsForAdmin(tenantA);
  check("lib: lists pending draft", libList.some((d) => d.id === dUnauth && d.status === "pending"));
  check("lib: every row belongs to tenant A", libList.every((d) => d.tenant_id === tenantA));

  const [b] = await query<{ id: number }>(
    `INSERT INTO tenants (slug, name) VALUES ($1, $2) RETURNING id`, [`t-admin-b-${stamp}`, "Tenant B"]
  );
  createdTenantIds.push(b.id);
  const tenantB = b.id;
  await createDraft({ tenantId: tenantB, agent: "marketing", channel: "x", content: "tenant B secret" });
  const bossIds = new Set((await query<{ id: number }>("SELECT id FROM drafts WHERE tenant_id = $1", [tenantB])).map((r) => r.id));
  check("lib: tenant A never sees tenant B's drafts", (await listDraftsForAdmin(tenantA)).every((d) => !bossIds.has(d.id)));

  // ---------- GET /api/admin/drafts: auth + params ----------
  const noAuth = await listRoute.GET(new Request("http://localhost/api/admin/drafts?tenantId=1"));
  check("GET: no Bearer -> 401 UNAUTHORIZED", noAuth.status === 401, `status=${noAuth.status}`);
  const badAuth = await listRoute.GET(new Request("http://localhost/api/admin/drafts?tenantId=1", { headers: auth("wrong") }));
  check("GET: wrong Bearer -> 401 UNAUTHORIZED", badAuth.status === 401, `status=${badAuth.status}`);

  const noTenant = await listRoute.GET(new Request("http://localhost/api/admin/drafts", { headers: auth(FAKE_PW) }));
  check("GET: missing tenantId -> 400 INVALID_TENANT", noTenant.status === 400 && (await noTenant.json()).errors?.[0]?.code === "INVALID_TENANT", `status=${noTenant.status}`);
  const badTenant = await listRoute.GET(new Request("http://localhost/api/admin/drafts?tenantId=abc", { headers: auth(FAKE_PW) }));
  check("GET: non-numeric tenantId -> 400 INVALID_TENANT", badTenant.status === 400 && (await badTenant.json()).errors?.[0]?.code === "INVALID_TENANT", `status=${badTenant.status}`);
  const floatTenant = await listRoute.GET(new Request("http://localhost/api/admin/drafts?tenantId=1.5", { headers: auth(FAKE_PW) }));
  check("GET: fractional tenantId -> 400 INVALID_TENANT", floatTenant.status === 400, `status=${floatTenant.status}`);

  const okList = await listRoute.GET(new Request(`http://localhost/api/admin/drafts?tenantId=${tenantA}`, { headers: auth(FAKE_PW) }));
  const okBody = (await okList.json()) as { data: { tenant_id: number; id: number }[] };
  check("GET: valid bearer -> 200 with tenant's drafts", okList.status === 200 && okBody.data?.length >= 4, JSON.stringify(okBody).slice(0, 120));
  check("GET: cross-tenant isolation at route level", okBody.data?.every((d) => d.tenant_id === tenantA));

  // ---------- POST /api/admin/drafts/[id]: auth gates first, no side effects ----------
  const noAuthPost = await actionRoute.POST(json(`/api/admin/drafts/${dUnauth}`, auth("nope"), { action: "approve" }), { params: Promise.resolve({ id: String(dUnauth) }) });
  check("POST: no Bearer -> 401, draft untouched", noAuthPost.status === 401 && (await db.draftStatus(dUnauth)) === "pending" && (await db.draftCount(dUnauth)) === "0", `status=${noAuthPost.status}`);
  const wrongPost = await actionRoute.POST(json(`/api/admin/drafts/${dUnauth}`, auth("wrong"), { action: "approve" }), { params: Promise.resolve({ id: String(dUnauth) }) });
  check("POST: wrong Bearer -> 401, draft untouched", wrongPost.status === 401 && (await db.draftStatus(dUnauth)) === "pending", `status=${wrongPost.status}`);

  // ---------- approve: pending -> approved + audit row, then dead end ----------
  const appr = await actionRoute.POST(json(`/api/admin/drafts/${dUnauth}`, auth(FAKE_PW), { action: "approve" }), { params: Promise.resolve({ id: String(dUnauth) }) });
  check("POST: approve -> 200, status approved", appr.status === 200 && (await db.draftStatus(dUnauth)) === "approved" && (await appr.json()).data?.draftId === dUnauth, `status=${appr.status}`);
  const aprRow = await query<{ decision: string }>("SELECT decision FROM approvals WHERE draft_id = $1", [dUnauth]);
  check("approve writes audit row", aprRow.length === 1 && aprRow[0].decision === "approved");
  const dbl = await actionRoute.POST(json(`/api/admin/drafts/${dUnauth}`, auth(FAKE_PW), { action: "approve" }), { params: Promise.resolve({ id: String(dUnauth) }) });
  check("POST: double-approve -> 400, no extra audit row", dbl.status === 400 && (await db.draftCount(dUnauth)) === "1", `status=${dbl.status}`);

  // ---------- schedule: illegal from pending, legal from approved ----------
  const schedEarly = await actionRoute.POST(json(`/api/admin/drafts/${dSched}`, auth(FAKE_PW), { action: "schedule" }), { params: Promise.resolve({ id: String(dSched) }) });
  check("POST: schedule from pending -> 400 (FSM-illegal, untouched)", schedEarly.status === 400 && (await db.draftStatus(dSched)) === "pending", `status=${schedEarly.status}`);
  const appr2 = await actionRoute.POST(json(`/api/admin/drafts/${dSched}`, auth(FAKE_PW), { action: "approve" }), { params: Promise.resolve({ id: String(dSched) }) });
  check("POST: approve draft 2 -> 200", appr2.status === 200, `status=${appr2.status}`);
  const sched = await actionRoute.POST(json(`/api/admin/drafts/${dSched}`, auth(FAKE_PW), { action: "schedule" }), { params: Promise.resolve({ id: String(dSched) }) });
  check("POST: schedule from approved -> 200, status scheduled", sched.status === 200 && (await db.draftStatus(dSched)) === "scheduled", `status=${sched.status}`);

  // ---------- reject: pending -> rejected (dead end, cannot be resubmitted) ----------
  const rej = await actionRoute.POST(json(`/api/admin/drafts/${dReject}`, auth(FAKE_PW), { action: "reject", comment: "wrong tone" }), { params: Promise.resolve({ id: String(dReject) }) });
  check("POST: reject -> 200, status rejected + comment stored", rej.status === 200 && (await db.draftStatus(dReject)) === "rejected", `status=${rej.status}`);
  const rejRow = await query<{ decision: string; comment: string }>("SELECT decision, comment FROM approvals WHERE draft_id = $1", [dReject]);
  check("reject writes audit row with comment", rejRow.length === 1 && rejRow[0].decision === "rejected" && rejRow[0].comment === "wrong tone");
  const resurrect = await actionRoute.POST(json(`/api/admin/drafts/${dReject}`, auth(FAKE_PW), { action: "approve" }), { params: Promise.resolve({ id: String(dReject) }) });
  check("POST: approve after reject -> 400, stays rejected (dead end)", resurrect.status === 400 && (await db.draftStatus(dReject)) === "rejected", `status=${resurrect.status}`);

  // ---------- invalid action / malformed id ----------
  const badAction = await actionRoute.POST(json(`/api/admin/drafts/${dBad}`, auth(FAKE_PW), { action: "nuke" }), { params: Promise.resolve({ id: String(dBad) }) });
  check("POST: unknown action -> 400 INVALID_ACTION, no side effect", badAction.status === 400 && (await badAction.json()).errors?.[0]?.code === "INVALID_ACTION" && (await db.draftStatus(dBad)) === "pending", `status=${badAction.status}`);
  const junkId = await actionRoute.POST(json(`/api/admin/drafts/${dBad}`, auth(FAKE_PW), { action: "approve" }), { params: Promise.resolve({ id: "abc" }) });
  check("POST: non-numeric draft id -> 400, no side effect", junkId.status === 400 && (await db.draftStatus(dBad)) === "pending", `status=${junkId.status}`);

  // ---------- Phase 1 M1: legacy dashboard auth surface is gone ----------
  const { existsSync } = await import("node:fs");
  check("admin login route removed (replaced by /api/auth/login)", !existsSync("app/api/admin/login/route.ts"));
  check("admin sessionStorage pages removed", !existsSync("app/admin/login/page.tsx") && !existsSync("app/admin/page.tsx"));

  const nextConfigSrc = await readFile("next.config.ts", "utf8");
  check("/admin bookmark redirects configured", nextConfigSrc.includes('source: "/admin"'));

  const appFiles = await listAppFiles("app");
  const appSource = (await Promise.all(appFiles.map((f) => readFile(f, "utf8")))).join("\n");
  check("no sessionStorage password storage anywhere in app/", !appSource.includes("sessionStorage.setItem") && !appSource.includes("agentos_admin_pw"));
  check("no client-side Bearer-password pattern in app/", !appSource.includes("Bearer ${pw}"));

} finally {
  if (createdTenantIds.length > 0) {
    await query("DELETE FROM tenants WHERE id = ANY($1)", [createdTenantIds]);
  }
}

if (failures > 0) { console.error(`${failures} FAIL`); process.exit(1); }
console.log("ADMIN SUITE PASS");
async function listAppFiles(dir: string): Promise<string[]> {
  const fs = await import("node:fs");
  const path = await import("node:path");
  const out: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...(await listAppFiles(full)));
    else if (/\.tsx?$/.test(entry.name)) out.push(full);
  }
  return out;
}
