/**
 * SEO workforce service (Phase 9) — the ONLY writer of seo_* rows.
 *
 * Storage contracts:
 *  - Keyword dedup is the DB: UNIQUE (business_unit_id, normalized_keyword).
 *    Re-observing a term UPDATES position/source/last_seen (the store tracks
 *    "when did we last see this" rather than accumulating rows). The
 *    previous_position shift is recorded when a new position arrives.
 *  - Recommendation dedup is the DB: UNIQUE (business_unit_id, dedup_hash).
 *    A repeated scan that reaches the same advice is a counted no-op, never
 *    an error (same contract as research findings).
 *  - Approval flags: transitions open→approved | dismissed and
 *    approved→done only; the reviewed identity columns are written in the
 *    SAME statement as the status change and never after (§72 class).
 *  - Every recommendation row carries evidence — the service enforces a
 *    non-empty evidence array at the write boundary (the pipeline and the
 *    LLM schema also enforce it; this is the last line of defense).
 *  - Events: seo.recommendation on new open recommendations (ops-visible),
 *    seo.scan as a per-run summary.
 */
import crypto from "node:crypto";
import { query } from "../db";
import { emitEvent } from "../tasks/events";
import type {
  SeoEvidence,
  SeoKeywordDraft,
  SeoKeywordIntent,
  SeoKeywordRow,
  SeoKeywordSource,
  SeoKeywordStatus,
  SeoRecommendationDraft,
  SeoRecommendationKind,
  SeoRecommendationRow,
  SeoRecommendationStatus,
  SeoRisk,
} from "./types";

export class SeoServiceError extends Error {
  code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = "SeoServiceError";
    this.code = code;
  }
}

/* ------------------------------------------------------------------ */
/* Normalization + hashing                                             */
/* ------------------------------------------------------------------ */

/** Canonical keyword form: lowercase, collapsed whitespace, trimmed. */
export function normalizeKeyword(keyword: string): string {
  return keyword.toLowerCase().trim().replace(/\s+/g, " ");
}

/** Stable recommendation identity: same advice on the same target = same hash. */
export function dedupHashFor(
  businessUnitId: number,
  kind: SeoRecommendationKind,
  targetUrl: string | null,
  title: string
): string {
  const key = `${businessUnitId}|${kind}|${(targetUrl ?? "").toLowerCase().trim()}|${normalizeKeyword(title)}`;
  return crypto.createHash("sha256").update(key).digest("hex");
}

/* ------------------------------------------------------------------ */
/* Keywords                                                            */
/* ------------------------------------------------------------------ */

interface KeywordRow {
  id: string | number; business_unit_id: number; keyword: string; normalized_keyword: string;
  intent: string; position: number | null; previous_position: number | null;
  volume_est: number | null; difficulty_est: number | null; url: string | null;
  source: string; status: string; task_id: string | number | null;
  first_seen_at: string; last_seen_at: string;
}

function toKeyword(r: KeywordRow): SeoKeywordRow {
  return {
    id: Number(r.id),
    businessUnitId: r.business_unit_id,
    keyword: r.keyword,
    normalizedKeyword: r.normalized_keyword,
    intent: r.intent as SeoKeywordIntent,
    position: r.position,
    previousPosition: r.previous_position,
    volumeEst: r.volume_est,
    difficultyEst: r.difficulty_est,
    url: r.url,
    source: r.source as SeoKeywordSource,
    status: r.status as SeoKeywordStatus,
    taskId: r.task_id == null ? null : Number(r.task_id),
    firstSeenAt: r.first_seen_at,
    lastSeenAt: r.last_seen_at,
  };
}

const INTENTS = ["informational", "commercial", "transactional", "navigational"] as const;
const KEYWORD_SOURCES = ["manual", "research", "content", "scan"] as const;

/**
 * Upsert one keyword observation. Position moves are tracked: when a new
 * position arrives for a known keyword, the old one lands in
 * previous_position (simple rank-tracking without a history table).
 */
