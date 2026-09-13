/**
 * SEO pipeline (Phase 9) — keyword harvest + gap analysis + recommendations.
 *
 * Two legs, deliberately ordered so the scan NEVER returns empty-handed when
 * it has material to work with:
 *
 *  1. DETERMINISTIC (always runs, no LLM required):
 *     - keyword harvest from BU artifacts: research finding titles/summaries,
 *       content item titles, competitor names + competitor event fragments;
 *     - rule-based recommendations: keyword gap (competitor terms the site
 *       does not track) and content coverage (strong research findings with
 *       no matching content item). Every rule recommendation cites its
 *       platform artifact as evidence — the acceptance criterion is
 *       "recommendations appear with evidence", and this leg guarantees it
 *       even while the OpenAI account is unfunded.
 *
 *  2. LLM ANALYSIS (seo agent, versioned prompt, structured output): intent
 *     + difficulty estimates for keywords and richer on_page/technical
 *     recommendations. The LLM may return ambiguous=true; evidence-less
 *     recommendations are FILTERED (not stored) — the service layer is the
 *     hard backstop.
 *
 * The pipeline is PURE with respect to storage (same seam as research and
 * content): it takes the scan context and returns drafts; lib/seo/tasks
 * persists them. That keeps both legs unit-testable with a fake client.
 */
import { completeJSON } from "../ai/structured";
import type { LLMClient } from "../ai/types";
import { currentVersion, getAgentBySlug, promptHash } from "../agents/registry";
import {
  normalizeKeyword,
  STOPWORDS,
  type SeoScanContext,
} from "./service";
import {
  SEO_ANALYSIS_SCHEMA,
  type SeoAnalysis,
  type SeoKeywordDraft,
  type SeoRecommendationDraft,
  type SeoRecommendationKind,
} from "./types";

export interface SeoPrompt {
  version: number;
  systemPrompt: string;
}

const SEO_DEFAULT_PROMPT =
  `You are the SEO Agent. Given a website context, an owned keyword list, competitor keywords and SOURCE excerpts ` +
  `(research findings, site content), produce keyword intelligence and recommendations. For keywords: assign search ` +
  `intent (informational | commercial | transactional | navigational), an estimated difficulty 0-100, and the best ` +
  `target URL when the sources make one obvious. For recommendations: each must have a kind (on_page | technical | ` +
  `content | keyword | gap), a short imperative title, concrete detail, and evidence: every recommendation MUST cite ` +
  `the [n] sources or observed data points that support it (source title + URL + a one-line note on what it shows). ` +
  `A recommendation without evidence is worthless: do not emit it. Set ambiguous=true instead of inventing analysis ` +
  `when the material cannot support defensible conclusions. Never fabricate search volumes or rankings; volumes are ` +
  `estimates and must be marked est.`;

export async function loadSeoPrompt(): Promise<SeoPrompt> {
  try {
    const agent = await getAgentBySlug("seo");
    if (agent) {
      const v = await currentVersion(agent.id);
      if (v?.systemPrompt) return { version: v.version, systemPrompt: v.systemPrompt };
    }
  } catch {
    /* fall through to the code default */
  }
  return { version: 0, systemPrompt: SEO_DEFAULT_PROMPT };
}

export function fingerprint(prompt: SeoPrompt): { promptVersion: number; promptHash: string } {
  return { promptVersion: prompt.version, promptHash: promptHash(prompt.systemPrompt) };
}

/* ------------------------------------------------------------------ */
/* Deterministic keyword harvest                                       */
/* ------------------------------------------------------------------ */

const MIN_TOKENS = 2;
const MAX_TOKENS = 4;
const MAX_HARVEST = 40;

function tokens(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, " ")
    .split(/\s+/)
    .filter((w) => w.length >= 3 && !STOPWORDS.has(w));
}

function phrasesFrom(text: string, out: Map<string, number>): void {
  const words = tokens(text);
  for (let n = MIN_TOKENS; n <= MAX_TOKENS; n++) {
    for (let i = 0; i + n <= words.length; i++) {
      const phrase = words.slice(i, i + n).join(" ");
      if (phrase.length < 8 || phrase.length > 80) continue;
      out.set(phrase, (out.get(phrase) ?? 0) + 1);
    }
  }
}

