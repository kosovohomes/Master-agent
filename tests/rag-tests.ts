import { addContentSource, ingestText } from "../lib/rag/ingest";
import { retrieve } from "../lib/rag/retrieve";
import { query } from "../lib/db";
import crypto from "node:crypto";

let failures = 0;
function check(name: string, cond: boolean, detail = "") {
  console.log(`${cond ? "PASS" : "FAIL"} ${name}${detail ? " :: " + detail : ""}`);
  if (!cond) failures++;
}

const dim = (n: number) => Array.from({ length: 1536 }, (_, i) => (i < n ? 1 : 0));

const fakeEmbed = async (texts: string[]): Promise<number[][]> =>
  texts.map((_, i) => dim(10 + i));

const mkCtx = () => ({ embed: fakeEmbed });

let embedCalls = 0;
const countingEmbed = async (texts: string[]): Promise<number[][]> => {
  embedCalls++;
  return texts.map((_, i) => dim(10 + i));
};
const countingCtx = () => ({ embed: countingEmbed });

const shortEmbed = async (): Promise<number[][]> => [dim(10)];
const emptyEmbed = async (): Promise<number[][]> => [];

const guardText = "A".repeat(2400);

const stamp = Date.now();
const slugs = [`t7-rag-a-${stamp}`, `t7-rag-b-${stamp}`, `t7-rag-c-${stamp}`];
let tenantA: number | undefined;
let tenantB: number | undefined;
let tenantC: number | undefined;

const docIds: number[] = [];

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
  const srcC = await addContentSource(mkCtx(), { tenantId: tenantC, kind: "api", ref: "market-intel-v1" });

  const dupText = "Progressive tax brackets and filing deadlines for business A.";
  const docA = await ingestText(mkCtx(), { tenantId: tenantA, sourceId: srcA.sourceId, title: "About Tax A", text: dupText });
  const docB = await ingestText(mkCtx(), { tenantId: tenantB, sourceId: srcB.sourceId, title: "About Tax B", text: "Secret plans of business B with confidential strategy." });
  docIds.push(docA.documentId, docB.documentId);

  const rA = await retrieve(mkCtx(), { tenantId: tenantA, query: "progressive tax brackets", topK: 5 });
  check("tenant A finds own content", rA.length > 0 && rA.find((c) => c.content.includes("business A")) !== undefined);
  const leak = rA.find((c) => c.content.includes("business B"));
  check("tenant A never sees tenant B content", leak === undefined);

  const rB = await retrieve(mkCtx(), { tenantId: tenantB, query: "confidential strategy", topK: 5 });
  check("tenant B finds own content", rB.length > 0 && rB.find((c) => c.content.includes("business B")) !== undefined);

  // duplicate ingest: same tenant + identical text → reuse existing document, no re-embed
  embedCalls = 0;
  const dupA = await ingestText(countingCtx(), { tenantId: tenantA, sourceId: srcA.sourceId, title: "About Tax A (dupe)", text: dupText });
  const dupSum = crypto.createHash("sha256").update(dupText).digest("hex");
  const dupDocs = await query<{ n: number }>(
    `SELECT count(*)::int AS n FROM documents WHERE tenant_id = $1 AND checksum = $2`,
    [tenantA, dupSum]
  );
  check("duplicate ingest reuses document row", dupDocs[0].n === 1, `rows=${dupDocs[0].n}`);
  check("duplicate ingest returns existing documentId", dupA.documentId === docA.documentId, `got ${dupA.documentId} vs ${docA.documentId}`);
  check("duplicate ingest skips embedding call", embedCalls === 0, `embed calls=${embedCalls}`);
  check("duplicate ingest reports existing chunk count", dupA.chunkCount === 1, `chunkCount=${dupA.chunkCount}`);

  // embed vector-count guard (ingest): bad stubs must fail loudly before pg bind
  // (runs on tenant A so tenant C stays exclusive to the ordering test)
  const guardSum = crypto.createHash("sha256").update(guardText).digest("hex");
  let ingestGuardErr = "";
  try {
    await ingestText({ embed: shortEmbed }, { tenantId: tenantA, sourceId: srcA.sourceId, title: "Guard Doc", text: guardText });
    check("ingest rejects embed count mismatch", false, "no error raised");
  } catch (e) {
    check("ingest rejects embed count mismatch", /embed returned/.test((e as Error).message), (e as Error).message.slice(0, 120));
  }
  const guardDocs = await query<{ n: number }>(
    `SELECT count(*)::int AS n FROM documents WHERE checksum = $1`,
    [guardSum]
  );
  check("failed embed leaves no phantom document", guardDocs[0].n === 0, `rows=${guardDocs[0].n}`);

  let retrieveGuardErr = "";
  try {
    await retrieve({ embed: emptyEmbed }, { tenantId: tenantA, query: "anything", topK: 2 });
    check("retrieve rejects empty embed result", false, "no error raised");
  } catch (e) {
    check("retrieve rejects empty embed result", /embed returned/.test((e as Error).message), (e as Error).message.slice(0, 120));
  }

  // empty text → single empty chunk (never a zero-chunk document)
  const emptyDoc = await ingestText(mkCtx(), { tenantId: tenantA, sourceId: srcA.sourceId, title: "Empty Doc", text: "" });
  const emptyChunks = await query<{ content: string }>(
    `SELECT content FROM chunks WHERE document_id = $1`,
    [emptyDoc.documentId]
  );
  check(
    "empty text yields single empty chunk",
    emptyDoc.chunkCount === 1 && emptyChunks.length === 1 && emptyChunks[0].content === "",
    `chunkCount=${emptyDoc.chunkCount} rows=${emptyChunks.length}`
  );

  // regression: chunks are never persisted without an embedding
  docIds.push(emptyDoc.documentId);
  const nullEmb = await query<{ n: number }>(
    `SELECT count(*)::int AS n FROM chunks WHERE document_id = ANY($1) AND embedding IS NULL`,
    [docIds]
  );
  check("ingested chunks always store an embedding", nullEmb[0].n === 0, `null embeddings=${nullEmb[0].n}`);

  // chunking + ordering
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