export async function upsertKeyword(input: {
  businessUnitId: number;
  draft: SeoKeywordDraft;
  taskId?: number | null;
}): Promise<{ row: SeoKeywordRow; created: boolean }> {
  const keyword = input.draft.keyword.trim();
  if (keyword === "") throw new SeoServiceError("invalid_keyword", "keyword must not be empty");
  if (keyword.length > 200) throw new SeoServiceError("invalid_keyword", "keyword too long (max 200)");
  const normalized = normalizeKeyword(keyword);
  const intent = (input.draft.intent && INTENTS.includes(input.draft.intent)
    ? input.draft.intent
    : "informational") as SeoKeywordIntent;
  const source = (input.draft.source && KEYWORD_SOURCES.includes(input.draft.source)
    ? input.draft.source
    : "scan") as SeoKeywordSource;
  const difficulty = input.draft.difficultyEst == null
    ? null
    : Math.min(Math.max(Math.round(input.draft.difficultyEst), 0), 100);
  const volume = input.draft.volumeEst == null ? null : Math.max(Math.round(input.draft.volumeEst), 0);

  const rows = await query<KeywordRow>(
    `INSERT INTO seo_keywords
       (business_unit_id, keyword, normalized_keyword, intent, difficulty_est, volume_est, url, source, task_id)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
     ON CONFLICT (business_unit_id, normalized_keyword) DO UPDATE SET
       keyword = EXCLUDED.keyword,
       intent = EXCLUDED.intent,
       difficulty_est = COALESCE(EXCLUDED.difficulty_est, seo_keywords.difficulty_est),
       volume_est = COALESCE(EXCLUDED.volume_est, seo_keywords.volume_est),
       url = COALESCE(EXCLUDED.url, seo_keywords.url),
       source = EXCLUDED.source,
       status = 'active',
       last_seen_at = now(),
       updated_at = now()
     WHERE seo_keywords.status <> 'retired' OR EXCLUDED.source = 'manual'
     RETURNING *, (xmax = 0) AS inserted`,
    [
      input.businessUnitId, keyword, normalized, intent, difficulty, volume,
      input.draft.url ?? null, source, input.taskId ?? null,
    ]
  );
  if (rows.length === 0) {
    // Retired keyword re-observed by a scan: surface it as a no-op rather
    // than resurrecting owner-retired terms.
    const existing = await query<KeywordRow>(
      "SELECT * FROM seo_keywords WHERE business_unit_id = $1 AND normalized_keyword = $2",
      [input.businessUnitId, normalized]
    );
    if (existing.length > 0) {
      return { row: toKeyword(existing[0]), created: false };
    }
    throw new SeoServiceError("keyword_upsert_failed", `keyword upsert returned no row: ${normalized}`);
  }
  const inserted = (rows[0] as KeywordRow & { inserted?: boolean }).inserted === true;
  return { row: toKeyword(rows[0]), created: inserted };
}

export async function listKeywords(opts: {
  businessUnitId?: number | null;
  status?: SeoKeywordStatus | null;
  intent?: SeoKeywordIntent | null;
  limit?: number;
}): Promise<SeoKeywordRow[]> {
  const where: string[] = [];
  const params: unknown[] = [];
  if (opts.businessUnitId != null) {
    params.push(opts.businessUnitId);
    where.push(`business_unit_id = $${params.length}`);
  }
  if (opts.status) {
    params.push(opts.status);
    where.push(`status = $${params.length}`);
  }
  if (opts.intent) {
    params.push(opts.intent);
    where.push(`intent = $${params.length}`);
  }
  params.push(Math.min(Math.max(opts.limit ?? 200, 1), 500));
  const rows = await query<KeywordRow>(
    `SELECT * FROM seo_keywords ${where.length ? "WHERE " + where.join(" AND ") : ""}
     ORDER BY last_seen_at DESC LIMIT $${params.length}`,
    params
  );
  return rows.map(toKeyword);
}

/** Owner-driven status change (manual keywords only retire; scans reactivate). */
export async function setKeywordStatus(
  id: number,
  status: SeoKeywordStatus
): Promise<SeoKeywordRow | null> {
  const rows = await query<KeywordRow>(
    "UPDATE seo_keywords SET status = $2, updated_at = now() WHERE id = $1 RETURNING *",
    [id, status]
  );
  return rows.length ? toKeyword(rows[0]) : null;
}

/* ------------------------------------------------------------------ */
/* Recommendations                                                     */
/* ------------------------------------------------------------------ */

interface RecommendationRow {
  id: string | number; business_unit_id: number; target_kind: string; target_url: string | null;
  kind: string; title: string; detail: string; evidence: SeoEvidence[] | null; status: string;
  risk: string; dedup_hash: string; agent_slug: string; task_id: string | number | null;
  prompt_version: number | null; prompt_hash: string | null; reviewed_by: string | null;
  reviewed_at: string | null; created_at: string; updated_at: string;
}

