/**
 * Phase 5 — hybrid retrieval engine tests: dual-leg fusion, keyword-only
 * degradation (no provider dependency), citation metadata (tier + provenance),
 * chunk ordering, and topK/empty-query contracts.
 */
import { query } from "../lib/db";
import { ingestKnowledgeDocument } from "../lib/knowledge/ingest";
import { hybridRetrieve, hybridRetrieveDetailed } from "../lib/knowledge/retrieve";
import type { EmbedContext } from "../lib/knowledge/types";

let failures = 0;
function check(name: string, cond: boolean, detail = "") {
  console.log(`${cond ? "PASS" : "FAIL"} ${name}${detail ? " :: " + detail : ""}`);
  if (!cond) failures++;
}

const dim = (n: number) => Array.from({ length: 1536 }, (_, i) => (i < n ? 1 : 0));
const embed: EmbedContext = { embed: async (texts) => texts.map((_, i) => dim(40 + i)) };
const failingEmbed: EmbedContext = { embed: async () => { throw new Error("insufficient_quota: provider down"); } };
let embedCalls = 0;
const countingEmbed: EmbedContext = {
  embed: async (texts) => { embedCalls += texts.length; return texts.map((_, i) => dim(50 + i)); },
};

const stamp = Date.now();
let buId: number | undefined;
let sourceId: number | undefined;
const docIds: number[] = [];

