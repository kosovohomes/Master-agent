/**
 * Phase 6 — the signed inbound webhook route end-to-end (fail-closed matrix):
 * flag gate → site/connector 404s → signature/timestamp → capability →
 * replay → happy path (scoped source + durable task) → delivery log.
 */
import { query } from "../lib/db";
import { buildSignatureHeader, generateSigningSecret } from "../lib/connectors/crypto";
import { createWebsiteConnector, grantWebsiteCapability, setConnectorStatus } from "../lib/connectors/service";

const route = await import("../app/api/integrations/[siteId]/events/route");

let failures = 0;
function check(name: string, cond: boolean, detail = "") {
  console.log(`${cond ? "PASS" : "FAIL"} ${name}${detail ? " :: " + detail : ""}`);
  if (!cond) failures++;
}

const stamp = Date.now();
const taskKeys: string[] = [];

async function setupSite(name: string): Promise<{ buId: number; siteId: number }> {
  const [bu] = await query<{ id: number }>(
    `INSERT INTO business_units (slug, name) VALUES ($1, $2) RETURNING id`,
    [`cnr-${name}-${stamp}`, `Connector Route BU ${name}`]
  );
  const [site] = await query<{ id: number }>(
    `INSERT INTO websites (business_unit_id, slug, name, environment, status)
     VALUES ($1, $2, $3, 'production', 'active') RETURNING id`,
    [bu.id, `cnr-${name}-${stamp}`, `Connector Route Site ${name}`]
  );
  return { buId: bu.id, siteId: site.id };
}

function post(siteId: number, opts: { body?: string; signature?: string; deliveryId?: string | null }): Promise<Response> {
  const headers = new Headers({ "Content-Type": "application/json" });
  if (opts.signature !== undefined) headers.set("X-AgentOS-Signature", opts.signature);
  if (opts.deliveryId !== null) headers.set("X-AgentOS-Delivery", opts.deliveryId ?? `dlv-${stamp}-${Math.random().toString(36).slice(2, 8)}`);
  return route.POST(
    new Request(`http://localhost/api/integrations/${siteId}/events`, { method: "POST", headers, body: opts.body ?? "" }),
    { params: Promise.resolve({ siteId: String(siteId) }) }
  );
}

const bodyOf = (extra: Record<string, unknown>) => JSON.stringify({ type: "content.sync", data: { sitemapUrl: `https://route-${stamp}.example/sitemap.xml`, ...extra } });

async function cleanup() {
  const buIds = [a.buId, b.buId, c.buId];
  await query(`DELETE FROM connector_deliveries WHERE website_id IN (SELECT id FROM websites WHERE business_unit_id = ANY($1::bigint[]))`, [buIds]).catch(() => undefined);
  if (taskKeys.length > 0) await query(`DELETE FROM tasks WHERE idempotency_key = ANY($1::text[])`, [taskKeys]).catch(() => undefined);
  await query(`DELETE FROM documents WHERE knowledge_source_id IN (SELECT id FROM knowledge_sources WHERE website_id IN (SELECT id FROM websites WHERE business_unit_id = ANY($1::bigint[])))`, [buIds]).catch(() => undefined);
  await query(`DELETE FROM knowledge_sources WHERE website_id IN (SELECT id FROM websites WHERE business_unit_id = ANY($1::bigint[]))`, [buIds]).catch(() => undefined);
  await query(`DELETE FROM website_integrations WHERE website_id IN (SELECT id FROM websites WHERE business_unit_id = ANY($1::bigint[]))`, [buIds]).catch(() => undefined);
  await query(`DELETE FROM website_capabilities WHERE website_id IN (SELECT id FROM websites WHERE business_unit_id = ANY($1::bigint[]))`, [buIds]).catch(() => undefined);
  await query(`DELETE FROM websites WHERE business_unit_id = ANY($1::bigint[])`, [buIds]).catch(() => undefined);
  await query(`DELETE FROM business_units WHERE id = ANY($1::bigint[])`, [buIds]).catch(() => undefined);
}

const a = await setupSite("a");
const b = await setupSite("b");
const c = await setupSite("c");

