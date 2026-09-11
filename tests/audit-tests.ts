import { query } from "../lib/db";
import { writeAudit, sanitizeMetadata } from "../lib/audit";
import { hashPassword } from "../lib/auth/password";
import { createSession, SESSION_COOKIE } from "../lib/auth/sessions";
import { createDraft } from "../lib/agents/approval";

/**
 * Audit trail (Phase 1 M0 — SEC-C5 acceptance: every admin mutation appears
 * in audit_logs with the authenticated actor; secrets never recorded).
 */
const channelsRoute = await import("../app/api/v1/channels/route");
const draftsActionRoute = await import("../app/api/admin/drafts/[id]/route");
const buRoute = await import("../app/api/admin/business-units/route");
const usersRoute = await import("../app/api/admin/users/route");

let failures = 0;
function check(name: string, cond: boolean, detail = "") {
  console.log(`${cond ? "PASS" : "FAIL"} ${name}${detail ? " :: " + detail : ""}`);
  if (!cond) failures++;
}

const stamp = Date.now();
const createdTenantIds: number[] = [];
const createdUserIds: number[] = [];
const createdBuIds: number[] = [];
const testEmails: string[] = [];

const post = (m: string, headers: Record<string, string>, body?: unknown) =>
  new Request(`http://localhost${m}`, { method: "POST", headers, body: body === undefined ? undefined : JSON.stringify(body) });

async function latestAudit(action: string): Promise<any | null> {
  const rows = await query<any>(
    "SELECT * FROM audit_logs WHERE action = $1 ORDER BY id DESC LIMIT 1",
    [action]
  );
  return rows[0] ?? null;
}

