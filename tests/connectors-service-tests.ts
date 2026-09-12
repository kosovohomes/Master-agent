/**
 * Phase 6 — connector service: CRUD + reveal-once secrets + rotation +
 * capability grants + the delivery receipt log / replay cache semantics.
 */
import { query } from "../lib/db";
import { decryptChannelToken } from "../lib/channels";
import {
  createWebsiteConnector,
  getWebsiteConnector,
  getConnector,
  listConnectors,
  rotateConnectorSecret,
  setConnectorStatus,
  deleteConnector,
  connectorSecrets,
  grantWebsiteCapability,
  listWebsiteCapabilities,
  websiteHasCapability,
  recordDelivery,
  markDeliveryOutcome,
  recentDeliveries,
  ConnectorError,
} from "../lib/connectors/service";

let failures = 0;
function check(name: string, cond: boolean, detail = "") {
  console.log(`${cond ? "PASS" : "FAIL"} ${name}${detail ? " :: " + detail : ""}`);
  if (!cond) failures++;
}

const stamp = Date.now();

async function setupWebsite(name: string): Promise<{ buId: number; siteId: number }> {
  const [bu] = await query<{ id: number }>(
    `INSERT INTO business_units (slug, name) VALUES ($1, $2) RETURNING id`,
    [`cns-${name}-${stamp}`, `Connector BU ${name}`]
  );
  const [site] = await query<{ id: number }>(
    `INSERT INTO websites (business_unit_id, slug, name, environment, status)
     VALUES ($1, $2, $3, 'production', 'active') RETURNING id`,
    [bu.id, `cns-${name}-${stamp}`, `Connector Site ${name}`]
  );
  return { buId: bu.id, siteId: site.id };
}

async function cleanup(buId: number) {
  await query(`DELETE FROM connector_deliveries WHERE website_id IN (SELECT id FROM websites WHERE business_unit_id = $1)`, [buId]).catch(() => undefined);
  await query(`DELETE FROM website_capabilities WHERE website_id IN (SELECT id FROM websites WHERE business_unit_id = $1)`, [buId]).catch(() => undefined);
  await query(`DELETE FROM website_integrations WHERE website_id IN (SELECT id FROM websites WHERE business_unit_id = $1)`, [buId]).catch(() => undefined);
  await query(`DELETE FROM websites WHERE business_unit_id = $1`, [buId]).catch(() => undefined);
  await query(`DELETE FROM business_units WHERE id = $1`, [buId]).catch(() => undefined);
}