export interface HarvestedKeyword extends SeoKeywordDraft {
  occurrences: number;
}

/**
 * Deterministic keyword harvest from BU artifacts. Frequency-ranked n-gram
 * phrases from research findings + content titles, plus competitor names
 * (brand-gap tracking). No fabrication: every keyword traces to a stored
 * artifact, which is exactly what makes the evidence chain auditable.
 */
export function harvestKeywords(ctx: SeoScanContext): HarvestedKeyword[] {
  const freq = new Map<string, number>();

  for (const r of ctx.researchExcerpts) {
    phrasesFrom(r.title, freq);
    if (r.summary) phrasesFrom(r.summary, freq);
  }
  for (const c of ctx.contentTitles) {
    phrasesFrom(c.title, freq);
  }

  const harvested: HarvestedKeyword[] = [];
  const seen = new Set<string>();

  // Research-derived keywords (highest signal).
  for (const [phrase, count] of [...freq.entries()].sort((a, b) => b[1] - a[1])) {
    if (harvested.length >= MAX_HARVEST) break;
    const normalized = normalizeKeyword(phrase);
    if (seen.has(normalized)) continue;
    seen.add(normalized);
    harvested.push({ keyword: phrase, source: "research", occurrences: count });
  }

  // Competitor brands: always tracked so gap analysis has a stable base,
  // even on a BU with no research yet.
  for (const name of ctx.competitorNames) {
    const normalized = normalizeKeyword(name);
    if (name.trim() === "" || seen.has(normalized)) continue;
    seen.add(normalized);
    harvested.push({
      keyword: name.trim(),
      source: "scan",
      occurrences: 1,
    });
  }

  // Competitor event fragments (already normalized by the context loader;
  // re-filtered here defensively so no stopword sneaks into the store).
  for (const ck of ctx.competitorKeywords) {
    const cleaned = tokens(ck).join(" ");
    if (cleaned.split(" ").length < MIN_TOKENS) continue;
    const normalized = normalizeKeyword(cleaned);
    if (seen.has(normalized) || harvested.length >= MAX_HARVEST) continue;
    seen.add(normalized);
    harvested.push({ keyword: cleaned, source: "scan", occurrences: 1 });
  }

  return harvested;
}

/* ------------------------------------------------------------------ */
/* Deterministic recommendations (gap + content coverage)              */
/* ------------------------------------------------------------------ */

const MAX_DETERMINISTIC = 6;

