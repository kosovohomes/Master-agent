/**
 * Phase 6 — connector event router: content.sync → scoped knowledge source
 * + durable knowledge_fetch spawn (Phase 5 machinery reuse), heartbeat,
 * record-only events, URL caps, and website isolation of created sources.
 */
import { query } from "../lib/db";
import { makeConnectorEventHandler } from "../lib/connectors/events";
import type { ConnectorWebsite } from "../lib/connectors/types";

let failures = 0;
function check(name: string, cond: boolean, detail = "") {
  console.log(`${cond ? "PASS" : "FAIL"} ${name}${detail ? " :: " + detail : ""}`);
  if (!cond) failures++;
}

const stamp = Date.now();
const handle = makeConnectorEventHandler();
const sourceIds: number[] = [];
const taskKeys: string[] = [];

async function setupWebsite(name: string): Promise<{ buId: number; siteId: number }> {
  const [bu] = await query<{ id: number }>(
    `INSERT INTO business_units (slug, name) VALUES ($1, $2) RETURNING id`,
    [`cne-${name}-${stamp}`, `Connector Events BU ${name}`]
  );
  const [site] = await query<{ id: number }>(
    `INSERT INTO websites (business_unit_id, slug, name, environment, status)
     VALUES ($1, $2, $3, 'production', 'active') RETURNING id`,
    [bu.id, `cne-${name}-${stamp}`, `Connector Events Site ${name}`]
  );
  return { buId: bu.id, siteId: site.id };
}

function websiteOf(siteId: number, buId: number): ConnectorWebsite {
  return { id: siteId, businessUnitId: buId, slug: `cne-${stamp}`, name: "Events Site", domain: null, status: "active" };
}

async function cleanup(buId: number) {
  if (taskKeys.length > 0) {
    await query(`DELETE FROM tasks WHERE idempotency_key = ANY($1::text[])`, [taskKeys]).catch(() => undefined);
  }
  if (sourceIds.length > 0) {
    await query(`DELETE FROM documents WHERE knowledge_source_id = ANY($1::bigint[])`, [sourceIds]).catch(() => undefined);
    await query(`DELETE FROM knowledge_sources WHERE id = ANY($1::bigint[])`, [sourceIds]).catch(() => undefined);
  }
  await query(`DELETE FROM events WHERE name = 'connector.content.sync' AND payload->>'deliveryId' LIKE 'cne-dlv-%'`).catch(() => undefined);
  await query(`DELETE FROM website_integrations WHERE website_id IN (SELECT id FROM websites WHERE business_unit_id = $1)`, [buId]).catch(() => undefined);
  await query(`DELETE FROM websites WHERE business_unit_id = $1`, [buId]).catch(() => undefined);
  await query(`DELETE FROM business_units WHERE id = $1`, [buId]).catch(() => undefined);
}

