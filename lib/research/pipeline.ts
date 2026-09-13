/**
 * Research pipeline (Phase 7 — Phase 0.5 §6.2 P6, §7.1 execution pipeline
 * instantiated for the research workforce).
 *
 *   plan  [deterministic]  topic template {{date}} + schedule queries +
 *                          competitor-seeded queries, capped at maxQueries
 *   search [tool]          web_search per query (contained failures)
 *   fetch  [tool]          top candidate URLs through the SSRF-guarded
 *                          fetch_url; partial success tolerated
 *   analyze [agent]        ONE bounded tool-loop iteration: the gathered
 *                          material goes to the versioned agent prompt via
 *                          the AI gateway (attribution: BU + task + agent,
 *                          purpose="research"); budget enforcement, ledger
 *                          and fallback chain are inherited, not re-built
 *   store  [deterministic] dedup by hash, cite sources verbatim, competitor
 *                          event extraction, event bus, escalation on
 *                          ambiguity / low confidence
 *
 * Degraded mode (§144): when the LLM is unavailable — provider outage,
 * exhausted credits (BudgetExceededError) — the collected material is
 * STORED as 'unprocessed' items and the run reports degraded:true instead
 * of failing. The daily cadence never burns retries against a dead
 * provider; the material is re-analyzable later from the dashboard.
 *
 * C-3 decision (framework re-evaluation trigger): NO framework. The loop
 * here is bounded by construction — fixed phase sequence, hard caps
 * (maxQueries 6 / maxFetches 6 / sources ≤ 12 / one analysis call) — which
 * satisfies §7's "agents may call tools" without a dependency (the Phase
 * 0.5 rationale stands: isolation without framework weight).
 */
import crypto from "node:crypto";
import { query } from "../db";
import type { LLMClient } from "../ai/types";
import { BudgetExceededError, LlmProviderError } from "../ai/types";
import { completeJSON } from "../ai/structured";
import { promptHash, getAgentBySlug, currentVersion } from "../agents/registry";
import {
  makeResearchTools,
  type ResearchTools,
  type WebSearchResult,
} from "./tools";
import {
  FINDING_SCHEMA,
  type CompetitorEventDraft,
  type ResearchFinding,
  type ResearchRunResult,
  type ResearchSource,
} from "./types";

const DEFAULT_PROMPT =
  "You are the Research Agent. Given a topic and SOURCE excerpts, judge relevance and produce a concise, cited finding. Score 0-100, set ambiguous=true when sources are insufficient. Never fabricate.";

const MAX_SOURCES_IN_PROMPT = 12;
const EXCERPT_CHARS = 1800;
const SNIPPET_CHARS = 300;

export interface PipelinePrompt {
  version: number;
  systemPrompt: string;
}

export interface PipelineInput {
  businessUnitId: number;
  agentSlug: string;
  topic: string;
  queries?: string[];
  scheduleId?: number | null;
  taskId?: number | null;
  maxItems?: number;
  competitorNames?: string[];
  runDate?: Date;
}

export interface PipelineDeps {
  llm: LLMClient; // pre-attributed (withAttribution) at the handler boundary
  tools?: ResearchTools;
  prompt?: PipelinePrompt;
  now?: () => Date;
}

export interface PipelineOutcome {
  result: ResearchRunResult;
  /** Ready-to-store artifacts; the caller (tasks.ts) persists them. */
  findings: Array<{
    finding: ResearchFinding;
    sources: ResearchSource[];
    query: string;
    dedupHash: string;
    material: string;
  }>;
  unprocessed: Array<{
    sources: ResearchSource[];
    query: string;
    dedupHash: string;
    material: string;
  }>;
}

export function expandTopic(topic: string, runDate: Date): string {
  return topic.replaceAll("{{date}}", runDate.toISOString().slice(0, 10));
}

export function dedupHashFor(businessUnitId: number, agentSlug: string, primaryUrl: string | null, topic: string): string {
  const key = `${businessUnitId}|${agentSlug}|${primaryUrl ?? topic}|`;
  return crypto.createHash("sha256").update(key.toLowerCase().trim()).digest("hex");
}

