/**
 * Phase 5 — structure-aware chunking unit tests (pure, no DB).
 * Covers: heading attachment, paragraph packing, target-size bounds,
 * word-boundary hard splits, overlap tails, tail merging, CJK safety,
 * empty input, and legacy flat parity.
 */
import { chunkStructured, chunkFlat } from "../lib/knowledge/chunking";

let failures = 0;
function check(name: string, cond: boolean, detail = "") {
  console.log(`${cond ? "PASS" : "FAIL"} ${name}${detail ? " :: " + detail : ""}`);
  if (!cond) failures++;
}

const doc = [
  "# Filing Deadlines",
  "",
  "Federal returns are due on April fifteenth for most taxpayers.",
  "",
  "Extensions grant six additional months but not extra time to pay.",
  "",
  "## State Obligations",
  "",
  "State filing mirrors the federal calendar in most jurisdictions.",
  "",
  "Some states require separate estimated payments each quarter.",
].join("\n");

try {
  // basic shape
  const chunks = chunkStructured(doc, { targetSize: 200, overlap: 40 });
  check("produces multiple chunks", chunks.length > 1, `n=${chunks.length}`);
  check(
    "respects target size on packed chunks",
    chunks.every((c) => c.length <= 260),
    chunks.map((c) => c.length).join(",")
  );
  check(
    "headings stay attached to their section",
    chunks.some((c) => c.startsWith("# Filing Deadlines")) &&
      chunks.some((c) => c.includes("## State Obligations\nState filing mirrors")),
    chunks.map((c) => c.split("\n")[0].slice(0, 30)).join(" | ")
  );
  check(
    "consecutive chunks share an overlap tail",
    chunks.length > 1 && chunks[0].includes(chunks[1].split("\n")[0].split(/\s+/).filter(Boolean).slice(0, 3).join(" ")),
    `c1 head="${chunks[1].slice(0, 40).replace(/\n/g, " ")}"`
  );

  // empty + whitespace input → single empty chunk (never zero chunks)
  check("empty input yields single empty chunk", JSON.stringify(chunkStructured("")) === JSON.stringify([""]));
  check("whitespace input yields single empty chunk", chunkStructured("   \n  \n ").length === 1);

  // giant single paragraph hard-splits on word boundaries (no mid-word cuts)
  const giant = Array.from({ length: 120 }, (_, i) => `word${i}`).join(" ");
  const giantChunks = chunkStructured(giant, { targetSize: 120, overlap: 0 });
  check("giant paragraph splits", giantChunks.length > 1, `n=${giantChunks.length}`);
  check(
    "hard split stays within bounds",
    giantChunks.slice(0, -1).every((c) => c.length <= 125),
    giantChunks.map((c) => c.length).join(",")
  );
  check(
    "no words destroyed by hard split",
    giantChunks.join(" ").includes("word0") && giantChunks.join(" ").includes("word119")
  );

  // undersized tail merges into previous chunk
  const tailDoc = `${"a".repeat(300)}\n\n${"b".repeat(10)}`;
  const tailChunks = chunkStructured(tailDoc, { targetSize: 320, overlap: 0, minTailMerge: 80 });
  check("undersized tail merges into previous chunk", tailChunks.length === 1 && tailChunks[0].includes("bbbb"), `n=${tailChunks.length}`);

  // overlap disabled
  const noOverlap = chunkStructured(doc, { targetSize: 200, overlap: 0 });
  check(
    "overlap can be disabled",
    noOverlap.length < 2 || !noOverlap[1].startsWith(noOverlap[0].slice(-30)),
  );

  // CJK: no ASCII spaces — hard cut fallback still chunks
  const cjk = "联邦所得税申报期限为四月十五日。".repeat(80);
  const cjkChunks = chunkStructured(cjk, { targetSize: 100, overlap: 0 });
  check("CJK text chunks without spaces", cjkChunks.length > 1, `n=${cjkChunks.length}`);

  // flat parity with the legacy slicer
  const flat = chunkFlat("abcdefghij".repeat(200), 800);
  check("flat slicer matches legacy 800 math", flat.length === Math.ceil(2000 / 800) && flat.every((c) => c.length <= 800), `n=${flat.length}`);
  check("flat empty parity", JSON.stringify(chunkFlat("")) === JSON.stringify([""]));

  // structured vs flat sanity on legal text: structured keeps heading context
  const legal = "## Jurisdiction X\n\nThe statute of limitations is three years.\n\n" + "Filler sentence for padding the chunk body. ".repeat(60);
  const structured = chunkStructured(legal, { targetSize: 400, overlap: 0 });
  check("structured chunking preserves legal heading context", structured.some((c) => c.includes("Jurisdiction X")));
} finally {
  /* pure suite */
}

if (failures > 0) { console.error(`${failures} FAIL`); process.exit(1); }
console.log("KNOWLEDGE CHUNKING SUITE PASS");
