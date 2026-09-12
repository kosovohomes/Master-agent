/**
 * Phase 5 — knowledge fetchers + runSourceFetch service roundtrip.
 * HTTP is injected (fake fetchImpl) so the suite is hermetic; the service
 * roundtrip proves the fetch → ingest → status machine against the real DB.
 */
import { query } from "../lib/db";
import { makeKnowledgeFetcher } from "../lib/knowledge/fetchers";
import { runSourceFetch, createKnowledgeSource, getKnowledgeSource, deleteKnowledgeSource, spawnDueKnowledgeFetches } from "../lib/knowledge/service";
import type { EmbedContext } from "../lib/knowledge/types";

let failures = 0;
function check(name: string, cond: boolean, detail = "") {
  console.log(`${cond ? "PASS" : "FAIL"} ${name}${detail ? " :: " + detail : ""}`);
  if (!cond) failures++;
}

const dim = (n: number) => Array.from({ length: 1536 }, (_, i) => (i < n ? 1 : 0));
const embed: EmbedContext = { embed: async (texts) => texts.map((_, i) => dim(30 + i)) };

const stamp = Date.now();
const sourceIds: number[] = [];

/** Minimal fake fetch: routes URLs to canned responses, records calls. */
function fakeFetch(routes: Record<string, { status?: number; contentType?: string; body?: string }>) {
  const calls: string[] = [];
  const impl = async (url: string): Promise<{ ok: boolean; status: number; headers: { get(n: string): string | null }; text: () => Promise<string> }> => {
    calls.push(url);
    const route = routes[url];
    if (!route) throw new Error(`unexpected fetch: ${url}`);
    return {
      ok: (route.status ?? 200) >= 200 && (route.status ?? 200) < 300,
      status: route.status ?? 200,
      headers: { get: (n: string) => (n.toLowerCase() === "content-type" ? (route.contentType ?? "text/html") : null) },
      text: async () => route.body ?? "",
    };
  };
  return { impl, calls };
}

const PAGE = (title: string, body: string) =>
  `<html><head><title>${title}</title><style>.x{color:red}</style></head><body><script>var t=1;</script><h1>${title}</h1><p>${body}</p><p>Amp test &amp; &lt;tag&gt; &#39;quoted&#39;</p></body></html>`;