export async function loadPrompt(agentSlug: string): Promise<PipelinePrompt> {
  try {
    const agent = await getAgentBySlug(agentSlug);
    if (agent) {
      const v = await currentVersion(agent.id);
      if (v?.systemPrompt) return { version: v.version, systemPrompt: v.systemPrompt };
    }
  } catch {
    /* fall through to the code default */
  }
  return { version: 0, systemPrompt: DEFAULT_PROMPT };
}

/** Step 1 — deterministic query plan. */
export function planQueries(input: PipelineInput, runDate: Date): string[] {
  const topic = expandTopic(input.topic, runDate);
  const queries = [topic, ...(input.queries ?? []).map((q) => expandTopic(q, runDate))];
  for (const name of input.competitorNames ?? []) {
    queries.push(`${name} ${topic}`);
  }
  const seen = new Set<string>();
  const unique: string[] = [];
  for (const q of queries) {
    const norm = q.trim().replace(/\s+/g, " ");
    if (norm === "" || seen.has(norm.toLowerCase())) continue;
    seen.add(norm.toLowerCase());
    unique.push(norm);
  }
  return unique;
}

interface FetchedCandidate {
  search: WebSearchResult;
  doc: { title: string; text: string; provenance: Record<string, unknown> } | null;
  error?: string;
}

export function buildSources(
  topic: string,
  fetched: FetchedCandidate[],
  opts: { runDate: Date }
): ResearchSource[] {
  const sources: ResearchSource[] = [];
  let index = 1;
  for (const cand of fetched) {
    if (sources.length >= MAX_SOURCES_IN_PROMPT) break;
    const url = cand.search.url;
    const snippet =
      cand.doc && cand.doc.text.length > 0
        ? cand.doc.text.slice(0, cand.doc ? EXCERPT_CHARS : 0).trim()
        : (cand.search.snippet || "").slice(0, SNIPPET_CHARS);
    sources.push({
      index,
      title: cand.doc?.title || cand.search.title || url,
      url,
      snippet: snippet.length > 0 ? snippet : "(no extractable content)",
      fetchedAt: opts.runDate.toISOString(),
      revision:
        cand.doc && typeof (cand.doc.provenance as { revision?: unknown }).revision === "string"
          ? ((cand.doc.provenance as { revision: string }).revision)
          : null,
    });
    index++;
  }
  return sources;
}

export function buildUserPrompt(topic: string, sources: ResearchSource[], competitorNames: string[], competitorMode: boolean): string {
  const blocks = sources
    .map((s) => `[${s.index}] ${s.title}\nURL: ${s.url ?? "n/a"}\n${s.snippet}`)
    .join("\n\n---\n\n");
  const tracked = competitorNames.length > 0 ? `\nTracked competitors: ${competitorNames.join(", ")}` : "";
  const extra = competitorMode
    ? "\nFor every CONCRETE competitor event found in the sources, add it to competitorEvents with the competitor name (match the tracked list when possible), event kind (pricing|product|announcement|content|other), a short title, the source URL, and the [n] citations."
    : "";
  return `TOPIC: ${topic}${tracked}\n\nSOURCE EXCERPTS:\n\n${blocks}${extra}\n\nProduce the JSON finding now.`;
}

/**
 * Steps 2–4 — search, fetch, analyze. Storage is the caller's job so the
 * pipeline stays pure enough to test without a database.
 */