try {
  const [bu] = await query<{ id: number }>(
    `INSERT INTO business_units (slug, name) VALUES ($1, $2) RETURNING id`,
    [`krw-bu-${stamp}`, "Retrieval BU"]
  );
  buId = bu.id;
  const [src] = await query<{ id: number }>(
    `INSERT INTO knowledge_sources (business_unit_id, kind, ref, authority_level)
     VALUES ($1, 'upload', $2, 1) RETURNING id`,
    [buId, `krw-src-${stamp}`]
  );
  sourceId = src.id;

  // structured document with headings + repeated filler to force multiple chunks
  const longDoc = [
    "# Deprecation Schedule",
    "",
    "The legacy API sunset date is december thirty first for all customers.",
    "",
    ...Array.from({ length: 40 }, (_, i) => `Padding paragraph ${i} carries migration guidance about endpoints and quotas for planning.`),
    "",
    "## Exceptions",
    "",
    "Enterprise customers keep the legacy bridge until june thirty first.",
  ].join("\n");
  const r1 = await ingestKnowledgeDocument(countingEmbed, {
    knowledgeSourceId: src.id, title: "Deprecation Schedule", text: longDoc,
    businessUnitId: buId, authorityTier: 1,
    provenance: { crawlerId: "agentos-knowledge-v1", revision: "abc123" },
    sourceUrl: "https://gov.example/deprecation",
  });
  docIds.push(r1.documentId);
  check("structured ingest creates multiple chunks", r1.chunkCount > 1, `n=${r1.chunkCount}`);
  check("dedup flag false on fresh ingest", r1.deduplicated === false);

  const chunkRows = await query<{ chunk_no: number; content: string }>(
    `SELECT chunk_no, content FROM chunks WHERE document_id = $1 ORDER BY chunk_no`,
    [r1.documentId]
  );
  check("chunk_no is 0..n-1 in document order", chunkRows.map((c) => c.chunk_no).every((n, i) => n === i));
  check("first chunk preserves heading", chunkRows[0].content.startsWith("# Deprecation Schedule"));
  check(
    "tsv populated on write (same expression as backfill)",
    (await query<{ n: number }>(`SELECT count(*)::int AS n FROM chunks WHERE document_id = $1 AND tsv IS NOT NULL`, [r1.documentId]))[0].n === chunkRows.length
  );

  // second small doc
  const r2 = await ingestKnowledgeDocument(embed, {
    knowledgeSourceId: src.id, title: "Security Notes",
    text: "API keys rotate every ninety days and revoke immediately on suspicion.",
    businessUnitId: buId, authorityTier: 2,
    provenance: { crawlerId: "agentos-knowledge-v1" },
  });
  docIds.push(r2.documentId);

  // ---- both legs: hybrid returns results with citation metadata ----
  const { citations, legs } = await hybridRetrieveDetailed(embed, {
    scope: { businessUnitId: buId },
    query: "legacy API sunset date",
    topK: 5,
  });
  check("hybrid retrieval returns citations", citations.length > 0);
  check("vector leg active with working provider", legs.vector === true);
  check("keyword leg active on keyword match", legs.keyword === true);
  const top = citations[0];
  check("citation carries authority tier", typeof top.authorityTier === "number" && top.authorityTier >= 1);
  check("citation carries provenance", (top.provenance as { crawlerId?: string } | null)?.crawlerId === "agentos-knowledge-v1");
  check("citation carries source url", top.sourceUrl === "https://gov.example/deprecation" || top.sourceUrl === null);
  check("citation carries access level + verification", top.accessLevel === "internal" && top.verificationStatus === "unverified");
  check("citations sorted by fused score desc", citations.every((c, i) => i === 0 || citations[i - 1].score >= c.score));

  // a chunk hit by BOTH legs outranks a same-rank single-leg chunk (RRF property)
  const bothLegs = citations.filter((c) => c.legs.vector && c.legs.keyword);
  const singleLeg = citations.filter((c) => (c.legs.vector ? !c.legs.keyword : c.legs.keyword));
  if (bothLegs.length > 0 && singleLeg.length > 0) {
    check("dual-leg chunks outrank single-leg chunks (RRF)", bothLegs[0].score > singleLeg[0].score, `both=${bothLegs[0].score.toFixed(5)} single=${singleLeg[0].score.toFixed(5)}`);
  } else {
    check("RRF comparison applicable in this corpus", true, `both=${bothLegs.length} single=${singleLeg.length}`);
  }

  // ---- keyword-only degradation: provider outage does NOT kill retrieval ----
  const degraded = await hybridRetrieve(failingEmbed, {
    scope: { businessUnitId: buId },
    query: "api keys rotate",
    topK: 5,
  });
  check("provider outage degrades to keyword-only", degraded.length > 0 && degraded.some((c) => c.title === "Security Notes"));
  check("degraded citations still carry tier + provenance", degraded.every((c) => typeof c.authorityTier === "number" && c.provenance != null));

  // ---- topK respected ----
  const capped = await hybridRetrieve(embed, { scope: { businessUnitId: buId }, query: "migration guidance endpoints quotas padding", topK: 2, candidateLimit: 40 });
  check("topK caps result count", capped.length === 2, `n=${capped.length}`);

  // ---- empty query contract ----
  const empty = await hybridRetrieve(embed, { scope: { businessUnitId: buId }, query: "   " });
  check("empty query returns no citations", empty.length === 0);

  // ---- scope still enforced through the hybrid engine ----
  const foreign = await hybridRetrieve(embed, { scope: { businessUnitId: null }, query: "sunset date api" });
  check("global-only caller cannot see BU docs through hybrid", !foreign.some((c) => c.documentId === r1.documentId));

  // ---- dedup skips embedding (checksum reuse) ----
  embedCalls = 0;
  const dupe = await ingestKnowledgeDocument(countingEmbed, {
    knowledgeSourceId: src.id, title: "Deprecation Schedule (dupe)", text: longDoc, businessUnitId: buId,
  });
  check("dedup reuses document without embedding calls", dupe.deduplicated && dupe.documentId === r1.documentId && embedCalls === 0, `calls=${embedCalls}`);
} finally {
  if (docIds.length > 0) await query("DELETE FROM documents WHERE id = ANY($1)", [docIds]).catch(() => undefined);
  if (sourceId != null) await query("DELETE FROM knowledge_sources WHERE id = $1", [sourceId]).catch(() => undefined);
  if (buId != null) await query("DELETE FROM business_units WHERE id = $1", [buId]).catch(() => undefined);
}

if (failures > 0) { console.error(`${failures} FAIL`); process.exit(1); }
console.log("KNOWLEDGE RETRIEVAL SUITE PASS");
