import { query } from "../lib/db";
import {
  ensureLegacyMapping,
  buForLegacyTenantId,
  legacyTenantIdForBu,
  createBusinessUnit,
  createWebsite,
  listWebsites,
  permittedLegacyTenantIds,
} from "../lib/bu";
import { getWidgetConfig } from "../lib/widget";
import { hashPassword } from "../lib/auth/password";
import { createSession, SESSION_COOKIE } from "../lib/auth/sessions";
import { createDraft } from "../lib/agents/approval";

/**
 * Business Units + Websites (Phase 1 M2 acceptance: two BUs and two websites
 * coexist; legacy tenant mapping is 1:1 and idempotent; the widget still
 * resolves the legacy tenant; cross-BU access is denied server-side).
 */
const draftsRoute = await import("../app/api/admin/drafts/route");

let failures = 0;
function check(name: string, cond: boolean, detail = "") {
  console.log(`${cond ? "PASS" : "FAIL"} ${name}${detail ? " :: " + detail : ""}`);
  if (!cond) failures++;
}

const stamp = Date.now();
const createdTenantIds: number[] = [];
const createdUserIds: number[] = [];
const createdBuIds: number[] = [];

const get = (m: string, cookie: string) => new Request(`http://localhost${m}`, { headers: { cookie } });

try {
  // ---------- legacy tenant -> BU/website mapping (idempotent 1:1) ----------
  const [t] = await query<{ id: number }>(
    `INSERT INTO tenants (slug, name) VALUES ($1, $2) RETURNING id`,
    [`bu-legacy-${stamp}`, "BU Legacy Co"]
  );
  createdTenantIds.push(t.id);
  await query(
    `INSERT INTO tenant_config (tenant_id, brand_voice, persona, audience) VALUES ($1, $2, $3, $4)`,
    [t.id, "warm voice", "builder persona", "families"]
  );

  const map1 = await ensureLegacyMapping(t.id);
  const map2 = await ensureLegacyMapping(t.id);
  check("mapping: idempotent (same BU/website ids)", map1.businessUnitId === map2.businessUnitId && map1.websiteId === map2.websiteId);
  createdBuIds.push(map1.businessUnitId);

  const bu = await buForLegacyTenantId(t.id);
  check("mapping: BU found by legacy tenant id", bu?.id === map1.businessUnitId);
  check("mapping: brand fields copied from tenant_config", bu?.brandVoice === "warm voice" && bu?.persona === "builder persona" && bu?.audience === "families");
  check("mapping: BU slug mirrors tenant slug", bu?.slug === `bu-legacy-${stamp}`);
  const backTenant = await legacyTenantIdForBu(map1.businessUnitId);
  check("mapping: reverse lookup BU -> legacy tenant id", backTenant === t.id);

  const websitesForBu = await listWebsites(map1.businessUnitId);
  check("mapping: exactly one default website per legacy BU", websitesForBu.length === 1);

  // ---------- widget compatibility (the live contract must not blink) ----------
  const bySlug = await getWidgetConfig(`bu-legacy-${stamp}`);
  const byNumeric = await getWidgetConfig(String(t.id));
  check("widget: slug resolution unchanged", bySlug.tenantId === t.id && bySlug.brand === "BU Legacy Co");
  check("widget: numeric legacy id resolution unchanged", byNumeric.tenantId === t.id);

  // ---------- two BUs + two websites coexist (config rows only) ----------
  const buSecond = await createBusinessUnit({ name: `Second BU ${stamp}`, brandVoice: "second voice" });
  createdBuIds.push(buSecond.id);
  const siteSecond = await createWebsite({ businessUnitId: buSecond.id, name: `Second site ${stamp}`, domain: `second-${stamp}.example.com` });
  check("config-only: second BU + second website created without code changes", Boolean(buSecond.id && siteSecond.id) && buSecond.id !== map1.businessUnitId);

  const siteForLegacy = await createWebsite({ businessUnitId: map1.businessUnitId, name: `Legacy extra site ${stamp}` });
  check("websites: legacy BU can hold multiple sites", (await listWebsites(map1.businessUnitId)).length === 2);
  void siteForLegacy;

  // ---------- cross-BU denial (server-side scoping) ----------
  const [tB] = await query<{ id: number }>(
    `INSERT INTO tenants (slug, name) VALUES ($1, $2) RETURNING id`,
    [`bu-other-${stamp}`, "BU Other Co"]
  );
  createdTenantIds.push(tB.id);
  await createDraft({ tenantId: tB.id, agent: "sales", channel: "x", content: "out of scope draft" });

  const hash = await hashPassword(`pw-${stamp}`);
  const [scopedUser] = await query<{ id: number }>(
    `INSERT INTO users (email, password_hash, status) VALUES ($1, $2, 'active') RETURNING id`,
    [`bu-scoped-${stamp}@test.local`, hash]
  );
  createdUserIds.push(scopedUser.id);
  await query(`INSERT INTO user_roles (user_id, role_id, business_unit_id) SELECT $1, id, $2 FROM roles WHERE key = 'reviewer'`, [scopedUser.id, map1.businessUnitId]);
  const { token } = await createSession(scopedUser.id);

  const scope = await permittedLegacyTenantIds(scopedUser.id);
  check("scope: scoped user resolves to exactly their BU's legacy tenant", scope.kind === "list" && scope.tenantIds.length === 1 && scope.tenantIds[0] === t.id, JSON.stringify(scope));

  const inScope = await draftsRoute.GET(get(`/api/admin/drafts?tenantId=${t.id}`, `${SESSION_COOKIE}=${token}`));
  check("scope: in-scope drafts read -> 200", inScope.status === 200, `status=${inScope.status}`);
  const outScope = await draftsRoute.GET(get(`/api/admin/drafts?tenantId=${tB.id}`, `${SESSION_COOKIE}=${token}`));
  check("scope: other BU tenant -> 403 BU_SCOPE_DENIED", outScope.status === 403, `status=${outScope.status}`);

  // draft in own tenant visible through the scoped route
  await createDraft({ tenantId: t.id, agent: "marketing", channel: "x", content: "visible to scoped reviewer" });
  const own = (await (await draftsRoute.GET(get(`/api/admin/drafts?tenantId=${t.id}`, `${SESSION_COOKIE}=${token}`))).json()) as { data?: unknown[] };
  check("scope: own-BU draft listed", (own.data ?? []).length >= 1);
} finally {
  await query("DELETE FROM sessions WHERE user_id = ANY($1)", [createdUserIds.length ? createdUserIds : [0]]);
  await query("DELETE FROM users WHERE id = ANY($1)", [createdUserIds.length ? createdUserIds : [0]]);
  // restrict-ordered teardown: BU children, BUs (legacy mapping), then tenants
  await query("DELETE FROM websites WHERE business_unit_id = ANY($1)", [createdBuIds.length ? createdBuIds : [0]]);
  await query("DELETE FROM business_units WHERE id = ANY($1)", [createdBuIds.length ? createdBuIds : [0]]);
  await query("DELETE FROM tenants WHERE id = ANY($1)", [createdTenantIds.length ? createdTenantIds : [0]]);
  await query("DELETE FROM audit_logs WHERE actor_id = ANY($1)", [createdUserIds.length ? createdUserIds : [0]]);
}

if (failures > 0) { console.error(`${failures} FAIL`); process.exit(1); }
console.log("BU-WEBSITE SUITE PASS");