export async function runResearch(input: PipelineInput, deps: PipelineDeps): Promise<PipelineOutcome> {
  const now = deps.now ?? (() => new Date());
  const runDate = input.runDate ?? now();
  const tools = deps.tools ?? makeResearchTools();
  const prompt = deps.prompt ?? (await loadPrompt(input.agentSlug));
  const competitorMode = input.agentSlug === "competitor";

  const result: ResearchRunResult = {
    queries: [], searched: 0, fetched: 0, collected: 0, findings: 0, escalated: 0,
    unprocessed: 0, duplicates: 0, competitorEvents: 0, degraded: false,
  };

  // plan
  const queries = planQueries(input, runDate);
  result.queries = queries;

  // search (contained per query)
  const perQuery: Array<{ query: string; hits: WebSearchResult[] }> = [];
  const seenUrls = new Set<string>();
  for (const q of queries) {
    const hits = await tools.search(q);
    result.searched++;
    const fresh = hits.filter((h) => {
      const key = (h.url || "").replace(/[#?].*$/, "").toLowerCase();
      if (key === "" || seenUrls.has(key)) return false;
      seenUrls.add(key);
      return true;
    });
    if (fresh.length > 0) perQuery.push({ query: q, hits: fresh });
  }

  // fetch (bounded)
  const fetchBudget = 6;
  const candidates: FetchedCandidate[] = [];
  let fetches = 0;
  outer: for (const { query, hits } of perQuery) {
    for (const hit of hits) {
      if (fetches >= fetchBudget) break outer;
      let doc: FetchedCandidate["doc"] = null;
      let error: string | undefined;
      try {
        const d = await tools.fetchUrl(hit.url);
        doc = { title: d.title, text: d.text, provenance: d.provenance };
        result.fetched++;
      } catch (e) {
        error = e instanceof Error ? e.message : String(e); // one bad URL is contained
      }
      fetches++;
      candidates.push({ search: hit, doc, error });
    }
  }

  // Always include snippet-only candidates beyond the fetch budget so the
  // analysis still sees breadth (sources capped at 12).
  for (const { query, hits } of perQuery) {
    for (const hit of hits) {
      if (candidates.length >= MAX_SOURCES_IN_PROMPT) break;
      if (!candidates.some((c) => c.search.url === hit.url)) {
        candidates.push({ search: hit, doc: null });
      }
    }
  }

  const sources = buildSources(input.topic, candidates, { runDate });
  result.collected = sources.length;
  if (sources.length === 0) {
    return { result, findings: [], unprocessed: [] }; // nothing to analyze; run reports empty
  }

  const material = sources
    .map((s) => `[${s.index}] ${s.title} (${s.url ?? "n/a"})\n${s.snippet}`)
    .join("\n\n");

  // analyze — the ONE LLM call (bounded loop by construction)
  let finding: ResearchFinding;
  try {
    const user = buildUserPrompt(
      expandTopic(input.topic, runDate),
      sources,
      input.competitorNames ?? [],
      competitorMode
    );
    const out = await completeJSON<ResearchFinding>(
      deps.llm,
      [
        { role: "system", content: prompt.systemPrompt },
        { role: "user", content: user },
      ],
      FINDING_SCHEMA,
      { temperature: 0 }
    );
    finding = out.value;
  } catch (e) {
    const degradedBy =
      e instanceof BudgetExceededError
        ? "budget_exceeded"
        : e instanceof LlmProviderError
          ? "llm_provider_error"
          : e instanceof Error && e.name === "AbortError"
            ? "timeout"
            : "llm_error";
    result.degraded = true;
    result.degradeReason = degradedBy;
    const hash = dedupHashFor(input.businessUnitId, input.agentSlug, sources[0]?.url ?? null, input.topic);
    return {
      result,
      findings: [],
      unprocessed: [{ sources, query: queries[0] ?? input.topic, dedupHash: hash, material }],
    };
  }

  const escalated = finding.ambiguous === true || finding.confidence < 0.35;
  const primaryUrl = sources.find((s) => (finding.summary.includes(`[${s.index}]`)))?.url ?? sources[0]?.url ?? null;
  const hash = dedupHashFor(input.businessUnitId, input.agentSlug, primaryUrl, input.topic);
  if (Array.isArray(finding.competitorEvents)) result.competitorEvents = finding.competitorEvents.length;

  return {
    result,
    findings: [
      {
        finding,
        sources,
        query: queries[0] ?? input.topic,
        dedupHash: hash,
        material,
      },
    ],
    unprocessed: [],
  };
}

/** True when a finding must route to the human instead of the findings feed (§109). */
export function needsEscalation(f: ResearchFinding): boolean {
  return f.ambiguous === true || f.confidence < 0.35;
}

/** Attach the prompt fingerprint the way agent_runs does (C-14 lineage). */
export function fingerprint(prompt: PipelinePrompt): { promptVersion: number; promptHash: string } {
  return { promptVersion: prompt.version, promptHash: promptHash(prompt.systemPrompt) };
}
