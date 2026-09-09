import { addContentSource, ingestText } from "../lib/rag/ingest";
import { retrieve } from "../lib/rag/retrieve";
import { query } from "../lib/db";

let failures = 0;
function check(name: string, cond: boolean, detail = "") {
  console.log(`${cond ? "PASS" : "FAIL"} ${name}${detail ? " :: " + detail : ""}`);
  if (!cond) failures++;
}

const dim = (n: number) => Array.from({ length: 1536 }, (_, i) => (i < n ? 1 : 0));

const fakeEmbed = async (texts: string[]): Promise<number[][]> =>
  texts.map((_, i) => dim(10 + i));

const mkCtx = () => ({ embed: fakeEmbed });

const stamp = Date.now();
const slugs = [`t7-rag-a-${stamp}`, `t7-rag-b-${stamp}`, `t7-rag-c-${stamp}`];
let tenantA: number | undefined;
let tenantB: number | undefined;
let tenantC: number | undefined;

try {
  const [ta] = await query<{ id: number }>(
    `INSERT INTO tenants (slug, name) VALUES ($1, $2) RETURNING id`,
    [slugs[0], "RAG A"]
  );
  const [tb] = await query<{ id: number }>(
    `INSERT INTO tenants (slug, name) VALUES ($1, $2) RETURNING id`,
    [slugs[1], "RAG B"]
  );
  const [tc] = await query<{ id: number }>(
    `INSERT INTO tenants (slug, name) VALUES ($1, $2) RETURNING id`,
    [slugs[2], "RAG C"]
  );
  tenantA = ta.id;
  tenantB = tb.id;
  tenantC = tc.id;

  const srcA = await addContentSource(mkCtx(), { tenantId: tenantA, kind: "sitemap", ref: "https://a.example.com/sitemap.xml" });
  const srcB = await addContentSource(mkCtx(), { tenantId: tenantB, kind: "sitemap", ref: "https://b.example.com/sitemap.xml" });

  await ingestText(mkCtx(), { tenantId: tenantA, sourceId: srcA.sourceId, title: "About Tax A", text: "Progressive tax brackets and filing deadlines for business A." });
  await ingestText(mkCtx(), { tenantId: tenantB, sourceId: srcB.sourceId, title: "About Tax B", text: "Secret plans of business B with confidential strategy." });

  const rA = await retrieve(mkCtx(), { tenantId: tenantA, query: "progressive tax brackets", topK: 5 });
  check("tenant A finds own content", rA.length > 0 && rA.find((c) => c.content.includes("business A")) !== undefined);
  const leak = rA.find((c) => c.content.includes("business B"));
  check("tenant A never sees tenant B content", leak === undefined);

  const rB = await retrieve(mkCtx(), { tenantId: tenantB, query: "confidential strategy", topK: 5 });
  check("tenant B finds own content", rB.length > 0 && rB.find((c) => c.content.includes("business B")) !== undefined);

  const srcC = await addContentSource(mkCtx(), { tenantId: tenantC, kind: "api", ref: "market-intel-v1" });
  const longText = Array.from({ length: 50 }, (_, i) => `Pipeline paragraph ${i}: enough words to exceed the eight hundred character chunk size limit repeatedly across the document body.`).join(" ");
  const longDoc = await ingestText(mkCtx(), { tenantId: tenantC, sourceId: srcC.sourceId, title: "Long Doc C", text: longText });
  const chunkRows = await query<{ id: number; content: string }>(
    `SELECT id, content FROM chunks WHERE document_id = $1 ORDER BY id`,
    [longDoc.documentId]
  );
  const collapsed = longText.replace(/\s+/g, " ").trim();
  check(
    "chunking splits overlong text and respects max chunk length",
    chunkRows.length === Math.ceil(collapsed.length / 800) && chunkRows.every((r) => r.content.length <= 800),
    `chunks=${chunkRows.length}`
  );
  const rC = await retrieve(mkCtx(), { tenantId: tenantC, query: "pipeline", topK: 3 });
  check(
    "retrieval orders nearest chunks by similarity",
    rC.length === 3 && rC.map((c) => c.chunkId).join(",") === chunkRows.slice(0, 3).map((r) => String(r.id)).join(","),
    rC.map((c) => c.chunkId).join(",")
  );
} finally {
  const created = [tenantA, tenantB, tenantC].filter((t): t is number => t !== undefined);
  if (created.length > 0) await query("DELETE FROM tenants WHERE id = ANY($1)", [created]);
}

if (failures > 0) { console.error(`${failures} FAIL`); process.exit(1); }
console.log("RAG SUITE PASS");