import { query } from "../lib/db";
import { hashPassword } from "../lib/auth/password";
import { createSession, SESSION_COOKIE } from "../lib/auth/sessions";
import { createDraft } from "../lib/agents/approval";

/**
 * RBAC role × route denial matrix (Phase 1 M1 acceptance: two users with
 * different roles demonstrate different permissions — enforced server-side).
 */
const buRoute = await import("../app/api/admin/business-units/route");
const usersRoute = await import("../app/api/admin/users/route");
const auditRoute = await import("../app/api/admin/audit/route");
const draftsRoute = await import("../app/api/admin/drafts/route");
const draftActionRoute = await import("../app/api/admin/drafts/[id]/route");

let failures = 0;
function check(name: string, cond: boolean, detail = "") {
  console.log(`${cond ? "PASS" : "FAIL"} ${name}${detail ? " :: " + detail : ""}`);
  if (!cond) failures++;
}

const post = (m: string, cookie: string, body?: unknown) =>
  new Request(`http://localhost${m}`, { method: "POST", headers: { "Content-Type": "application/json", cookie }, body: body === undefined ? undefined : JSON.stringify(body) });
const patch = (m: string, cookie: string, body?: unknown) =>
  new Request(`http://localhost${m}`, { method: "PATCH", headers: { "Content-Type": "application/json", cookie }, body: body === undefined ? undefined : JSON.stringify(body) });
const get = (m: string, cookie: string) => new Request(`http://localhost${m}`, { headers: { cookie } });

const stamp = Date.now();
const createdUserIds: number[] = [];
const createdTenantIds: number[] = [];
const createdBuIds: number[] = [];

let makeUserSeq = 0;
async function makeUser(roleKey: string, buId: number | null): Promise<{ id: number; cookie: string }> {
  makeUserSeq += 1;
  const hash = await hashPassword(`pw-${roleKey}-${stamp}`);
  const [u] = await query<{ id: number }>(
    `INSERT INTO users (email, password_hash, status) VALUES ($1, $2, 'active') RETURNING id`,
    [`rbac-${roleKey}-${stamp}-${makeUserSeq}@test.local`, hash]
  );
  createdUserIds.push(u.id);
  await query(
    `INSERT INTO user_roles (user_id, role_id, business_unit_id) SELECT $1, id, $2 FROM roles WHERE key = $3`,
    [u.id, buId, roleKey]
  );
  const { token } = await createSession(u.id);
  return { id: u.id, cookie: `${SESSION_COOKIE}=${token}` };
}

async function makeTenantWithBu(slug: string): Promise<{ tenantId: number; buId: number }> {
  const [t] = await query<{ id: number }>(`INSERT INTO tenants (slug, name) VALUES ($1, $2) RETURNING id`, [slug, `RBAC ${slug}`]);
  createdTenantIds.push(t.id);
  const [bu] = await query<{ id: number }>(
    `INSERT INTO business_units (slug, name, legacy_tenant_id) VALUES ($1, $2, $3) RETURNING id`,
    [slug, `RBAC ${slug}`, t.id]
  );
  createdBuIds.push(bu.id);
  return { tenantId: t.id, buId: bu.id };
}