let flagBefore = true;
try {
  const secretA = (await createWebsiteConnector({ websiteId: a.siteId, displayName: "Route test webhook" })).signingSecret;
  const secretB = (await createWebsiteConnector({ websiteId: b.siteId })).signingSecret;
  await grantWebsiteCapability(a.siteId, "READ_CONTENT", true);

  // ---------- flag gate ----------
  const saved = await query<{ enabled: boolean }>(`SELECT enabled FROM feature_flags WHERE key = 'connectors'`);
  flagBefore = saved[0]?.enabled ?? true;
  await query(`UPDATE feature_flags SET enabled = false WHERE key = 'connectors'`);
  const off = await post(a.siteId, { body: bodyOf({}) });
  check("flag OFF → 404 (endpoint does not exist)", off.status === 404, `status=${off.status}`);
  await query(`UPDATE feature_flags SET enabled = true WHERE key = 'connectors'`);

  // ---------- site / connector 404s (generic, no oracle) ----------
  check("unknown site → 404", (await post(999999, { body: bodyOf({}) })).status === 404);
  const nonNumeric = await route.POST(
    new Request("http://localhost/api/integrations/abc/events", { method: "POST", body: "" }),
    { params: Promise.resolve({ siteId: "abc" }) }
  );
  check("non-numeric siteId → 404", nonNumeric.status === 404);
  check("site without connector → 404", (await post(c.siteId, { body: bodyOf({}) })).status === 404);

  await setConnectorStatus((await query<{ id: number }>(`SELECT id FROM website_integrations WHERE website_id = $1`, [a.siteId]))[0].id, "disabled");
  check("disabled connector → 404", (await post(a.siteId, { body: bodyOf({}) })).status === 404);
  await setConnectorStatus((await query<{ id: number }>(`SELECT id FROM website_integrations WHERE website_id = $1`, [a.siteId]))[0].id, "active");

  await query(`UPDATE websites SET status = 'inactive' WHERE id = $1`, [a.siteId]);
  check("inactive website → 404", (await post(a.siteId, { body: bodyOf({}) })).status === 404);
  await query(`UPDATE websites SET status = 'active' WHERE id = $1`, [a.siteId]);

  // ---------- delivery id ----------
  const noDelivery = await post(a.siteId, { body: bodyOf({}), deliveryId: null });
  check("missing delivery id → 400 DELIVERY_ID_REQUIRED", noDelivery.status === 400 && (await noDelivery.json()).errors?.[0]?.code === "DELIVERY_ID_REQUIRED");

  // ---------- signature / timestamp ----------
  const raw = bodyOf({});
  const noSig = await post(a.siteId, { body: raw });
  check("missing signature → 401", noSig.status === 401 && (await noSig.json()).errors?.[0]?.code === "SIGNATURE_INVALID");

  const tampered = await post(a.siteId, { body: raw + " ", signature: buildSignatureHeader(secretA, raw) });
  check("tampered body → 401 (never 500/200)", tampered.status === 401);

  const wrongSecret = await post(a.siteId, { body: raw, signature: buildSignatureHeader(generateSigningSecret(), raw) });
  check("wrong secret → 401", wrongSecret.status === 401);

  const crossSite = await post(a.siteId, { body: raw, signature: buildSignatureHeader(secretB, raw) });
  check("cross-site secret → 401 (isolation holds at signature layer)", crossSite.status === 401);

  const t = Math.floor(Date.now() / 1000) - 400; // beyond 5-min window
  const stale = await post(a.siteId, { body: raw, signature: buildSignatureHeader(secretA, raw, t) });
  check("stale timestamp → 400", stale.status === 400 && (await stale.json()).errors?.[0]?.detail === "stale_timestamp");

  const badJson = await post(a.siteId, { body: "{not json", signature: buildSignatureHeader(secretA, "{not json") });
  check("invalid JSON with valid signature → 400 INVALID_JSON", badJson.status === 400 && (await badJson.json()).errors?.[0]?.code === "INVALID_JSON");

  const noType = await post(a.siteId, { body: JSON.stringify({ data: {} }), signature: buildSignatureHeader(secretA, JSON.stringify({ data: {} })) });
  check("missing event type → 400 EVENT_TYPE_REQUIRED", noType.status === 400 && (await noType.json()).errors?.[0]?.code === "EVENT_TYPE_REQUIRED");

  // ---------- capability grant (§394) ----------
  const ungranted = await post(b.siteId, { body: raw, signature: buildSignatureHeader(secretB, raw) });
  const ungrantedBody = await ungranted.json();
  check("capability not granted → 403 CAPABILITY_NOT_GRANTED (READ_CONTENT)", ungranted.status === 403 && ungrantedBody.errors?.[0]?.code === "CAPABILITY_NOT_GRANTED" && ungrantedBody.errors?.[0]?.detail === "READ_CONTENT");

  // ---------- happy path ----------
  const dlv = `cnr-dlv-${stamp}-happy`;
  const ok = await post(a.siteId, { body: raw, signature: buildSignatureHeader(secretA, raw), deliveryId: dlv });
  const okBody = await ok.json();
  check("happy path → 202 accepted with action=sync", ok.status === 202 && okBody.data?.received === true && okBody.data?.action === "sync", JSON.stringify(okBody).slice(0, 160));
  check("happy path → task spawned", typeof okBody.data?.taskId === "number" && okBody.data.taskId > 0);

  const srcRow = await query<any>(
    `SELECT id, website_id, business_unit_id, kind, ref, access_level FROM knowledge_sources WHERE website_id = $1`,
    [a.siteId]
  );
  check("happy path → source scoped to site A, sitemap, public", srcRow.length === 1 && srcRow[0].website_id === a.siteId && srcRow[0].kind === "sitemap" && srcRow[0].access_level === "public");
  taskKeys.push(`knowledge_fetch:${srcRow[0].id}:connector:${dlv}`);
  const taskRow = await query<any>(`SELECT kind, created_by, business_unit_id FROM tasks WHERE id = $1`, [okBody.data.taskId]);
  check("happy path → durable knowledge_fetch task for the site's BU", taskRow[0]?.kind === "knowledge_fetch" && taskRow[0]?.created_by === "connector" && taskRow[0]?.business_unit_id === a.buId);

  const deliveryRow = await query<any>(`SELECT status, signature_valid, task_id FROM connector_deliveries WHERE website_id = $1 AND delivery_id = $2`, [a.siteId, dlv]);
  check("happy path → delivery receipt accepted with task link", deliveryRow[0]?.status === "accepted" && deliveryRow[0]?.signature_valid === true && deliveryRow[0]?.task_id === okBody.data.taskId);

  // ---------- replay ----------
  const replay = await post(a.siteId, { body: raw, signature: buildSignatureHeader(secretA, raw), deliveryId: dlv });
  check("replay of accepted delivery → 409 DELIVERY_REPLAY", replay.status === 409 && (await replay.json()).errors?.[0]?.code === "DELIVERY_REPLAY");

  // ---------- heartbeat (no capability required) ----------
  const hb = await post(a.siteId, { body: JSON.stringify({ type: "heartbeat" }), signature: buildSignatureHeader(secretA, JSON.stringify({ type: "heartbeat" })) });
  const hbBody = await hb.json();
  check("heartbeat → 202 heartbeat (no capability needed)", hb.status === 202 && hbBody.data?.action === "heartbeat");

  // ---------- sync without fetchable targets ----------
  const empty = JSON.stringify({ type: "content.sync", data: { note: "no urls here" } });
  const emptyRes = await post(a.siteId, { body: empty, signature: buildSignatureHeader(secretA, empty) });
  check("sync without targets → 400 SYNC_TARGET_REQUIRED", emptyRes.status === 400 && (await emptyRes.json()).errors?.[0]?.code === "SYNC_TARGET_REQUIRED");

  await cleanup();
} finally {
  // restore flag + remove any residue even on failure
  await query(`UPDATE feature_flags SET enabled = $1 WHERE key = 'connectors'`, [flagBefore]).catch(() => undefined);
  await cleanup();
}

if (failures > 0) { console.error(`${failures} FAIL`); process.exit(1); }
console.log("CONNECTORS ROUTE SUITE PASS");