try {
  const a = await setupWebsite("a");
  const b = await setupWebsite("b");

  const [integration] = await query<{ id: number }>(
    `INSERT INTO website_integrations (website_id, integration_type, status) VALUES ($1, 'webhook', 'active') RETURNING id`,
    [a.siteId]
  );

  // ---------- content.sync: source ensured + task spawned ----------
  const dlv1 = `cne-dlv-${stamp}-1`;
  const r1 = await handle({
    website: websiteOf(a.siteId, a.buId),
    integrationId: integration.id,
    eventType: "content.sync",
    data: { sitemapUrl: `https://site-a-${stamp}.example/sitemap.xml` },
    deliveryId: dlv1,
  });
  check("sync: action=sync with 1 source + 1 task", r1.action === "sync" && r1.sourceIds?.length === 1 && r1.taskIds?.length === 1, JSON.stringify(r1));
  const src1 = await query<any>(`SELECT website_id, business_unit_id, kind, ref, access_level, status, refresh_frequency FROM knowledge_sources WHERE id = $1`, [r1.sourceIds![0]]);
  sourceIds.push(r1.sourceIds![0]);
  check("sync: source scoped to the sending website + its BU", src1[0].website_id === a.siteId && src1[0].business_unit_id === a.buId);
  check("sync: source kind/ref from sitemapUrl", src1[0].kind === "sitemap" && src1[0].ref === `https://site-a-${stamp}.example/sitemap.xml`);
  check("sync: source public + active + manual (site-published content)", src1[0].access_level === "public" && src1[0].status === "active" && src1[0].refresh_frequency === "manual");
  const task1 = await query<any>(`SELECT kind, idempotency_key, created_by, status FROM tasks WHERE id = $1`, [r1.taskIds![0]]);
  taskKeys.push(`knowledge_fetch:${r1.sourceIds![0]}:connector:${dlv1}`);
  check("sync: durable knowledge_fetch task spawned by connector", task1[0].kind === "knowledge_fetch" && task1[0].created_by === "connector");
  check("sync: idempotency key is per source+delivery", task1[0].idempotency_key === `knowledge_fetch:${r1.sourceIds![0]}:connector:${dlv1}`);

  // ---------- second delivery, same target: source reused, NEW task (new delivery id) ----------
  const dlv2 = `cne-dlv-${stamp}-2`;
  const r2 = await handle({
    website: websiteOf(a.siteId, a.buId),
    integrationId: integration.id,
    eventType: "content.updated",
    data: { sitemapUrl: `https://site-a-${stamp}.example/sitemap.xml` },
    deliveryId: dlv2,
  });
  check("sync: repeat event reuses the source (no duplicate registry rows)", r2.sourceIds?.[0] === r1.sourceIds![0]);
  check("sync: new delivery spawns a fresh fetch task", r2.taskIds?.length === 1 && r2.taskIds![0] !== r1.taskIds![0]);
  sourceIds.length = Math.max(sourceIds.length, 1);

  // ---------- same delivery id again: spawn deduplicated (retry path) ----------
  const r2b = await handle({
    website: websiteOf(a.siteId, a.buId),
    integrationId: integration.id,
    eventType: "content.sync",
    data: { sitemapUrl: `https://site-a-${stamp}.example/sitemap.xml` },
    deliveryId: dlv1,
  });
  check("sync: same delivery id → task spawn deduplicated", r2b.action === "sync" && r2b.spawnDeduplicated === 1 && r2b.taskIds?.length === 0, JSON.stringify(r2b));

  // ---------- urls array capped at 5 ----------
  const dlv3 = `cne-dlv-${stamp}-3`;
  const urls = [1, 2, 3, 4, 5, 6, 7].map((n) => `https://site-a-${stamp}.example/p/${n}`);
  const r3 = await handle({
    website: websiteOf(a.siteId, a.buId),
    integrationId: integration.id,
    eventType: "content.sync",
    data: { urls },
    deliveryId: dlv3,
  });
  const urlSources = await query<{ n: number }>(
    `SELECT count(*)::int AS n FROM knowledge_sources WHERE website_id = $1 AND kind = 'url' AND ref LIKE $2`,
    [a.siteId, `https://site-a-${stamp}.example/p/%`]
  );
  for (const id of r3.sourceIds ?? []) sourceIds.push(id);
  check("sync: urls array capped at 5 sources", (r3.sourceIds?.length ?? 0) === 5 && urlSources[0].n === 5, JSON.stringify(r3.sourceIds));
  taskKeys.push(...(r3.sourceIds ?? []).map((id) => `knowledge_fetch:${id}:connector:${dlv3}`));

  // ---------- no fetchable target → ConnectorEventError ----------
  let threw = "";
  try {
    await handle({
      website: websiteOf(a.siteId, a.buId),
      integrationId: integration.id,
      eventType: "content.sync",
      data: { sitemapUrl: "ftp://nope", url: "/relative-only" },
      deliveryId: `cne-dlv-${stamp}-4`,
    });
  } catch (e) {
    threw = (e as Error).message;
  }
  check("sync: non-http targets rejected with SYNC_TARGET_REQUIRED", threw.includes("content.sync requires"), threw.slice(0, 80));

  // ---------- heartbeat + record-only + unknown ----------
  const before = await query<{ last_event_at: string | null }>(`SELECT last_event_at FROM website_integrations WHERE id = $1`, [integration.id]);
  // earlier syncs already stamped liveness — null it to prove the heartbeat refreshes it
  await query(`UPDATE website_integrations SET last_event_at = NULL WHERE id = $1`, [integration.id]);
  const r4 = await handle({
    website: websiteOf(a.siteId, a.buId),
    integrationId: integration.id,
    eventType: "heartbeat",
    data: {},
    deliveryId: `cne-dlv-${stamp}-5`,
  });
  const after = await query<{ last_event_at: string | null }>(`SELECT last_event_at FROM website_integrations WHERE id = $1`, [integration.id]);
  check("heartbeat: action + liveness stamp updated", r4.action === "heartbeat" && before[0].last_event_at != null && after[0].last_event_at != null);

  const r5 = await handle({
    website: websiteOf(a.siteId, a.buId),
    integrationId: integration.id,
    eventType: "lead.created",
    data: { name: "Test Lead" },
    deliveryId: `cne-dlv-${stamp}-6`,
  });
  check("lead.created: accepted record-only (no pipeline in P6)", r5.action === "ignored" && (r5.detail ?? "").includes("lead.created"));

  const r6 = await handle({
    website: websiteOf(a.siteId, a.buId),
    integrationId: integration.id,
    eventType: "brand.new.event.2099",
    data: {},
    deliveryId: `cne-dlv-${stamp}-7`,
  });
  check("unknown event: accepted + ignored (forward compatible)", r6.action === "ignored");

  // ---------- event bus observable ----------
  // dlv1 was handled twice (r1 + the r2b retry) → 2 emitted rows; dlv2 once → 1
  const ev1 = await query<{ n: number }>(
    `SELECT count(*)::int AS n FROM events WHERE name = 'connector.content.sync' AND payload->>'deliveryId' = $1`,
    [dlv1]
  );
  const ev2 = await query<{ n: number }>(
    `SELECT count(*)::int AS n FROM events WHERE name = 'connector.content.sync' AND payload->>'deliveryId' = $1`,
    [dlv2]
  );
  check("event bus: connector.content.sync emitted with delivery context (retry re-emits)", ev1[0].n === 2 && ev2[0].n === 1, JSON.stringify({ dlv1: ev1[0].n, dlv2: ev2[0].n }));

  // ---------- isolation: site B sync never touches site A sources ----------
  const dlvB = `cne-dlv-${stamp}-b1`;
  const [integrationB] = await query<{ id: number }>(
    `INSERT INTO website_integrations (website_id, integration_type, status) VALUES ($1, 'webhook', 'active') RETURNING id`,
    [b.siteId]
  );
  const rB = await handle({
    website: websiteOf(b.siteId, b.buId),
    integrationId: integrationB.id,
    eventType: "content.sync",
    data: { url: `https://site-a-${stamp}.example/p/1` }, // SAME url as site A synced
    deliveryId: dlvB,
  });
  sourceIds.push(...(rB.sourceIds ?? []));
  taskKeys.push(...(rB.sourceIds ?? []).map((id) => `knowledge_fetch:${id}:connector:${dlvB}`));
  const bSrc = await query<any>(`SELECT website_id, business_unit_id FROM knowledge_sources WHERE id = $1`, [rB.sourceIds![0]]);
  check("isolation: identical ref under site B creates a SEPARATE scoped source", bSrc[0].website_id === b.siteId && bSrc[0].business_unit_id === b.buId && rB.sourceIds![0] !== r3.sourceIds![0]);

  await cleanup(a.buId);
  await cleanup(b.buId);
} finally {
  if (taskKeys.length > 0) await query(`DELETE FROM tasks WHERE idempotency_key = ANY($1::text[])`, [taskKeys]).catch(() => undefined);
  if (sourceIds.length > 0) {
    await query(`DELETE FROM documents WHERE knowledge_source_id = ANY($1::bigint[])`, [sourceIds]).catch(() => undefined);
    await query(`DELETE FROM knowledge_sources WHERE id = ANY($1::bigint[])`, [sourceIds]).catch(() => undefined);
  }
  await query(`DELETE FROM events WHERE name = 'connector.content.sync' AND payload->>'deliveryId' LIKE 'cne-dlv-%'`).catch(() => undefined);
  await query(`DELETE FROM website_integrations WHERE website_id IN (SELECT id FROM websites WHERE slug LIKE 'cne-%-${stamp}')`).catch(() => undefined);
  await query(`DELETE FROM websites WHERE slug LIKE 'cne-%-${stamp}'`).catch(() => undefined);
  await query(`DELETE FROM business_units WHERE slug LIKE 'cne-%-${stamp}'`).catch(() => undefined);
}

if (failures > 0) { console.error(`${failures} FAIL`); process.exit(1); }
console.log("CONNECTORS EVENTS SUITE PASS");
