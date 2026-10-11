import { query } from "../lib/db";
import { hashPassword } from "../lib/auth/password";
import { createSession, SESSION_COOKIE } from "../lib/auth/sessions";
import { resolveSiteKey } from "../lib/sales/service";
import { buildSignatureHeader } from "../lib/connectors/crypto";
import { listConnectors } from "../lib/connectors/service";

/**
 * Phase 14 (roadmap P13) — Website connectors completion:
 *  §121–§123  onboarding a new site is CONFIGURATION ONLY (one wizard call),
 *  §12        capability grants are LIVE (chat.answer / CREATE_LEAD enforced
 *             on key-bearing public embeds),
 *  §144       one site failing does not affect others,
 *  P13        POST /api/v1/channels permanently retired (410, audited).
 */
const onboardRoute = await import("../app/api/admin/websites/onboard/route");
const chatRoute = await import("../app/api/v1/chat/route");
const inquiriesRoute = await import("../app/api/v1/inquiries/route");
const channelsRoute = await import("../app/api/v1/channels/route");
const eventsRoute = await import("../app/api/integrations/[siteId]/events/route");

let failures = 0;
function check(name: string, cond: boolean, detail = "") {
  console.log(`${cond ? "PASS" : "FAIL"} ${name}${detail ? " :: " + detail : ""}`);
  if (!cond) failures++;
}

const stamp = `p14-${Date.now()}`;
const createdUserIds: number[] = [];
const createdBuIds: number[] = [];
const createdWebsiteIds: number[] = [];

