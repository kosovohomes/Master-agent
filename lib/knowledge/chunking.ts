/**
 * Structure-aware chunking (Phase 5 §9.3: "structure-aware chunking with
 * overlap — 800-char blind slicing materially harms legal-domain retrieval").
 *
 * Design:
 *   1. Split text into logical blocks — markdown/ATX headings stay attached
 *      to the section they introduce; blank-line-separated paragraphs are
 *      atomic units.
 *   2. Pack blocks into chunks up to `targetSize`; a block longer than the
 *      target is hard-split on word boundaries (never mid-word).
 *   3. Each chunk after the first begins with an OVERLAP tail (~`overlap`
 *      chars, word-snapped) of the previous chunk — context survives chunk
 *      boundaries, so a statute clause cut in half remains retrievable.
 *   4. An undersized final tail merges back into the previous chunk.
 *   5. Empty input yields a single empty chunk (same contract as the legacy
 *      flat slicer — callers never receive a zero-chunk document).
 *
 * The legacy 800-char flat slicer in lib/rag/ingest.ts is intentionally
 * untouched (test-proven, checksum-stable); chunkFlat() here reproduces it
 * for callers that explicitly opt out of structure awareness.
 */

export interface ChunkOptions {
  /** Max characters per chunk (default 800 — matches the legacy chunk size). */
  targetSize?: number;
  /** Approximate character overlap between consecutive chunks (default 150). */
  overlap?: number;
  /** A final chunk shorter than this merges into the previous one (default 80). */
  minTailMerge?: number;
}

const DEFAULT_TARGET = 800;
const DEFAULT_OVERLAP = 150;
const DEFAULT_MIN_TAIL = 80;

interface Block {
  heading: string;
  body: string;
}

function splitBlocks(text: string): Block[] {
  const lines = text.replace(/\r\n?/g, "\n").split("\n");
  const blocks: Block[] = [];
  let heading = "";
  let bodyLines: string[] = [];

  const flush = () => {
    const body = bodyLines.join("\n").trim();
    if (heading !== "" || body !== "") blocks.push({ heading, body });
    bodyLines = [];
  };

  for (const line of lines) {
    const headingMatch = /^\s{0,3}(#{1,6}\s+.+?)\s*$/.exec(line);
    if (headingMatch) {
      flush();
      heading = headingMatch[1];
      continue;
    }
    if (line.trim() === "") {
      flush();
      continue;
    }
    bodyLines.push(line);
  }
  flush();
  return blocks;
}

/** Word-snapped overlap tail of a chunk (falls back to a hard cut for CJK). */
function overlapTail(chunk: string, overlap: number): string {
  if (overlap <= 0 || chunk === "") return "";
  const slice = chunk.slice(-overlap);
  const ws = slice.search(/\s/);
  const tail = ws === -1 ? slice : slice.slice(ws + 1);
  return tail.length > 0 ? tail : slice;
}

function collapse(text: string): string {
  return text.replace(/[ \t]+/g, " ").replace(/ ?\n ?/g, "\n").trim();
}

export function chunkStructured(input: string, opts: ChunkOptions = {}): string[] {
  const target = Math.max(120, opts.targetSize ?? DEFAULT_TARGET);
  const overlap = Math.min(Math.max(0, opts.overlap ?? DEFAULT_OVERLAP), Math.floor(target / 3));
  const minTail = opts.minTailMerge ?? DEFAULT_MIN_TAIL;

  const blocks = splitBlocks(input);
  if (blocks.length === 0) return [""];

  // Build raw content units: heading (repeated per section chunk) + paragraph.
  const units: string[] = [];
  for (const block of blocks) {
    const body = collapse(block.body);
    if (block.heading !== "") {
      units.push(`${block.heading}\n${body}`.trim());
    } else if (body !== "") {
      units.push(body);
    }
  }
  if (units.length === 0) return [""];

  // Pack units into chunks. A unit longer than the target is hard-split.
  const rawChunks: string[] = [];
  let current = "";
  const pushCurrent = () => {
    const trimmed = current.trim();
    if (trimmed !== "") rawChunks.push(trimmed);
    current = "";
  };

  for (const unit of units) {
    let piece = unit;
    if (piece.length > target) {
      // Flush what we have, then word-split the giant unit.
      pushCurrent();
      let rest = piece;
      while (rest.length > target) {
        let cut = rest.lastIndexOf(" ", target);
        if (cut < Math.floor(target * 0.5)) cut = target; // no space → hard cut
        rawChunks.push(rest.slice(0, cut).trim());
        rest = rest.slice(cut).trim();
      }
      current = rest;
      continue;
    }
    if (current === "") {
      current = piece;
    } else if (current.length + 1 + piece.length <= target) {
      current += `\n${piece}`;
    } else {
      pushCurrent();
      current = piece;
    }
  }
  pushCurrent();

  if (rawChunks.length === 0) return [""];

  // Merge an undersized tail into the previous chunk (bounded overshoot).
  if (rawChunks.length > 1 && rawChunks[rawChunks.length - 1].length < minTail) {
    const tail = rawChunks.pop() as string;
    rawChunks[rawChunks.length - 1] += `\n${tail}`;
  }

  // Prepend the overlap tail to every chunk after the first.
  const withOverlap: string[] = [rawChunks[0]];
  for (let i = 1; i < rawChunks.length; i++) {
    const tail = overlapTail(rawChunks[i - 1], overlap);
    withOverlap.push(tail !== "" ? `${tail}\n${rawChunks[i]}` : rawChunks[i]);
  }
  return withOverlap;
}

/** Legacy-compatible flat slicer (800-char, whitespace-collapsed). */
export function chunkFlat(text: string, size = 800): string[] {
  const out: string[] = [];
  let rest = text.replace(/\s+/g, " ").trim();
  while (rest.length > 0) {
    out.push(rest.slice(0, size));
    rest = rest.slice(size);
  }
  return out.length > 0 ? out : [""];
}