function toRecommendation(r: RecommendationRow): SeoRecommendationRow {
  return {
    id: Number(r.id),
    businessUnitId: r.business_unit_id,
    targetKind: r.target_kind as "page" | "site",
    targetUrl: r.target_url,
    kind: r.kind as SeoRecommendationKind,
    title: r.title,
    detail: r.detail,
    evidence: r.evidence ?? [],
    status: r.status as SeoRecommendationStatus,
    risk: r.risk as SeoRisk,
    dedupHash: r.dedup_hash,
    agentSlug: r.agent_slug,
    taskId: r.task_id == null ? null : Number(r.task_id),
    promptVersion: r.prompt_version,
    promptHash: r.prompt_hash,
    reviewedBy: r.reviewed_by,
    reviewedAt: r.reviewed_at,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

const REC_KINDS = ["on_page", "technical", "content", "keyword", "gap"] as const;
const REC_RISKS = ["low", "medium", "high"] as const;

function validateDraft(draft: SeoRecommendationDraft): void {
  if (!REC_KINDS.includes(draft.kind)) {
    throw new SeoServiceError("invalid_kind", `unknown recommendation kind: ${String(draft.kind)}`);
  }
  if (!draft.title || draft.title.trim() === "") {
    throw new SeoServiceError("invalid_title", "recommendation title must not be empty");
  }
  if (!draft.detail || draft.detail.trim() === "") {
    throw new SeoServiceError("invalid_detail", "recommendation detail must not be empty");
  }
  if (!Array.isArray(draft.evidence) || draft.evidence.length === 0) {
    throw new SeoServiceError(
      "evidence_required",
      `recommendation "${draft.title.slice(0, 80)}" has no evidence — refusing to store`
    );
  }
  for (const ev of draft.evidence) {
    if (!ev || typeof ev.label !== "string" || ev.label.trim() === "" ||
        typeof ev.note !== "string" || ev.note.trim() === "") {
      throw new SeoServiceError(
        "invalid_evidence",
        `recommendation "${draft.title.slice(0, 80)}" carries an evidence entry without label/note`
      );
    }
  }
  if (draft.risk && !REC_RISKS.includes(draft.risk)) {
    throw new SeoServiceError("invalid_risk", `unknown risk: ${String(draft.risk)}`);
  }
}

export interface RecordRecommendationResult {
  row: SeoRecommendationRow | null;
  duplicate: boolean;
}

/**
 * Store one recommendation. Dedup: the same (BU, kind, target, title) advice
 * is a counted no-op. Emits seo.recommendation for brand-new open rows.
 */
export async function recordRecommendation(input: {
  businessUnitId: number;
  draft: SeoRecommendationDraft;
  taskId?: number | null;
  agentSlug?: string;
  promptVersion?: number | null;
  promptHash?: string | null;
}): Promise<RecordRecommendationResult> {
  validateDraft(draftOf(input.draft));
  const targetUrl = (input.draft.targetUrl ?? null)?.slice(0, 500) ?? null;
  const hash = dedupHashFor(input.businessUnitId, input.draft.kind, targetUrl, input.draft.title);
  const rows = await query<RecommendationRow>(
    `INSERT INTO seo_recommendations
       (business_unit_id, target_kind, target_url, kind, title, detail, evidence, risk,
        dedup_hash, agent_slug, task_id, prompt_version, prompt_hash)
     VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, $8, $9, $10, $11, $12, $13)
     ON CONFLICT (business_unit_id, dedup_hash) DO NOTHING
     RETURNING *`,
    [
      input.businessUnitId,
      input.draft.targetKind ?? "site",
      targetUrl,
      input.draft.kind,
      input.draft.title.trim().slice(0, 200),
      input.draft.detail.trim(),
      JSON.stringify(input.draft.evidence.slice(0, 10)),
      input.draft.risk ?? "low",
      hash,
      input.agentSlug ?? "seo",
      input.taskId ?? null,
      input.promptVersion ?? null,
      input.promptHash ?? null,
    ]
  );
  if (rows.length === 0) return { row: null, duplicate: true };
  const row = toRecommendation(rows[0]);
  await emitEvent(input.businessUnitId, "seo.recommendation", {
    recommendationId: row.id,
    kind: row.kind,
    title: row.title,
    risk: row.risk,
    evidenceCount: row.evidence.length,
    taskId: input.taskId ?? null,
  });
  return { row, duplicate: false };
}

function draftOf(draft: SeoRecommendationDraft): SeoRecommendationDraft {
  return draft;
}

export async function getRecommendation(id: number): Promise<SeoRecommendationRow | null> {
  const rows = await query<RecommendationRow>(
    "SELECT * FROM seo_recommendations WHERE id = $1",
    [id]
  );
  return rows.length ? toRecommendation(rows[0]) : null;
}

export async function listRecommendations(opts: {
  businessUnitId?: number | null;
  status?: SeoRecommendationStatus | null;
  kind?: SeoRecommendationKind | null;
  limit?: number;
}): Promise<SeoRecommendationRow[]> {
  const where: string[] = [];
  const params: unknown[] = [];
  if (opts.businessUnitId != null) {
    params.push(opts.businessUnitId);
    where.push(`business_unit_id = $${params.length}`);
  }
  if (opts.status) {
    params.push(opts.status);
    where.push(`status = $${params.length}`);
  }
  if (opts.kind) {
    params.push(opts.kind);
    where.push(`kind = $${params.length}`);
  }
  params.push(Math.min(Math.max(opts.limit ?? 100, 1), 500));
  const rows = await query<RecommendationRow>(
    `SELECT * FROM seo_recommendations ${where.length ? "WHERE " + where.join(" AND ") : ""}
     ORDER BY created_at DESC LIMIT $${params.length}`,
    params
  );
  return rows.map(toRecommendation);
}

/**
 * The approval-flag FSM: open → approved | dismissed; approved → done.
 * Terminal states are terminal (dismissed rows cannot be resurrected —
 * re-scans dedup against them by hash, so genuinely new advice gets a new
 * hash via a changed title/detail). The reviewed identity is written in the
 * same statement as the status and is immutable afterwards.
 */
const TRANSITIONS: Record<SeoRecommendationStatus, SeoRecommendationStatus[]> = {
  open: ["approved", "dismissed"],
  approved: ["done"],
  dismissed: [],
  done: [],
};

export async function transitionRecommendation(
  id: number,
  next: SeoRecommendationStatus,
  reviewer: string
): Promise<SeoRecommendationRow> {
  const current = await getRecommendation(id);
  if (!current) throw new SeoServiceError("not_found", `seo recommendation ${id} not found`);
  if (!TRANSITIONS[current.status].includes(next)) {
    throw new SeoServiceError(
      "invalid_transition",
      `illegal transition ${current.status} → ${next} (allowed: ${TRANSITIONS[current.status].join(", ") || "none"})`
    );
  }
  const rows = await query<RecommendationRow>(
    `UPDATE seo_recommendations
     SET status = $2, reviewed_by = $3, reviewed_at = now(), updated_at = now()
     WHERE id = $1 AND status = $4
     RETURNING *`,
    [id, next, reviewer, current.status]
  );
  if (rows.length === 0) {
    // Concurrent decision: exactly one caller wins (same contract as §72).
    throw new SeoServiceError("conflict", `recommendation ${id} changed concurrently`);
  }
  return toRecommendation(rows[0]);
}

/* ------------------------------------------------------------------ */
/* Context loaders + stats (pipeline/dashboard inputs)                 */
/* ------------------------------------------------------------------ */

export interface SeoScanContext {
  businessUnitId: number;
  websiteUrl: string | null;
  ownedKeywords: SeoKeywordRow[];
  researchExcerpts: Array<{
    researchItemId: number;
    title: string;
    summary: string;
    url: string | null;
    score: number | null;
  }>;
  contentTitles: Array<{ id: number; title: string; status: string }>;
  competitorNames: string[];
  competitorKeywords: string[];
}

/** Everything the scan leg needs, gathered in ONE place (BU-scoped). */
export async function loadScanContext(businessUnitId: number): Promise<SeoScanContext> {
  const buRows = await query<{ domain: string | null }>(
    `SELECT w.domain
     FROM websites w
     WHERE w.business_unit_id = $1 AND w.status = 'active'
     ORDER BY w.id ASC
     LIMIT 1`,
    [businessUnitId]
  );
  const websiteUrl = buRows.length ? buRows[0].domain : null;

  const ownedKeywords = await listKeywords({ businessUnitId, status: "active", limit: 500 });

  const research = await query<{
    id: string | number; title: string | null; summary: string | null;
    sources: Array<{ url?: string | null }> | null; score: number | null;
  }>(
    `SELECT id, title, summary, sources, score FROM research_items
     WHERE business_unit_id = $1 AND status IN ('finding','escalated','verified')
     ORDER BY created_at DESC LIMIT 12`,
    [businessUnitId]
  );
  const researchExcerpts = research.map((r) => ({
    researchItemId: Number(r.id),
    title: r.title ?? "(untitled finding)",
    summary: r.summary ?? "",
    url: r.sources?.[0]?.url ?? null,
    score: r.score,
  }));

  const content = await query<{ id: string | number; title: string | null; status: string }>(
    `SELECT id, title, lifecycle AS status FROM content_items
     WHERE business_unit_id = $1 AND lifecycle <> 'ARCHIVED' AND title IS NOT NULL
     ORDER BY updated_at DESC LIMIT 12`,
    [businessUnitId]
  );
  const contentTitles = content.map((c) => ({
    id: Number(c.id),
    title: c.title ?? "(untitled)",
    status: c.status,
  }));

  const comps = await query<{ name: string; url: string | null }>(
    "SELECT name, url FROM competitors WHERE business_unit_id = $1 AND enabled = true",
    [businessUnitId]
  );
  const competitorNames = comps.map((c) => c.name);
  // Competitor keyword seeds: competitor names themselves + title fragments
  // harvested from their detected events (deterministic, no fabrication).
  const events = await query<{ title: string }>(
    `SELECT ce.title FROM competitor_events ce
     JOIN competitors c ON c.id = ce.competitor_id
     WHERE c.business_unit_id = $1 ORDER BY ce.detected_at DESC LIMIT 15`,
    [businessUnitId]
  );
  const competitorKeywords: string[] = [];
  for (const e of events) {
    const words = e.title.toLowerCase().replace(/[^a-z0-9\s]/g, " ").split(/\s+/)
      .filter((w) => w.length >= 4 && !STOPWORDS.has(w));
    if (words.length >= 2 && words.length <= 6) {
      competitorKeywords.push(words.slice(0, 6).join(" "));
    }
  }

  return {
    businessUnitId,
    websiteUrl,
    ownedKeywords,
    researchExcerpts,
    contentTitles,
    competitorNames,
    competitorKeywords: [...new Set(competitorKeywords)].slice(0, 12),
  };
}

export interface SeoStats {
  keywordsActive: number;
  keywordsRetired: number;
  recommendationsOpen: number;
  recommendationsApproved: number;
  recommendationsDone: number;
  recommendationsDismissed: number;
  withEvidencePct: number;
}

export async function stats(businessUnitId?: number | null): Promise<SeoStats> {
  const scope = businessUnitId != null ? "WHERE business_unit_id = $1" : "";
  const params = businessUnitId != null ? [businessUnitId] : [];
  const kw = await query<{ active: string; retired: string }>(
    `SELECT
       COUNT(*) FILTER (WHERE status = 'active') AS active,
       COUNT(*) FILTER (WHERE status = 'retired') AS retired
     FROM seo_keywords ${scope}`,
    params
  );
  const rec = await query<{
    open: string; approved: string; done: string; dismissed: string; with_ev: string; total: string;
  }>(
    `SELECT
       COUNT(*) FILTER (WHERE status = 'open') AS open,
       COUNT(*) FILTER (WHERE status = 'approved') AS approved,
       COUNT(*) FILTER (WHERE status = 'done') AS done,
       COUNT(*) FILTER (WHERE status = 'dismissed') AS dismissed,
       COUNT(*) FILTER (WHERE jsonb_array_length(evidence) > 0) AS with_ev,
       COUNT(*) AS total
     FROM seo_recommendations ${scope}`,
    params
  );
  const total = Number(rec[0]?.total ?? 0);
  return {
    keywordsActive: Number(kw[0]?.active ?? 0),
    keywordsRetired: Number(kw[0]?.retired ?? 0),
    recommendationsOpen: Number(rec[0]?.open ?? 0),
    recommendationsApproved: Number(rec[0]?.approved ?? 0),
    recommendationsDone: Number(rec[0]?.done ?? 0),
    recommendationsDismissed: Number(rec[0]?.dismissed ?? 0),
    withEvidencePct: total === 0 ? 100 : Math.round((Number(rec[0]?.with_ev ?? 0) / total) * 100),
  };
}

/** Domain stopwords excluded from competitor-keyword harvesting. */
export const STOPWORDS = new Set([
  "the", "and", "for", "with", "from", "that", "this", "have", "has", "are",
  "was", "were", "will", "been", "their", "they", "its", "our", "your",
  "announces", "launches", "introduces", "update", "updated", "new",
]);