export function deterministicRecommendations(ctx: SeoScanContext): SeoRecommendationDraft[] {
  const out: SeoRecommendationDraft[] = [];
  const owned = new Map(ctx.ownedKeywords.map((k) => [k.normalizedKeyword, k]));
  const contentText = ctx.contentTitles.map((c) => normalizeKeyword(c.title)).join(" | ");

  // Rule 1 — brand gap: a tracked competitor with NO content item covering
  // its brand term is a standing comparison/alternative-page opportunity.
  // Evidence: the competitor registry entry + the keyword-store observation.
  // Fires consistently until content actually covers the brand (dedup keeps
  // one row per competitor), which is the point: the advice is still open.
  for (const name of ctx.competitorNames) {
    if (out.length >= MAX_DETERMINISTIC) break;
    const trimmed = name.trim();
    if (trimmed === "") continue;
    const normalized = normalizeKeyword(trimmed);
    const covered = contentText
      .split(" | ")
      .some((t) => t.length > 0 && overlap(normalized, t));
    if (covered) continue;
    const kwRow = owned.get(normalized);
    const evidence: SeoRecommendationDraft["evidence"] = [
      {
        label: `Competitor registry: ${trimmed}`,
        url: ctx.competitorUrls.get(trimmed) ?? ctx.websiteUrl,
        note: `The competitor registry tracks "${trimmed}" as an active competitor.`,
      },
      {
        label: `Keyword store: "${normalized}"`,
        url: null,
        note: kwRow
          ? `The keyword store tracks the brand term (source: ${kwRow.source}) with no target URL assigned.`
          : "The brand term is not yet tracked in the keyword store.",
      },
    ];
    out.push({
      kind: "gap",
      title: `Create comparison content targeting competitor brand "${trimmed}"`,
      detail:
        `The competitor registry tracks "${trimmed}", but no content item covers this brand term. ` +
        `Comparison and alternative pages ("us vs ${trimmed}") are a proven route for high-intent ` +
        `search traffic. Route a brief through the content workforce once a positioning angle exists.`,
      evidence,
      risk: "low",
      targetKind: "site",
      targetUrl: ctx.websiteUrl,
    });
  }

  // Rule 2 — competitor-term gap: event-derived competitor terms whose
  // keyword-store row has no target URL yet. Evidence = the tracked activity
  // fragment + the store observation. (Pre-LLM scans still surface these.)
  for (const ck of ctx.competitorKeywords) {
    if (out.length >= MAX_DETERMINISTIC) break;
    const normalized = normalizeKeyword(ck);
    if (normalized === "") continue;
    const kwRow = owned.get(normalized);
    if (kwRow?.url) continue; // already targeted — no gap
    const competitor = ctx.competitorNames.find((n) => normalizeKeyword(n).length > 0) ?? null;
    out.push({
      kind: "gap",
      title: `Evaluate targeting "${ck}"`,
      detail:
        `Competitor intelligence surfaces the term "${ck}", which has no target URL in the keyword ` +
        `store. Evaluate it for targeting (content, landing page or category page) and assign the ` +
        `target once a decision exists. Evidence comes from monitored competitor activity, not ` +
        `search-volume estimates.`,
      evidence: [
        {
          label: competitor ? `Competitor intelligence: ${competitor}` : "Competitor intelligence",
          url: ctx.websiteUrl,
          note: `The term "${ck}" appears in tracked competitor activity.`,
        },
        {
          label: `Keyword store: "${normalized}"`,
          url: null,
          note: kwRow ? `Tracked (source: ${kwRow.source}) with no target URL assigned.` : "Not yet tracked in the keyword store.",
        },
      ],
      risk: "low",
      targetKind: "site",
      targetUrl: ctx.websiteUrl,
    });
  }

  // Rule 3 — content coverage: strong research findings with no matching
  // content item. Evidence = the finding itself (title + source URL).
  for (const r of ctx.researchExcerpts) {
    if (out.length >= MAX_DETERMINISTIC) break;
    if (r.score != null && r.score < 70) continue;
    const normalizedTitle = normalizeKeyword(r.title);
    // Skip findings whose topic is already covered by an existing content item.
    const covered = contentText
      .split(" | ")
      .some((t) => t.length > 0 && overlap(normalizedTitle, t));
    if (covered) continue;
    out.push({
      kind: "content",
      title: `Create content from research: ${r.title.slice(0, 80)}`,
      detail:
        `Research finding "${r.title}" scored ${r.score ?? "n/a"}/100 and has no matching content item. ` +
        `Route it through the content workforce (strategy → content → fact_check) to turn the ` +
        `cited finding into an approval-gated article targeting the finding's topic.`,
      evidence: [
        {
          label: `Research finding: ${r.title.slice(0, 100)}`,
          url: r.url,
          note: `Score ${r.score ?? "n/a"}/100 finding from the research workforce; no content item currently covers this topic.`,
          researchItemId: r.researchItemId,
        },
      ],
      risk: "low",
      targetKind: "site",
      targetUrl: ctx.websiteUrl,
    });
  }

  return out;
}

/** Token-overlap heuristic: does a content title already touch the finding? */
function overlap(a: string, b: string): boolean {
  const at = new Set(a.split(" ").filter((w) => w.length >= 4));
  const bt = new Set(b.split(" ").filter((w) => w.length >= 4));
  if (at.size === 0 || bt.size === 0) return false;
  let shared = 0;
  for (const t of at) if (bt.has(t)) shared++;
  return shared / Math.min(at.size, bt.size) >= 0.5;
}

/* ------------------------------------------------------------------ */
/* LLM analysis leg                                                    */
/* ------------------------------------------------------------------ */

export interface AnalysisMaterial {
  index: number;
  label: string;
  url: string | null;
  snippet: string;
}