try {
  const kf = makeKnowledgeFetcher({ fetchImpl: fakeFetch({}).impl, timeoutMs: 500 });

  // ---- URL fetch: title + text extraction + provenance ----
  {
    const { impl } = fakeFetch({ "https://x.example/page": { body: PAGE("Pricing Page", "The enterprise plan costs nine dollars.") } });
    const f = makeKnowledgeFetcher({ fetchImpl: impl, timeoutMs: 500 });
    const doc = await f.fetchUrlText("https://x.example/page");
    check("url fetch extracts title", doc.title === "Pricing Page", doc.title);
    check("url fetch strips tags and scripts", doc.text.includes("enterprise plan") && !doc.text.includes("script") && !doc.text.includes("color:red"));
    check("url fetch decodes entities", doc.text.includes("&") && doc.text.includes("'quoted'"));
    check("provenance stamped (crawlerId/revision/fetchedAt)", doc.provenance.crawlerId === "agentos-knowledge-v1" && typeof doc.provenance.revision === "string" && typeof doc.provenance.fetchedAt === "string");
  }

  // ---- Sitemap: loc extraction + per-page fetch + partial success ----
  {
    const sitemap = `<?xml version="1.0"?><urlset><url><loc>https://x.example/a</loc></url><url><loc>https://x.example/b.jpg</loc></url><url><loc>https://x.example/b</loc></url></urlset>`;
    const { impl } = fakeFetch({
      "https://x.example/sitemap.xml": { contentType: "application/xml", body: sitemap },
      "https://x.example/a": { body: PAGE("Page A", "alpha content") },
      "https://x.example/b": { body: PAGE("Page B", "beta content") },
    });
    const f = makeKnowledgeFetcher({ fetchImpl: impl, timeoutMs: 500 });
    const docs = await f.fetchSitemap("https://x.example/sitemap.xml");
    check("sitemap fetches page candidates (non-asset)", docs.length === 2, `n=${docs.length}`);
    check("sitemap page titles extracted", docs.some((d) => d.title === "Page A") && docs.some((d) => d.title === "Page B"));
    check("sitemap provenance refs pages", docs.every((d) => String(d.provenance.sourceRef).startsWith("https://x.example/")));
  }

  // ---- Sitemap index expansion ----
  {
    const index = `<sitemapindex><sitemap><loc>https://x.example/child.xml</loc></sitemap></sitemapindex>`;
    const child = `<urlset><url><loc>https://x.example/c</loc></url></urlset>`;
    const { impl, calls } = fakeFetch({
      "https://x.example/index.xml": { contentType: "application/xml", body: index },
      "https://x.example/child.xml": { contentType: "application/xml", body: child },
      "https://x.example/c": { body: PAGE("Page C", "gamma content") },
    });
    const f = makeKnowledgeFetcher({ fetchImpl: impl, timeoutMs: 500 });
    const docs = await f.fetchSitemap("https://x.example/index.xml");
    check("sitemap index expands one level", docs.length === 1 && docs[0].title === "Page C", `n=${docs.length}`);
    check("index expansion fetched child sitemap", calls.includes("https://x.example/child.xml"));
  }

  // ---- RSS items → documents ----
  {
    const rss = `<?xml version="1.0"?><rss><channel>
      <item><title>Update One</title><link>https://x.example/news/1</link><description>&lt;p&gt;First announcement body.&lt;/p&gt;</description></item>
      <item><title>Update Two</title><link>https://x.example/news/2</link><description>Second announcement body.</description></item>
    </channel></rss>`;
    const { impl } = fakeFetch({ "https://x.example/feed.xml": { contentType: "application/rss+xml", body: rss } });
    const f = makeKnowledgeFetcher({ fetchImpl: impl, timeoutMs: 500 });
    const docs = await f.fetchRss("https://x.example/feed.xml");
    check("rss parses items into documents", docs.length === 2 && docs[0].title === "Update One");
    check("rss strips html in description", docs[0].text.includes("First announcement") && !docs[0].text.includes("<p>"));
    check("rss keeps item links", docs[0].url === "https://x.example/news/1");
  }

  // ---- failure paths ----
  {
    const { impl } = fakeFetch({ "https://x.example/broken": { status: 500, body: "boom" } });
    const f = makeKnowledgeFetcher({ fetchImpl: impl, timeoutMs: 500 });
    let threw = "";
    try { await f.fetchUrlText("https://x.example/broken"); } catch (e) { threw = (e as Error).message; }
    check("HTTP 500 surfaces as error", threw.includes("500"), threw);

    const { impl: impl2 } = fakeFetch({ "https://x.example/img": { contentType: "image/png", body: "binary" } });
    const f2 = makeKnowledgeFetcher({ fetchImpl: impl2, timeoutMs: 500 });
    let threw2 = "";
    try { await f2.fetchUrlText("https://x.example/img"); } catch (e) { threw2 = (e as Error).message; }
    check("non-text content-type rejected", threw2.includes("unsupported content-type"), threw2);

    const { impl: impl3 } = fakeFetch({ "https://x.example/empty.xml": { contentType: "application/xml", body: "<urlset></urlset>" } });
    const f3 = makeKnowledgeFetcher({ fetchImpl: impl3, timeoutMs: 500 });
    let threw3 = "";
    try { await f3.fetchSitemap("https://x.example/empty.xml"); } catch (e) { threw3 = (e as Error).message; }
    check("empty sitemap errors", threw3.includes("no fetchable page URLs"), threw3);

    let threw4 = "";
    try { await kf.fetchForKind("upload", "anything"); } catch (e) { threw4 = (e as Error).message; }
    check("upload kind not fetchable in v1", threw4.includes("not fetchable"), threw4);
  }

  // ---- runSourceFetch roundtrip (real DB) ----
  const [bu] = await query<{ id: number }>(
    `INSERT INTO business_units (slug, name) VALUES ($1, $2) RETURNING id`,
    [`kfw-bu-${stamp}`, "Fetcher BU"]
  );
  try {
    const source = await createKnowledgeSource({
      businessUnitId: bu.id,
      kind: "url",
      ref: "https://x.example/handbook",
      title: "Handbook",
      jurisdiction: "US",
      accessLevel: "public",
      authorityLevel: 2,
    });
    sourceIds.push(source.id);

    const routes = { "https://x.example/handbook": { body: PAGE("Handbook", "The handbook covers everything about everything.") } };
    const run1 = await runSourceFetch(source.id, {
      fetcher: makeKnowledgeFetcher({ fetchImpl: fakeFetch(routes).impl, timeoutMs: 500 }),
      embed,
    });
    check("fetch run ingests 1 document", run1.ingested === 1 && run1.fetched === 1, JSON.stringify(run1));
    check("fetch run reports chunk count", run1.chunkCount >= 1);

    const afterRow = await query<{ provenance: Record<string, unknown>; jurisdiction: string | null; access_level: string; authority_tier: number; knowledge_source_id: number }>(
      `SELECT provenance, jurisdiction, access_level, authority_tier, knowledge_source_id FROM documents WHERE knowledge_source_id = $1`,
      [source.id]
    );
    check("document carries source scope stamps", afterRow[0]?.jurisdiction === "US" && afterRow[0]?.access_level === "public" && afterRow[0]?.authority_tier === 2);
    check("document links to knowledge source", afterRow[0]?.knowledge_source_id === source.id);
    check("document provenance stamped from fetcher", afterRow[0]?.provenance?.crawlerId === "agentos-knowledge-v1");

    const srcRow = await getKnowledgeSource(source.id);
    const lastRun = (srcRow?.metadata as { lastRun?: { ingested?: number } }).lastRun;
    check("source lastRun recorded + status active", srcRow?.status === "active" && lastRun?.ingested === 1 && srcRow?.lastChecked != null);

    // second run: same content → checksum dedup, no re-embed of new chunks
    const run2 = await runSourceFetch(source.id, {
      fetcher: makeKnowledgeFetcher({ fetchImpl: fakeFetch(routes).impl, timeoutMs: 500 }),
      embed,
    });
    check("second run deduplicates", run2.deduplicated === 1 && run2.ingested === 0, JSON.stringify(run2));

    // disabled source refuses to run
    await query("UPDATE knowledge_sources SET status = 'disabled' WHERE id = $1", [source.id]);
    let threw = "";
    try { await runSourceFetch(source.id, { fetcher: kf, embed }); } catch (e) { threw = (e as Error).message; }
    check("disabled source refuses fetch", threw.includes("disabled"), threw);

    // failing fetch marks source error and rethrows
    await query("UPDATE knowledge_sources SET status = 'active' WHERE id = $1", [source.id]);
    const { impl: brokenImpl } = fakeFetch({ "https://x.example/handbook": { status: 503, body: "down" } });
    let threw2 = "";
    try {
      await runSourceFetch(source.id, { fetcher: makeKnowledgeFetcher({ fetchImpl: brokenImpl, timeoutMs: 500 }), embed });
    } catch (e) { threw2 = (e as Error).message; }
    const errRow = await getKnowledgeSource(source.id);
    check("failing fetch rethrows", threw2.includes("knowledge fetch failed"), threw2.slice(0, 80));
    check("failing fetch marks source error", errRow?.status === "error");

    // deleteKnowledgeSource removes the registry row (documents keep lineage via SET NULL)
    check("delete removes source", await deleteKnowledgeSource(source.id));
    sourceIds.length = 0;
  } finally {
    // documents first: documents.business_unit_id is an FK without cascade
    await query(`DELETE FROM documents WHERE business_unit_id = $1`, [bu.id]).catch(() => undefined);
    await query("DELETE FROM business_units WHERE id = $1", [bu.id]).catch(() => undefined);
  }

  // ---- spawnDueKnowledgeFetches: only due, non-manual sources spawn ----
  const [bu2] = await query<{ id: number }>(
    `INSERT INTO business_units (slug, name) VALUES ($1, $2) RETURNING id`,
    [`kfw-bu2-${stamp}`, "Scheduler BU"]
  );
  try {
    const due = await createKnowledgeSource({ businessUnitId: bu2.id, kind: "url", ref: "https://x.example/due", refreshFrequency: "daily" });
    const manual = await createKnowledgeSource({ businessUnitId: bu2.id, kind: "url", ref: "https://x.example/manual", refreshFrequency: "manual" });
    const fresh = await createKnowledgeSource({ businessUnitId: bu2.id, kind: "url", ref: "https://x.example/fresh", refreshFrequency: "daily" });
    await query("UPDATE knowledge_sources SET last_checked = now() WHERE id = $1", [fresh.id]);

    const r = await spawnDueKnowledgeFetches(`kfw-day-${stamp}`);
    const dueTasks = await query<{ n: number }>(
      `SELECT count(*)::int AS n FROM tasks WHERE kind = 'knowledge_fetch' AND payload->>'knowledgeSourceId' = $1`,
      [String(due.id)]
    );
    check("due daily source spawned", r.spawned >= 1 && dueTasks[0].n === 1, JSON.stringify({ spawned: r.spawned, due: r.due }));
    const manualTasks = await query<{ n: number }>(
      `SELECT count(*)::int AS n FROM tasks WHERE kind = 'knowledge_fetch' AND payload->>'knowledgeSourceId' = $1`,
      [String(manual.id)]
    );
    check("manual source never auto-spawns", manualTasks[0].n === 0);
    const freshTasks = await query<{ n: number }>(
      `SELECT count(*)::int AS n FROM tasks WHERE kind = 'knowledge_fetch' AND payload->>'knowledgeSourceId' = $1`,
      [String(fresh.id)]
    );
    check("not-due source skipped", freshTasks[0].n === 0);

    const r2 = await spawnDueKnowledgeFetches(`kfw-day-${stamp}`);
    check("same-day re-run does not double-spawn", r2.spawned === 0, JSON.stringify(r2));

    await query(`DELETE FROM tasks WHERE kind = 'knowledge_fetch' AND payload->>'knowledgeSourceId' = $1`, [String(due.id)]);
  } finally {
    await query("DELETE FROM business_units WHERE id = $1", [bu2.id]).catch(() => undefined);
  }
} finally {
  if (sourceIds.length > 0) await query("DELETE FROM knowledge_sources WHERE id = ANY($1)", [sourceIds]).catch(() => undefined);
  await query(`DELETE FROM documents WHERE knowledge_source_id IS NULL AND provenance->>'crawlerId' = 'agentos-knowledge-v1' AND title IN ('Handbook')`).catch(() => undefined);
  await query(`DELETE FROM knowledge_sources WHERE ref LIKE 'ksc-%' OR ref LIKE 'https://x.example/handbook'`).catch(() => undefined);
}

if (failures > 0) { console.error(`${failures} FAIL`); process.exit(1); }
console.log("KNOWLEDGE FETCHERS SUITE PASS");