try {
  const a = await setupWebsite("a");
  const b = await setupWebsite("b");

  // ---------- create + secret handling ----------
  const created = await createWebsiteConnector({ websiteId: a.siteId, displayName: "Main site webhook" });
  const connectorId = created.connector.id;
  check("create: returns connector row", connectorId > 0 && created.connector.type === "webhook" && created.connector.status === "active");
  check("create: secret is url-safe and long", /^[A-Za-z0-9_-]{40,44}$/.test(created.signingSecret), `len=${created.signingSecret.length}`);
  check("create: secret never exposed on row reads", (await getConnector(connectorId)) !== null && JSON.stringify(await getConnector(connectorId)).includes(created.signingSecret) === false);

  const stored = await query<{ credentials_encrypted: string }>(
    `SELECT credentials_encrypted FROM website_integrations WHERE id = $1`,
    [connectorId]
  );
  check("create: secret encrypted at rest (v2 envelope)", stored[0].credentials_encrypted.startsWith("v2:"));
  check("create: stored ciphertext decrypts to the secret", decryptChannelToken(stored[0].credentials_encrypted) === created.signingSecret);

  const dup = await createWebsiteConnector({ websiteId: a.siteId }).catch((e) => e as ConnectorError);
  check("create: duplicate connector rejected (CONNECTOR_EXISTS)", dup instanceof ConnectorError && dup.code === "CONNECTOR_EXISTS");

  const ghost = await createWebsiteConnector({ websiteId: 999999 }).catch((e) => e as ConnectorError);
  check("create: unknown website rejected", ghost instanceof ConnectorError && ghost.code === "UNKNOWN_WEBSITE");

  // ---------- website scoping (isolation) ----------
  check("lookup: connector scoped to its website", (await getWebsiteConnector(a.siteId))?.id === connectorId);
  check("lookup: other website sees no connector", (await getWebsiteConnector(b.siteId)) === null);

  // ---------- rotation ----------
  const rotated = await rotateConnectorSecret(connectorId);
  check("rotate: new secret differs", rotated.signingSecret !== created.signingSecret);
  check("rotate: rotatedAt stamped", rotated.connector.rotatedAt != null);
  const secrets = await connectorSecrets(connectorId);
  check("rotate: current secret is the new one", secrets.current === rotated.signingSecret);
  check("rotate: previous secret kept for the rotation window", secrets.previous === created.signingSecret && secrets.rotatedAt != null);
  const rotGhost = await rotateConnectorSecret(999999).catch((e) => e as ConnectorError);
  check("rotate: unknown connector rejected (NOT_FOUND)", rotGhost instanceof ConnectorError && rotGhost.code === "NOT_FOUND");

  // ---------- status + list ----------
  await setConnectorStatus(connectorId, "disabled");
  check("status: disable persists", (await getConnector(connectorId))?.status === "disabled");
  await setConnectorStatus(connectorId, "active");
  check("status: re-enable persists", (await getConnector(connectorId))?.status === "active");
  const listed = await listConnectors();
  const mine = listed.find((c) => c.id === connectorId);
  check("list: connector appears with website + stats fields", mine != null && mine.websiteId === a.siteId && mine.deliveries24h === 0);

  // ---------- capability grants (§394) ----------
  const grant = await grantWebsiteCapability(a.siteId, "READ_CONTENT", true);
  check("grant: enabled grant persisted", grant.enabled === true && grant.capability === "READ_CONTENT");
  const grant2 = await grantWebsiteCapability(a.siteId, "READ_CONTENT", false);
  check("grant: toggle to disabled", grant2.enabled === false);
  check("grant: hasCapability false when disabled", (await websiteHasCapability(a.siteId, "READ_CONTENT")) === false);
  await grantWebsiteCapability(a.siteId, "READ_CONTENT", true);
  check("grant: hasCapability true when enabled", (await websiteHasCapability(a.siteId, "READ_CONTENT")) === true);
  check("grant: isolation — other website not granted", (await websiteHasCapability(b.siteId, "READ_CONTENT")) === false);
  const badGrant = await grantWebsiteCapability(a.siteId, "chat.answer", true).catch((e) => e as ConnectorError);
  check("grant: reserved/unknown capability rejected (INVALID_CAPABILITY)", badGrant instanceof ConnectorError && badGrant.code === "INVALID_CAPABILITY");
  const grants = await listWebsiteCapabilities(a.siteId);
  check("grant: list shows enabled row", grants.some((g) => g.capability === "READ_CONTENT" && g.enabled));
  check("list: capabilities joined into connector row", (await getConnector(connectorId))?.capabilities.includes("READ_CONTENT") === true);

  // ---------- delivery log + replay semantics ----------
  const d1 = await recordDelivery({
    websiteId: a.siteId, integrationId: connectorId, deliveryId: `dlv-${stamp}-1`,
    eventType: "content.sync", signatureValid: true, status: "received",
    payload: { type: "content.sync" },
  });
  check("delivery: first sight recorded", d1.recorded === true && d1.reprocessed === false && d1.deliveryRowId != null);

  const d2 = await recordDelivery({
    websiteId: a.siteId, integrationId: connectorId, deliveryId: `dlv-${stamp}-1`,
    eventType: "content.sync", signatureValid: true, status: "received", overwriteRetryable: true,
  });
  check("delivery: accepted row replays (recorded=false)", d2.recorded === false && d2.deliveryRowId === null);

  await markDeliveryOutcome(d1.deliveryRowId!, { status: "failed", rejectionReason: "boom" });
  const d3 = await recordDelivery({
    websiteId: a.siteId, integrationId: connectorId, deliveryId: `dlv-${stamp}-1`,
    eventType: "content.sync", signatureValid: true, status: "received", overwriteRetryable: true,
  });
  check("delivery: failed row re-recordable (sender retries processed)", d3.recorded === true && d3.reprocessed === true);

  // rejected attempts never overwrite a claimed id and never claim one for good
  const d4 = await recordDelivery({
    websiteId: a.siteId, integrationId: connectorId, deliveryId: `dlv-${stamp}-1`,
    eventType: "unknown", signatureValid: false, status: "rejected", rejectionReason: "invalid_signature",
  });
  check("delivery: rejected attempt on claimed id suppressed (no overwrite)", d4.recorded === false);
  const d5 = await recordDelivery({
    websiteId: a.siteId, integrationId: connectorId, deliveryId: `dlv-${stamp}-attacker`,
    eventType: "unknown", signatureValid: false, status: "rejected", rejectionReason: "invalid_signature",
  });
  check("delivery: rejected attempt recorded once", d5.recorded === true);
  const d6 = await recordDelivery({
    websiteId: a.siteId, integrationId: connectorId, deliveryId: `dlv-${stamp}-attacker`,
    eventType: "content.sync", signatureValid: true, status: "received", overwriteRetryable: true,
  });
  check("delivery: valid delivery can re-record an attacker-poisoned id (liveness)", d6.recorded === true && d6.reprocessed === true);

  await markDeliveryOutcome(d6.deliveryRowId!, { status: "accepted", taskId: 424242 });
  const recent = await recentDeliveries(connectorId, 10);
  // rows: dlv-1 (d1 → failed → d3 re-record) + attacker (d5 → d6 re-record) = 2
  check("deliveries: newest first with task link", recent[0]?.taskId === 424242 && recent.length === 2, JSON.stringify(recent.map((r) => ({ id: r.id, s: r.status, t: r.taskId }))));
  check("deliveries: scoped to connector (isolation)", recent.every((r) => r.websiteId === a.siteId));

  // cross-website delivery id collision must NOT leak across sites
  const d7 = await recordDelivery({
    websiteId: b.siteId, integrationId: null, deliveryId: `dlv-${stamp}-1`,
    eventType: "heartbeat", signatureValid: true, status: "received",
  });
  check("delivery: same id on ANOTHER website is independent (scope isolation)", d7.recorded === true);

  // ---------- delete ----------
  check("delete: removes connector", await deleteConnector(connectorId));
  check("delete: gone from lookups", (await getConnector(connectorId)) === null && (await getWebsiteConnector(a.siteId)) === null);

  await cleanup(a.buId);
  await cleanup(b.buId);
} finally {
  // no cross-run residue for this stamp
  await query(`DELETE FROM connector_deliveries WHERE delivery_id LIKE '%-${stamp}' OR delivery_id LIKE 'dlv-${stamp}%'`).catch(() => undefined);
}

if (failures > 0) { console.error(`${failures} FAIL`); process.exit(1); }
console.log("CONNECTORS SERVICE SUITE PASS");