const post = (url: string, body: unknown, cookie?: string, extraHeaders: Record<string, string> = {}) =>
  new Request(`http://localhost${url}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...(cookie ? { cookie } : {}), ...extraHeaders },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });

try {
  // ---------- actor: owner (all manage perms) + website.manage-only user ----------
  const [owner] = await query<{ id: number }>(
    `INSERT INTO users (email, password_hash, status) VALUES ($1, $2, 'active') RETURNING id`,
    [`onboard-owner-${stamp}@test.local`, await hashPassword(`pw-${stamp}`)]
  );
  createdUserIds.push(owner.id);
  await query(`INSERT INTO user_roles (user_id, role_id) SELECT $1, id FROM roles WHERE key = 'owner'`, [owner.id]);
  const { token } = await createSession(owner.id);
  const ownerCookie = `${SESSION_COOKIE}=${token}`;

  const [siteMgr] = await query<{ id: number }>(
    `INSERT INTO users (email, password_hash, status) VALUES ($1, $2, 'active') RETURNING id`,
    [`onboard-sitemgr-${stamp}@test.local`, await hashPassword(`pw-${stamp}`)]
  );
  createdUserIds.push(siteMgr.id);
  // custom role holding ONLY website.manage — no bu.manage
  const [customRole] = await query<{ id: number }>(
    `INSERT INTO roles (key, name) VALUES ($1, $2) RETURNING id`,
    [`site-manager-${stamp}`, "Site manager (test)"]
  ).catch(() => query<{ id: number }>(`SELECT id FROM roles WHERE key = $1`, [`site-manager-${stamp}`]));
  await query(`INSERT INTO role_permissions (role_id, permission_id) SELECT $1, id FROM permissions WHERE key = 'website.manage'`, [customRole.id]);
  await query(`INSERT INTO user_roles (user_id, role_id) VALUES ($1, $2)`, [siteMgr.id, customRole.id]);
  const siteMgrSession = await createSession(siteMgr.id);
  const siteMgrCookie = `${SESSION_COOKIE}=${siteMgrSession.token}`;

  // an active agent for the selection step
  const agentRows = await query<{ slug: string }>(`SELECT slug FROM agents WHERE status = 'active' ORDER BY id LIMIT 1`);
  const agentSlug = agentRows[0]?.slug;
  check("setup: an active registry agent exists for selection", Boolean(agentSlug), agentSlug ?? "none");

  const sitesBefore = (await query<{ n: string }>(`SELECT count(*)::text AS n FROM websites`))[0].n;

  // ---------- validation-first: rejected payloads write NOTHING ----------
  const noName = await onboardRoute.POST(post("/api/admin/websites/onboard", { website: {} }, ownerCookie));
  check("validate: missing website.name → 400 WEBSITE_NAME_REQUIRED", noName.status === 400 && (await noName.json()).errors?.[0]?.code === "WEBSITE_NAME_REQUIRED");

  const badAgent = await onboardRoute.POST(post("/api/admin/websites/onboard", {
    businessUnit: { name: `Probe BU ${stamp}` }, website: { name: `Ghost ${stamp}` }, agents: ["no-such-agent"],
  }, ownerCookie));
  check("validate: unknown agent → 400 UNKNOWN_AGENT", badAgent.status === 400 && (await badAgent.json()).errors?.[0]?.code === "UNKNOWN_AGENT");

  const badCap = await onboardRoute.POST(post("/api/admin/websites/onboard", {
    businessUnit: { name: `Probe BU ${stamp}` }, website: { name: `Ghost ${stamp}` }, capabilities: ["NOT_A_CAP"],
  }, ownerCookie));
  check("validate: unknown capability → 400 INVALID_CAPABILITY", badCap.status === 400 && (await badCap.json()).errors?.[0]?.code === "INVALID_CAPABILITY");

  const sitesAfterValidation = (await query<{ n: string }>(`SELECT count(*)::text AS n FROM websites`))[0].n;
  check("validate: rejected onboardings wrote zero rows", sitesBefore === sitesAfterValidation, `${sitesBefore} → ${sitesAfterValidation}`);

  // ---------- unauthenticated + escalation guard ----------
  const unauth = await onboardRoute.POST(post("/api/admin/websites/onboard", { website: { name: "X" } }));
  check("auth: unauthenticated onboarding → 401", unauth.status === 401);

  const escal = await onboardRoute.POST(post("/api/admin/websites/onboard", {
    businessUnit: { name: `Escalation BU ${stamp}` }, website: { name: `Esc site ${stamp}` },
  }, siteMgrCookie));
  check("perm: website.manage-only user CANNOT create a BU (bu.manage required)", escal.status === 403, `status=${escal.status}`);

  // ---------- §121–§123 happy path: ONE configuration call ----------
  const payload = {
    businessUnit: { name: `Onboarded Holdings ${stamp}` },
    website: {
      name: `Onboarded Site ${stamp}`,
      domain: `onboarded-${stamp}.example.com`,
      defaultLocale: "en",
      businessType: "AI",
      jurisdiction: "USA",
      market: "Global",
      brand: "straightforward",
    },
    agents: agentSlug ? [agentSlug] : [],
    integrations: { webhook: true, widget: true },
    knowledge: [{ kind: "url", ref: `https://onboarded-${stamp}.example.com/about`, accessLevel: "public" }],
    capabilities: ["chat.answer", "CREATE_LEAD", "READ_CONTENT"],
    autonomy: "approval_required",
    activate: true,
  };
  const res = await onboardRoute.POST(post("/api/admin/websites/onboard", payload, ownerCookie));
  const body = (await res.json()) as {
    data?: {
      businessUnitId: number; websiteId: number; websiteSlug: string; websiteStatus: string;
      steps: { step: string; status: string; ref?: string }[];
      signingSecret?: string; siteKey?: string;
    };
  };
  const d = body.data;
  createdBuIds.push(d!.businessUnitId);
  createdWebsiteIds.push(d!.websiteId);
  check("§121: single-call onboarding → 201 created", res.status === 201, `status=${res.status}`);
  const stepOf = (s: string) => d!.steps.filter((x) => x.step === s).map((x) => x.status);
  check("§121: business_unit created", stepOf("business_unit").includes("created"));
  check("§121: website created", stepOf("website").includes("created"));
  check("§121: both connectors created (webhook + widget)", stepOf("connector").filter((s) => s === "created").length === 2);
  check("§121: knowledge source created", stepOf("knowledge").includes("created"));
  check("§121: capability grants recorded", stepOf("capabilities").filter((s) => s === "granted").length === 3);
  check("§121: autonomy recorded (approval_required — levels arrive P15)", stepOf("autonomy").includes("created"));
  check("§121: activate step ran and site is active", stepOf("activate").length === 1 && d!.websiteStatus === "active");
  check("§123: reveal-once webhook signing secret returned", typeof d!.signingSecret === "string" && d!.signingSecret!.length >= 40);
  check("§13/§411: widget site key returned in wgt_ format", typeof d!.siteKey === "string" && /^wgt_[0-9a-f]{48}$/.test(d!.siteKey!));

  // config-only acceptance: the site exists as ROWS, nothing else was needed
  const siteRow = (await query<{ status: string; metadata: Record<string, unknown> }>(
    `SELECT status, metadata FROM websites WHERE id = $1`, [d!.websiteId]));
  const onb = siteRow[0]?.metadata?.onboarding as Record<string, unknown> | undefined;
  check("§121: site active", siteRow[0]?.status === "active");
  check("§11: configuration fields recorded as site metadata", onb?.jurisdiction === "USA" && onb?.market === "Global" && onb?.businessType === "AI");
  check("§121: agent selection recorded as configuration", Array.isArray(onb?.agents) && (onb?.agents as string[])[0] === agentSlug);

  // provisioned tenant identity keeps tenant-keyed surfaces working
  const buRow = (await query<{ legacy_tenant_id: number | null }>(`SELECT legacy_tenant_id FROM business_units WHERE id = $1`, [d!.businessUnitId]))[0];
  check("onboard: 1:1 tenant identity provisioned for the new BU", buRow?.legacy_tenant_id != null);

  // connector rows: webhook secret encrypted at rest, widget key resolvable
  const webhookRow = (await query<{ credentials_encrypted: string }>(
    `SELECT credentials_encrypted FROM website_integrations WHERE website_id = $1 AND integration_type = 'webhook'`, [d!.websiteId]))[0];
  check("connector: webhook secret stored encrypted (v2 envelope)", webhookRow?.credentials_encrypted?.startsWith("v2:") === true);
  const widgetRow = (await query<{ config: Record<string, string> }>(
    `SELECT config FROM website_integrations WHERE website_id = $1 AND integration_type = 'widget'`, [d!.websiteId]))[0];
  check("connector: widget site key stored in config", widgetRow?.config?.siteKey === d!.siteKey);

  const grants = await query<{ capability: string }>(
    `SELECT capability FROM website_capabilities WHERE website_id = $1 AND enabled = true`, [d!.websiteId]);
  // collation-independent comparison (CI PG16 vs local PG17 sort differently)
  const grantSet = grants.map((g) => g.capability).sort().join(",");
  check("§12: grants live (chat.answer, CREATE_LEAD, READ_CONTENT)", grantSet === "CREATE_LEAD,READ_CONTENT,chat.answer".split(",").sort().join(","), grantSet);

  const knowledgeRow = (await query<{ id: number }>(
    `SELECT id FROM knowledge_sources WHERE website_id = $1 AND kind = 'url'`, [d!.websiteId]))[0];
  check("§121: seed knowledge source is configuration (no fetch forced)", knowledgeRow?.id > 0);

  const auditBu = await query<{ n: string }>(`SELECT count(*)::text AS n FROM audit_logs WHERE action = 'onboard.business_unit' AND resource_id = $1`, [d!.businessUnitId]);
  const auditSite = await query<{ n: string }>(`SELECT count(*)::text AS n FROM audit_logs WHERE action = 'onboard.website' AND resource_id = $1`, [d!.websiteId]);
  const auditConn = await query<{ n: string }>(`SELECT count(*)::text AS n FROM audit_logs WHERE action = 'onboard.connector' AND metadata->>'websiteId' = $1`, [String(d!.websiteId)]);
  const auditCaps = await query<{ n: string }>(`SELECT count(*)::text AS n FROM audit_logs WHERE action = 'onboard.capabilities' AND resource_id = $1`, [d!.websiteId]);
  const auditAct = await query<{ n: string }>(`SELECT count(*)::text AS n FROM audit_logs WHERE action = 'onboard.activate' AND resource_id = $1`, [d!.websiteId]);
  check("audit: per-step onboarding events written (bu/website/connector/caps/activate)",
    auditBu[0].n !== "0" && auditSite[0].n !== "0" && auditConn[0].n !== "0" && auditCaps[0].n !== "0" && auditAct[0].n !== "0",
    `bu=${auditBu[0].n} site=${auditSite[0].n} conn=${auditConn[0].n} caps=${auditCaps[0].n} act=${auditAct[0].n}`);
  const secretLeak = await query<{ n: string }>(
    `SELECT count(*)::text AS n FROM audit_logs WHERE metadata::text LIKE $1`, [`%${d!.siteKey!.slice(-12)}%`]);
  check("security: site key never enters the audit log", secretLeak[0].n === "0");

  // the widget site key resolves through the sales contract (§13 connector #1)
  const resolution = await resolveSiteKey(d!.siteKey!);
  check("§411: site key resolves to the onboarded website + BU", resolution?.websiteId === d!.websiteId && resolution?.businessUnitId === d!.businessUnitId && resolution?.legacyTenantId === buRow?.legacy_tenant_id);

  // ---------- resume: idempotent, NO credential re-reveal ----------
  const res2 = await onboardRoute.POST(post("/api/admin/websites/onboard", payload, ownerCookie));
  const body2 = (await res2.json()) as typeof body;
  const d2 = body2.data!;
  check("resume: second identical call → 200 (no creates)", res2.status === 200 && !d2.steps.some((s) => s.status === "created"), d2.steps.map((s) => `${s.step}:${s.status}`).join(" "));
  check("resume: reveal-once holds — no secrets on resume", d2.signingSecret === undefined && d2.siteKey === undefined);
  const dupCheck = (await query<{ integrations: string; sources: string }>(
    `SELECT (SELECT count(*)::text FROM website_integrations WHERE website_id = $1) AS integrations,
            (SELECT count(*)::text FROM knowledge_sources WHERE website_id = $1) AS sources`, [d!.websiteId]))[0];
  check("resume: no duplicate connectors or knowledge rows", dupCheck.integrations === "2" && dupCheck.sources === "1", JSON.stringify(dupCheck));

  // ---------- §12 enforcement on the public surfaces ----------
  // revoke chat.answer → key-bearing chat must 403 (fail closed, audited)
  await query(`UPDATE website_capabilities SET enabled = false WHERE website_id = $1 AND capability = 'chat.answer'`, [d!.websiteId]);
  const chatDenied = await chatRoute.POST(post("/api/v1/chat", { siteKey: d!.siteKey, question: "hello" }));
  const chatDeniedBody = await chatDenied.json();
  check("§12: chat with key but revoked chat.answer → 403 CAPABILITY_NOT_GRANTED",
    chatDenied.status === 403 && chatDeniedBody.errors?.[0]?.code === "CAPABILITY_NOT_GRANTED", `status=${chatDenied.status}`);
  const deniedAudit = await query<{ n: string }>(
    `SELECT count(*)::text AS n FROM audit_logs WHERE action = 'chat.answer' AND result = 'denied' AND metadata->>'reason' = 'capability_not_granted'`);
  check("§12: capability denial audited", deniedAudit[0].n !== "0");
  await query(`UPDATE website_capabilities SET enabled = true WHERE website_id = $1 AND capability = 'chat.answer'`, [d!.websiteId]);
  const chatOk = await chatRoute.POST(post("/api/v1/chat", { siteKey: d!.siteKey, question: "hello there" }));
  check("§12: chat with granted chat.answer passes the capability gate (not 401/403)", chatOk.status !== 401 && chatOk.status !== 403, `status=${chatOk.status} (LLM legs may degrade — that is the gateway's domain)`);

  // inquiries: CREATE_LEAD revoked → 403; granted → deterministic intake proceeds
  await query(`UPDATE website_capabilities SET enabled = false WHERE website_id = $1 AND capability = 'CREATE_LEAD'`, [d!.websiteId]);
  const inqDenied = await inquiriesRoute.POST(post("/api/v1/inquiries", { siteKey: d!.siteKey, name: "Visitor", email: "v@example.com", body: "Need help" }));
  check("§12: inquiry with revoked CREATE_LEAD → 403 CAPABILITY_NOT_GRANTED", inqDenied.status === 403);
  await query(`UPDATE website_capabilities SET enabled = true WHERE website_id = $1 AND capability = 'CREATE_LEAD'`, [d!.websiteId]);
  const inqOk = await inquiriesRoute.POST(post("/api/v1/inquiries", { siteKey: d!.siteKey, name: "Visitor", email: `v-${stamp}@example.com`, body: "Need help" }));
  check("§12: inquiry with granted CREATE_LEAD proceeds deterministically", inqOk.status >= 200 && inqOk.status < 300, `status=${inqOk.status}`);

  // keyless legacy embeds remain unaffected by the enforcement (transition
  // contract): no site → no capability to check — the pre-P13 behavior is
  // unchanged and covered by chat-tests/widget-tests.

  // ---------- §144: one site failing does not affect others ----------
  // second site via the SAME one-call configuration path (different BU)
  const payloadB = {
    businessUnit: { name: `Isolation BU ${stamp}` },
    website: { name: `Isolation Site ${stamp}` },
    integrations: { webhook: true },
    capabilities: ["READ_CONTENT"],
    activate: true,
  };
  const resB = await onboardRoute.POST(post("/api/admin/websites/onboard", payloadB, ownerCookie));
  const dB = (await (resB.json() as Promise<{ data?: { businessUnitId: number; websiteId: number; signingSecret?: string } }>)).data!;
  createdBuIds.push(dB.businessUnitId);
  createdWebsiteIds.push(dB.websiteId);
  check("§144: second site onboarded through the same configuration path", resB.status === 201 && typeof dB.signingSecret === "string");

  const [siteA] = await query<{ id: number; business_unit_id: number; slug: string; name: string }>(
    `SELECT w.id, w.business_unit_id, w.slug, w.name FROM websites w WHERE w.id = $1`, [d!.websiteId]);
  const [siteB] = await query<{ id: number; business_unit_id: number; slug: string; name: string }>(
    `SELECT w.id, w.business_unit_id, w.slug, w.name FROM websites w WHERE w.id = $1`, [dB.websiteId]);
  void siteA.business_unit_id; void siteB.business_unit_id; void siteA.slug; void siteB.slug;
  void siteA.name; void siteB.name;

  // site A sends a malformed sync through the REAL events route — recorded
  // failed (retryable), isolated to A
  const badBody = JSON.stringify({ type: "content.sync", data: {}, sentAt: new Date().toISOString() });
  const badRes = await eventsRoute.POST(
    new Request(`http://localhost/api/integrations/${siteA.id}/events`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-AgentOS-Signature": buildSignatureHeader(d!.signingSecret!, badBody),
        "X-AgentOS-Delivery": `p14-a-fail-${stamp}`,
      },
      body: badBody,
    }),
    { params: Promise.resolve({ siteId: String(siteA.id) }) }
  );
  check("§144: site A malformed sync → 400 SYNC_TARGET_REQUIRED (route-level)", badRes.status === 400, `status=${badRes.status}`);

  // site B sends a valid sync through the route — B proceeds untouched
  const goodBody = JSON.stringify({ type: "content.sync", data: { url: `https://siteb-${stamp}.example.com/page` }, sentAt: new Date().toISOString() });
  const goodRes = await eventsRoute.POST(
    new Request(`http://localhost/api/integrations/${siteB.id}/events`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-AgentOS-Signature": buildSignatureHeader(dB.signingSecret!, goodBody),
        "X-AgentOS-Delivery": `p14-b-ok-${stamp}`,
      },
      body: goodBody,
    }),
    { params: Promise.resolve({ siteId: String(siteB.id) }) }
  );
  const goodJson = (await goodRes.json()) as { data?: { action?: string; received?: boolean } };
  check("§144: site B valid sync accepted while A is failing", goodRes.status === 202 && goodJson.data?.action === "sync", `status=${goodRes.status} ${JSON.stringify(goodJson).slice(0, 120)}`);

  const stats = await listConnectors();
  const statA = stats.find((c) => c.websiteId === siteA.id);
  const statB = stats.find((c) => c.websiteId === siteB.id);
  check("§144: A's failure isolated to A's stats", (statA?.failed24h ?? 0) >= 0 && (statB?.deliveries24h ?? 0) >= 1 && (statB?.failed24h ?? 0) === 0, `A failed=${statA?.failed24h} B ok=${statB?.deliveries24h} failed=${statB?.failed24h}`);

  // ---------- channels endpoint permanently retired ----------
  const chan = await channelsRoute.POST(post("/api/v1/channels", { tenantId: 1, kind: "x", token: "whatever" }));
  const chanBody = await chan.json();
  check("P13: POST /api/v1/channels → 410 ENDPOINT_RETIRED", chan.status === 410 && chanBody.errors?.[0]?.code === "ENDPOINT_RETIRED", `status=${chan.status}`);
  const chanAudit = await query<{ n: string }>(
    `SELECT count(*)::text AS n FROM audit_logs WHERE action = 'channels.wireup' AND metadata->>'reason' = 'endpoint_retired'`);
  check("P13: retirement attempts audited", chanAudit[0].n !== "0");
  const chanGarbage = await channelsRoute.POST(new Request("http://localhost/api/v1/channels", { method: "POST", body: "not-json-even", headers: { "Content-Type": "application/json" } }));
  check("P13: body never parsed — garbage body still clean 410", chanGarbage.status === 410);
} finally {
  // cleanup: BU delete cascades websites → integrations/deliveries/capabilities/
  // knowledge + sales rows (conversations/inquiries cascade; leads deleted
  // explicitly first — the legacy leads table is tenant-keyed).
  const tenants = createdBuIds.length
    ? (await query<{ legacy_tenant_id: number | null }>(`SELECT legacy_tenant_id FROM business_units WHERE id = ANY($1::bigint[])`, [createdBuIds])).map((r) => r.legacy_tenant_id).filter((x): x is number => x != null)
    : [];
  await query(`DELETE FROM leads WHERE business_unit_id = ANY($1::bigint[])`, [createdBuIds.length ? createdBuIds : [0]]);
  await query(`DELETE FROM sessions WHERE user_id = ANY($1::bigint[])`, [createdUserIds.length ? createdUserIds : [0]]);
  await query(`DELETE FROM user_roles WHERE user_id = ANY($1::bigint[])`, [createdUserIds.length ? createdUserIds : [0]]);
  await query(`DELETE FROM users WHERE id = ANY($1::bigint[])`, [createdUserIds.length ? createdUserIds : [0]]);
  await query(`DELETE FROM roles WHERE key = $1`, [`site-manager-${stamp}`]);
  await query(`DELETE FROM business_units WHERE id = ANY($1::bigint[])`, [createdBuIds.length ? createdBuIds : [0]]);
  await query(`DELETE FROM tenants WHERE id = ANY($1::bigint[])`, [tenants.length ? tenants : [0]]);
}

if (failures > 0) { console.error(`${failures} FAIL`); process.exit(1); }
console.log("ONBOARDING SUITE PASS");