try {
  const FAKE_PW = `audit-ops-${stamp}`;
  process.env.ADMIN_PASSWORD = FAKE_PW;

  // seed a reviewer session user + a draft to act on
  const hash = await hashPassword(`pw-${stamp}`);
  const [u] = await query<{ id: number }>(
    `INSERT INTO users (email, password_hash, status) VALUES ($1, $2, 'active') RETURNING id`,
    [`audit-reviewer-${stamp}@test.local`, hash]
  );
  createdUserIds.push(u.id);
  testEmails.push(`audit-reviewer-${stamp}@test.local`);
  await query(`INSERT INTO user_roles (user_id, role_id) SELECT $1, id FROM roles WHERE key = 'reviewer'`, [u.id]);
  const { token } = await createSession(u.id);
  const cookie = `${SESSION_COOKIE}=${token}`;

  const [t] = await query<{ id: number }>(`INSERT INTO tenants (slug, name) VALUES ($1, $2) RETURNING id`, [`audit-${stamp}`, "Audit Co"]);
  createdTenantIds.push(t.id);
  const { draftId } = await createDraft({ tenantId: t.id, agent: "marketing", channel: "x", content: "audit me" });

  // ---------- legacy bearer action -> system actor recorded ----------
  await draftsActionRoute.POST(
    post(`/api/admin/drafts/${draftId}`, { "Content-Type": "application/json", Authorization: `Bearer ${FAKE_PW}` }, { action: "approve" }),
    { params: Promise.resolve({ id: String(draftId) }) }
  );
  const legacyRow = await latestAudit("draft.approve");
  check("draft.approve audited", Boolean(legacyRow));
  check("legacy bearer actor recorded as system/ops:bearer", legacyRow?.actor_type === "system" && legacyRow?.actor_label === "ops:bearer", JSON.stringify({ type: legacyRow?.actor_type, label: legacyRow?.actor_label }));
  check("resource + id captured", legacyRow?.resource === "drafts" && legacyRow?.resource_id === String(draftId));
  check("request id present", typeof legacyRow?.request_id === "string" && legacyRow.request_id.length > 0);

  // ---------- session action -> user actor recorded ----------
  const { draftId: d2 } = await createDraft({ tenantId: t.id, agent: "sales", channel: "email", content: "audit me too" });
  await draftsActionRoute.POST(
    post(`/api/admin/drafts/${d2}`, { "Content-Type": "application/json", cookie }, { action: "approve" }),
    { params: Promise.resolve({ id: String(d2) }) }
  );
  const userRow = await latestAudit("draft.approve");
  check("session action audited with authenticated actor", userRow?.actor_type === "user" && userRow?.actor_id === u.id, `actor_id=${userRow?.actor_id}`);

  // ---------- denied mutation audited ----------
  await channelsRoute.POST(post("/api/v1/channels", { "Content-Type": "application/json" }, { tenantId: t.id, kind: "email", token: "x" }));
  const deniedRow = await latestAudit("channels.wireup");
  check("unauthenticated channels mutation audited as denied", deniedRow?.result === "denied", `result=${deniedRow?.result}`);
  check("denied row leaks no credentials", !JSON.stringify(deniedRow).includes("token"));

  // ---------- bu.create audited with user actor ----------
  const [owner] = await query<{ id: number }>(
    `INSERT INTO users (email, password_hash, status) VALUES ($1, $2, 'active') RETURNING id`,
    [`audit-owner-${stamp}@test.local`, hash]
  );
  createdUserIds.push(owner.id);
  testEmails.push(`audit-owner-${stamp}@test.local`);
  await query(`INSERT INTO user_roles (user_id, role_id) SELECT $1, id FROM roles WHERE key = 'owner'`, [owner.id]);
  const { token: ownerToken } = await createSession(owner.id);
  const buRes = await buRoute.POST(
    post("/api/admin/business-units", { "Content-Type": "application/json", cookie: `${SESSION_COOKIE}=${ownerToken}` }, { name: `Audit BU ${stamp}` })
  );
  const buBody = (await buRes.json()) as { data?: { id: number } };
  if (buBody.data?.id) createdBuIds.push(buBody.data.id);
  const buRow = await latestAudit("bu.create");
  check("bu.create audited with owner actor", buRow?.actor_id === owner.id && buRow?.result === "success", `actor=${buRow?.actor_id}`);

  // ---------- users.create audited (owner acting) ----------
  const inviteeRes = await usersRoute.POST(
    post("/api/admin/users", { "Content-Type": "application/json", cookie: `${SESSION_COOKIE}=${ownerToken}` }, { email: `audit-invitee-${stamp}@test.local`, role: "operator" })
  );
  const invitee = (await inviteeRes.json()) as { data?: { userId?: number; initialPassword?: string } };
  if (invitee.data?.userId) createdUserIds.push(invitee.data.userId);
  const userAuditRow = await latestAudit("users.create");
  check("users.create audited", userAuditRow?.actor_id === owner.id && userAuditRow?.resource === "users");
  check("generated initial password NEVER stored in audit metadata", !JSON.stringify(userAuditRow).includes(invitee.data?.initialPassword ?? "__unset__"));

  // ---------- metadata sanitization ----------
  const sanitized = sanitizeMetadata({ password: "hunter2", nested: { apiKey: "sk-123", note: "safe" }, tokens: ["a"], ok: 1 });
  check("sanitize: top-level secret key redacted", (sanitized as any)?.password === "[redacted]");
  check("sanitize: nested api key redacted", (sanitized as any)?.nested?.apiKey === "[redacted]" && (sanitized as any)?.nested?.note === "safe");
  check("sanitize: token-shaped key redacted", (sanitized as any)?.tokens === "[redacted]");

  const writeWithSecrets = { password: "hunter2", apiKey: "sk-xyz" };
  await writeAudit({ actorType: "system", actorLabel: "audit-test", action: "audit.sanitize_probe", result: "success", metadata: writeWithSecrets });
  const probe = await latestAudit("audit.sanitize_probe");
  check("writeAudit: secrets redacted at write time", !JSON.stringify(probe?.metadata).includes("hunter2") && !JSON.stringify(probe?.metadata).includes("sk-xyz"));
} finally {
  await query("DELETE FROM sessions WHERE user_id = ANY($1)", [createdUserIds.length ? createdUserIds : [0]]);
  await query("DELETE FROM users WHERE id = ANY($1)", [createdUserIds.length ? createdUserIds : [0]]);
  await query("DELETE FROM websites WHERE business_unit_id = ANY($1)", [createdBuIds.length ? createdBuIds : [0]]);
  await query("DELETE FROM business_units WHERE id = ANY($1)", [createdBuIds.length ? createdBuIds : [0]]);
  await query("DELETE FROM tenants WHERE id = ANY($1)", [createdTenantIds.length ? createdTenantIds : [0]]);
  await query("DELETE FROM audit_logs WHERE actor_label = ANY($1) OR action = 'audit.sanitize_probe'", [testEmails.length ? testEmails : ["__none__"]]);
}

if (failures > 0) { console.error(`${failures} FAIL`); process.exit(1); }
console.log("AUDIT SUITE PASS");
