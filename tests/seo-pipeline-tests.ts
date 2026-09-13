/**
 * Phase 9 — SEO pipeline PURE tests (no DB): keyword normalization, dedup
 * hash stability, the deterministic harvest (research phrases + competitor
 * brands, frequency-ranked, deduped, capped), rule-based recommendations
 * (keyword gap + content coverage, ALWAYS evidence-backed), LLM output
 * sanitization (evidence-less recommendations dropped, not stored), and the
 * analysis material/user-prompt builders (citation numbering).
 */
import {
  deterministicRecommendations,
  buildAnalysisMaterial,
  buildAnalysisUserPrompt,
  harvestKeywords,
  sanitizeLlmRecommendations,
} from "../lib/seo/pipeline";
import {
  dedupHashFor,
  normalizeKeyword,
  STOPWORDS,
} from "../lib/seo/service";
import type { SeoScanContext } from "../lib/seo/service";
import type { SeoRecommendationDraft } from "../lib/seo/types";

let failures = 0;
function check(name: string, cond: boolean, detail = "") {
  console.log(`${cond ? "PASS" : "FAIL"} ${name}${detail ? " :: " + detail : ""}`);
  if (!cond) failures++;
}

function ctx(overrides: Partial<SeoScanContext> = {}): SeoScanContext {
  return {
    businessUnitId: 1,
    websiteUrl: "https://example.com",
    ownedKeywords: [],
    researchExcerpts: [],
    contentTitles: [],
    competitorNames: [],
    competitorUrls: new Map(),
    competitorKeywords: [],
    ...overrides,
  };
}

// ---------- normalization + hashing ----------
check("normalize: lowercase + collapses whitespace", normalizeKeyword("  Modular   Homes ") === "modular homes");
check("normalize: stable across case/spacing", normalizeKeyword("MODULAR   homes") === normalizeKeyword("modular homes"));
check("dedup hash: stable for identical advice", dedupHashFor(1, "gap", "https://x.com", 'Close gap: "modular"') === dedupHashFor(1, "gap", "https://x.com", 'Close gap: "modular"'));
check("dedup hash: differs by kind", dedupHashFor(1, "gap", null, "t") !== dedupHashFor(1, "content", null, "t"));
check("dedup hash: differs by BU", dedupHashFor(1, "gap", null, "t") !== dedupHashFor(2, "gap", null, "t"));
check("dedup hash: differs by target", dedupHashFor(1, "gap", "https://a.com", "t") !== dedupHashFor(1, "gap", "https://b.com", "t"));
check("dedup hash: title case-insensitive", dedupHashFor(1, "gap", null, "Close GAP") === dedupHashFor(1, "gap", null, "close gap"));

// ---------- deterministic harvest ----------
const harvested = harvestKeywords(ctx({
  researchExcerpts: [
    { researchItemId: 1, title: "Modular homes housing supply", summary: "Modular homes reduce housing supply pressure in Kuwait", url: null, score: 90 },
  ],
  competitorNames: ["RivalCo"],
  competitorKeywords: ["rivalco pricing update", "modular homes"],
}));
check("harvest: produces research phrases", harvested.some((h) => h.keyword.includes("modular homes") && h.source === "research"));
check("harvest: competitor brand tracked as scan source", harvested.some((h) => h.keyword === "RivalCo" && h.source === "scan"));
check("harvest: competitor fragments deduped against research phrases",
  harvested.filter((h) => normalizeKeyword(h.keyword) === "modular homes").length === 1);
check("harvest: no stopwords-only fragments", harvested.every((h) => {
  const words = normalizeKeyword(h.keyword).split(" ");
  return words.every((w) => w.length >= 3 && !STOPWORDS.has(w));
}));
check("harvest: empty BU → empty harvest", harvestKeywords(ctx()).length === 0);

const many = harvestKeywords(ctx({
  researchExcerpts: Array.from({ length: 10 }, (_, i) => ({
    researchItemId: i + 1,
    title: `Topic ${i} alpha beta gamma delta epsilon`,
    summary: "",
    url: null,
    score: 80,
  })),
}));
check("harvest: capped at MAX_HARVEST=40", many.length <= 40);

// ---------- deterministic recommendations ----------
const gapRecs = deterministicRecommendations(ctx({
  competitorNames: ["RivalCo"],
  competitorUrls: new Map([["RivalCo", "https://rivalco.example"]]),
  competitorKeywords: ["rivalco warranty program", "rivalco financing"],
}));
check("gap: brand rule + one recommendation per untracked competitor term",
  gapRecs.filter((r) => r.kind === "gap").length === 3,
  `n=${gapRecs.length}`);
check("gap: brand rec cites the registry entry",
  gapRecs.some((r) => r.title.includes('"RivalCo"') && r.evidence.some((e) => e.label.includes("Competitor registry") && e.url === "https://rivalco.example")));
check("gap: every recommendation carries evidence",
  gapRecs.every((r) => r.evidence.length >= 1 && r.evidence.every((e) => e.label.trim() !== "" && e.note.trim() !== "")));
check("gap: term recs name the term in the title",
  gapRecs.filter((r) => r.title.includes("rivalco warranty program") || r.title.includes("rivalco financing")).length === 2);