/** Numbered SOURCE list the LLM must cite ([n]) in its evidence. */
export function buildAnalysisMaterial(ctx: SeoScanContext): AnalysisMaterial[] {
  const material: AnalysisMaterial[] = [];
  for (const r of ctx.researchExcerpts) {
    material.push({
      index: material.length + 1,
      label: `Research finding: ${r.title}`,
      url: r.url,
      snippet: r.summary.slice(0, 400),
    });
  }
  for (const c of ctx.contentTitles) {
    material.push({
      index: material.length + 1,
      label: `Content item: ${c.title}`,
      url: null,
      snippet: `Existing content item (status ${c.status}) titled "${c.title}".`,
    });
  }
  for (const ck of ctx.competitorKeywords) {
    material.push({
      index: material.length + 1,
      label: `Competitor intelligence term: ${ck}`,
      url: null,
      snippet: `Tracked competitor activity mentions "${ck}"; the owned keyword store does not track it.`,
    });
  }
  return material;
}

export function buildAnalysisUserPrompt(ctx: SeoScanContext, material: AnalysisMaterial[]): string {
  const owned = ctx.ownedKeywords.slice(0, 50).map((k) => k.keyword).join(", ");
  const lines: string[] = [];
  lines.push(`WEBSITE: ${ctx.websiteUrl ?? "(no website linked to this business unit)"}`);
  lines.push(`OWNED KEYWORDS: ${owned === "" ? "(none tracked yet)" : owned}`);
  lines.push(
    `COMPETITORS: ${ctx.competitorNames.length ? ctx.competitorNames.join(", ") : "(none registered)"}`
  );
  lines.push("\nSOURCE EXCERPTS:\n");
  for (const m of material) {
    lines.push(`[${m.index}] ${m.label}\nURL: ${m.url ?? "n/a"}\n${m.snippet}`);
  }
  lines.push(
    "\nProduce the JSON analysis now: keywords (new terms worth tracking, with intent + est. difficulty) " +
      "and recommendations (each with kind, title, detail, risk and evidence citing the [n] sources)."
  );
  return lines.join("\n");
}

export interface AnalysisOutcome {
  analysis: SeoAnalysis | null;
  error?: string;
}

/**
 * The LLM leg. Throws propagate to the task handler, which degrades to the
 * deterministic legs (keywords already harvested; rule recommendations).
 */
export async function runSeoAnalysis(
  ctx: SeoScanContext,
  llm: LLMClient,
  prompt: SeoPrompt
): Promise<AnalysisOutcome> {
  const material = buildAnalysisMaterial(ctx);
  if (material.length === 0 && ctx.ownedKeywords.length === 0) {
    return { analysis: null, error: "no_material" };
  }
  const out = await completeJSON<SeoAnalysis>(
    llm,
    [
      { role: "system", content: prompt.systemPrompt },
      { role: "user", content: buildAnalysisUserPrompt(ctx, material) },
    ],
    SEO_ANALYSIS_SCHEMA,
    { temperature: 0 }
  );
  return { analysis: out.value };
}

/** Evidence-less LLM recommendations are dropped here, not stored. */
export function sanitizeLlmRecommendations(
  recommendations: SeoRecommendationDraft[]
): { kept: SeoRecommendationDraft[]; dropped: number } {
  const kept: SeoRecommendationDraft[] = [];
  let dropped = 0;
  for (const rec of recommendations.slice(0, 12)) {
    const kindOk = ["on_page", "technical", "content", "keyword", "gap"].includes(rec.kind);
    const evOk = Array.isArray(rec.evidence) && rec.evidence.some(
      (e) => e && typeof e.label === "string" && e.label.trim() !== "" &&
             typeof e.note === "string" && e.note.trim() !== ""
    );
    if (!kindOk || !rec.title?.trim() || !rec.detail?.trim() || !evOk) {
      dropped++;
      continue;
    }
    kept.push({
      ...rec,
      kind: rec.kind as SeoRecommendationKind,
      title: rec.title.trim().slice(0, 200),
      detail: rec.detail.trim(),
      evidence: rec.evidence.filter(
        (e) => typeof e.label === "string" && e.label.trim() !== "" && typeof e.note === "string"
      ),
    });
  }
  return { kept, dropped };
}