try {
  const owner = await makeUser("owner", null);
  const admin = await makeUser("administrator", null);
  const operator = await makeUser("operator", null);
  const reviewer = await makeUser("reviewer", null);

  const buA = await makeTenantWithBu(`rbac-a-${stamp}`);
  const buB = await makeTenantWithBu(`rbac-b-${stamp}`);

  const NO = "";

  // ---------- unauthenticated: fail closed everywhere ----------
  check("anon: GET business-units -> 401", (await buRoute.GET(get("/api/admin/business-units", NO))).status === 401);
  check("anon: POST business-units -> 401", (await buRoute.POST(post("/api/admin/business-units", NO, { name: "X" }))).status === 401);
  check("anon: GET users -> 401", (await usersRoute.GET(get("/api/admin/users", NO))).status === 401);
  check("anon: GET audit -> 401", (await auditRoute.GET(get("/api/admin/audit", NO))).status === 401);
  check("anon: GET drafts -> 401", (await draftsRoute.GET(get("/api/admin/drafts", NO))).status === 401);

  // ---------- owner vs reviewer: the Phase 1 acceptance pair ----------
  const createRes = await buRoute.POST(post("/api/admin/business-units", owner.cookie, { name: `Owner BU ${stamp}` }));
  const createBody = (await createRes.json()) as { data?: { id: number } };
  check("owner: bu.manage -> create BU 200", createRes.status === 200 && typeof createBody.data?.id === "number", `status=${createRes.status}`);
  if (createBody.data?.id) createdBuIds.push(createBody.data.id);

  const reviewerCreate = await buRoute.POST(post("/api/admin/business-units", reviewer.cookie, { name: `Reviewer BU ${stamp}` }));
  check("reviewer: bu.manage denied -> 403", reviewerCreate.status === 403, `status=${reviewerCreate.status}`);

  const reviewerUsers = await usersRoute.GET(get("/api/admin/users", reviewer.cookie));
  check("reviewer: users.manage denied -> 403 (owner-only)", reviewerUsers.status === 403, `status=${reviewerUsers.status}`);
  const ownerUsers = await usersRoute.GET(get("/api/admin/users", owner.cookie));
  check("owner: users.manage allowed -> 200", ownerUsers.status === 200, `status=${ownerUsers.status}`);

  const reviewerAudit = await auditRoute.GET(get("/api/admin/audit", reviewer.cookie));
  check("reviewer: audit.read denied -> 403", reviewerAudit.status === 403, `status=${reviewerAudit.status}`);
  const ownerAudit = await auditRoute.GET(get("/api/admin/audit", owner.cookie));
  check("owner: audit.read allowed -> 200", ownerAudit.status === 200, `status=${ownerAudit.status}`);

  const adminFlags = await import("../app/api/admin/settings/route");
  const adminGet = await adminFlags.GET(get("/api/admin/settings", admin.cookie));
  check("administrator: settings.read allowed -> 200", adminGet.status === 200, `status=${adminGet.status}`);
  const reviewerSettings = await adminFlags.GET(get("/api/admin/settings", reviewer.cookie));
  check("reviewer: settings access denied -> 403", reviewerSettings.status === 403, `status=${reviewerSettings.status}`);

  // ---------- drafts actions: approve vs schedule separation ----------
  const { draftId: dPending } = await createDraft({ tenantId: buA.tenantId, agent: "marketing", channel: "x", content: "rbac approve me" });
  const { draftId: dApproved } = await createDraft({ tenantId: buA.tenantId, agent: "marketing", channel: "x", content: "rbac schedule me" });
  await query("UPDATE drafts SET status = 'approved' WHERE id = $1", [dApproved]);

  const reviewerApprove = await draftActionRoute.POST(post(`/api/admin/drafts/${dPending}`, reviewer.cookie, { action: "approve" }), { params: Promise.resolve({ id: String(dPending) }) });
  check("reviewer: drafts.approve allowed -> 200", reviewerApprove.status === 200, `status=${reviewerApprove.status}`);

  const reviewerSchedule = await draftActionRoute.POST(post(`/api/admin/drafts/${dApproved}`, reviewer.cookie, { action: "schedule" }), { params: Promise.resolve({ id: String(dApproved) }) });
  check("reviewer: drafts.schedule denied -> 403", reviewerSchedule.status === 403, `status=${reviewerSchedule.status}`);

  const operatorSchedule = await draftActionRoute.POST(
    post(`/api/admin/drafts/${dApproved}`, operator.cookie, { action: "schedule" }),
    { params: Promise.resolve({ id: String(dApproved) }) }
  );
  check("operator: drafts.schedule allowed -> 200", operatorSchedule.status === 200, `status=${operatorSchedule.status}`);

  const { draftId: dOp2 } = await createDraft({ tenantId: buB.tenantId, agent: "sales", channel: "x", content: "operator cannot approve" });
  const operatorApprove = await draftActionRoute.POST(post(`/api/admin/drafts/${dOp2}`, operator.cookie, { action: "approve" }), { params: Promise.resolve({ id: String(dOp2) }) });
  check("operator: drafts.approve denied -> 403", operatorApprove.status === 403, `status=${operatorApprove.status}`);

  // ---------- BU-scoped reads ----------
  const scopedReviewer = await makeUser("reviewer", buA.buId);
  const inScope = await draftsRoute.GET(get(`/api/admin/drafts?tenantId=${buA.tenantId}`, scopedReviewer.cookie));
  check("scoped reviewer: own BU drafts -> 200", inScope.status === 200, `status=${inScope.status}`);
  const outScope = await draftsRoute.GET(get(`/api/admin/drafts?tenantId=${buB.tenantId}`, scopedReviewer.cookie));
  check("scoped reviewer: other BU drafts -> 403 BU_SCOPE_DENIED", outScope.status === 403 && (await outScope.json()).errors?.[0]?.code === "BU_SCOPE_DENIED", `status=${outScope.status}`);
  const scopedBuList = await buRoute.GET(get("/api/admin/business-units", scopedReviewer.cookie));
  const scopedBuBody = (await scopedBuList.json()) as { data?: { id: number }[] };
  check("scoped reviewer: BU list narrowed to assigned BU", scopedBuList.status === 200 && (scopedBuBody.data ?? []).length >= 1 && (scopedBuBody.data ?? []).every((b) => b.id === buA.buId), `count=${(scopedBuBody.data ?? []).length}`);

  // reviewer identity recorded (approve earlier wrote approvals.reviewer_user_id)
  const appr = await query<{ reviewer_user_id: number | null }>("SELECT reviewer_user_id FROM approvals WHERE draft_id = $1", [dPending]);
  check("approve: reviewer_user_id recorded from session", appr[0]?.reviewer_user_id === reviewer.id, `reviewer=${appr[0]?.reviewer_user_id}`);
} finally {
  await query("DELETE FROM sessions WHERE user_id = ANY($1)", [createdUserIds.length ? createdUserIds : [0]]);
  await query("DELETE FROM users WHERE id = ANY($1)", [createdUserIds.length ? createdUserIds : [0]]);
  await query("DELETE FROM websites WHERE business_unit_id = ANY($1)", [createdBuIds.length ? createdBuIds : [0]]);
  await query("DELETE FROM business_units WHERE id = ANY($1)", [createdBuIds.length ? createdBuIds : [0]]);
  await query("DELETE FROM tenants WHERE id = ANY($1)", [createdTenantIds.length ? createdTenantIds : [0]]);
  await query("DELETE FROM audit_logs WHERE actor_id = ANY($1) OR resource_id = ANY($2::text[])", [createdUserIds.length ? createdUserIds : [0], createdBuIds.map(String).length ? createdBuIds.map(String) : ["__none__"]]);
}

if (failures > 0) { console.error(`${failures} FAIL`); process.exit(1); }
console.log("RBAC SUITE PASS");