const covered = deterministicRecommendations(ctx({
  researchExcerpts: [
    { researchItemId: 7, title: "Housing prices cooling", summary: "", url: "https://src.example/1", score: 85 },
  ],
  contentTitles: [{ id: 3, title: "Housing prices cooling across the region", status: "DRAFT" }],
}));
check("coverage: finding already covered by a content item is skipped",
  !covered.some((r) => r.detail.includes("Housing prices cooling")));

// brand coverage: a content item overlapping the competitor brand suppresses the brand rule
const brandCovered = deterministicRecommendations(ctx({
  competitorNames: ["RivalCo"],
  contentTitles: [{ id: 5, title: "RivalCo versus our modular stack", status: "DRAFT" }],
}));
check("gap: brand rule suppressed when content covers the brand",
  !brandCovered.some((r) => r.title.includes('"RivalCo"')));

const coverageRecs = deterministicRecommendations(ctx({
  researchExcerpts: [
    { researchItemId: 7, title: "Housing prices cooling", summary: "", url: "https://src.example/1", score: 85 },
  ],
  contentTitles: [],
}));
check("coverage: strong finding produces a content recommendation", coverageRecs.some((r) => r.kind === "content"));
check("coverage: evidence links the research item id",
  coverageRecs.every((r) => r.evidence.some((e) => e.researchItemId === 7)));

const lowScore = deterministicRecommendations(ctx({
  researchExcerpts: [
    { researchItemId: 9, title: "Weak signal topic", summary: "", url: null, score: 40 },
  ],
}));
check("coverage: weak findings (score < 70) are not recommended", lowScore.length === 0);

// cap: gap + coverage together cannot exceed MAX_DETERMINISTIC=6
const flood = deterministicRecommendations(ctx({
  competitorNames: ["A"],
  competitorKeywords: Array.from({ length: 12 }, (_, i) => `competitor term ${i}`),
  researchExcerpts: Array.from({ length: 10 }, (_, i) => ({
    researchItemId: i + 1, title: `Finding ${i}`, summary: "", url: null, score: 95,
  })),
}));
check("deterministic recommendations are capped at 6", flood.length <= 6);

// ---------- LLM output sanitization ----------
const good: SeoRecommendationDraft = {
  kind: "on_page",
  title: "Add FAQ schema to service pages",
  detail: "The service pages have no FAQ structured data.",
  evidence: [{ label: "Site page", url: "https://example.com/services", note: "No FAQ schema present" }],
};
const evidenceLess: SeoRecommendationDraft = {
  kind: "gap",
  title: "No evidence here",
  detail: "A claim without any evidence.",
  evidence: [],
};
const emptyNote: SeoRecommendationDraft = {
  kind: "technical",
  title: "Broken note",
  detail: "Evidence note is empty.",
  evidence: [{ label: "Something", note: "   " }],
};
const badKind: SeoRecommendationDraft = {
  kind: "vibes" as never,
  title: "Wrong kind",
  detail: "Unknown kind.",
  evidence: [{ label: "L", note: "n" }],
};
const sanitized = sanitizeLlmRecommendations([good, evidenceLess, emptyNote, badKind]);
check("sanitize: valid recommendation kept", sanitized.kept.some((r) => r.title === "Add FAQ schema to service pages"));
check("sanitize: evidence-less recommendation dropped", !sanitized.kept.some((r) => r.title === "No evidence here"));
check("sanitize: empty-note evidence dropped", !sanitized.kept.some((r) => r.title === "Broken note"));
check("sanitize: unknown kind dropped", !sanitized.kept.some((r) => r.title === "Wrong kind"));
check("sanitize: 3 of 4 dropped", sanitized.dropped === 3);
check("sanitize: caps at 12", sanitizeLlmRecommendations(Array.from({ length: 20 }, (_, i) => ({
  ...good, title: `Rec ${i}`,
}))).kept.length === 12);

// ---------- analysis material + prompt ----------
const material = buildAnalysisMaterial(ctx({
  researchExcerpts: [{ researchItemId: 1, title: "Finding A", summary: "About A", url: "https://s.example/a", score: 80 }],
  contentTitles: [{ id: 2, title: "Existing piece", status: "DRAFT" }],
  competitorKeywords: ["rivalco warranty"],
}));
check("material: numbered [1..n] in order", material[0].index === 1 && material[1].index === 2 && material[2].index === 3);
const userPrompt = buildAnalysisUserPrompt(ctx({
  websiteUrl: "https://example.com",
  ownedKeywords: [],
  competitorNames: ["RivalCo"],
}), material);
check("prompt: cites the website", userPrompt.includes("https://example.com"));
check("prompt: lists competitors", userPrompt.includes("RivalCo"));
check("prompt: includes numbered sources", userPrompt.includes("[1] Research finding: Finding A") && userPrompt.includes("[3] Competitor intelligence term"));
check("prompt: demands evidence-citing JSON", userPrompt.includes("evidence citing the [n] sources"));

console.log(failures === 0 ? "\nALL PASS" : `\n${failures} FAILURES`);
process.exit(failures === 0 ? 0 : 1);
