/**
 * Phase 7 — research pipeline: the deterministic query plan, source
 * assembly, the analyze step (structured output through the versioned
 * prompt), the §109 escalation contract (known event → finding; ambiguous
 * → escalation), the LLM-unavailable degraded mode, and dedup hashing.
 * No database: the pipeline returns artifacts; storage lives in the
 * service/handler (covered by research-service / research-tasks suites).
 */
import {
  planQueries,
  buildSources,
  buildUserPrompt,
  runResearch,
  dedupHashFor,
  needsEscalation,
  expandTopic,
  loadPrompt,
} from "../lib/research/pipeline";
import { makeResearchTools } from "../lib/research/tools";
import type { LLMClient, ChatMessage } from "../lib/ai/types";
import type { SearchProvider } from "../lib/research/tools";
import type { FetchImpl } from "../lib/knowledge/fetchers";

let failures = 0;
function check(name: string, cond: boolean, detail = "") {
  console.log(`${cond ? "PASS" : "FAIL"} ${name}${detail ? " :: " + detail : ""}`);
  if (!cond) failures++;
}

const PROMPT: { version: number; systemPrompt: string } = { version: 1, systemPrompt: "unit-test research prompt" };
const RUN_DATE = new Date("2026-09-13T04:30:00Z");

// ---------- plan ----------
check("expand: {{date}} expands", expandTopic("AI news for {{date}}", RUN_DATE) === "AI news for 2026-09-13");
const plan = planQueries(
  { businessUnitId: 1, agentSlug: "research", topic: "AI regulation {{date}}", queries: ["EU AI act enforcement", "AI regulation {{date}}", "  ", "eu ai act   enforcement "], competitorNames: ["Acme AI", "Beta Labs"] },
  RUN_DATE
);
check("plan: topic first, {{date}} expands in queries too, deduped", plan.length === 4 && plan[0] === "AI regulation 2026-09-13" && plan[1] === "EU AI act enforcement", JSON.stringify(plan));
check("plan: competitor seeds appended (expanded topic)", plan[2] === "Acme AI AI regulation 2026-09-13" && plan[3] === "Beta Labs AI regulation 2026-09-13");

// ---------- sources ----------
const fetched = [
  {
    search: { title: "Hit A", url: "https://a.example/1", snippet: "short a" },
    doc: { title: "Doc A", text: "Full text of A ".repeat(10), provenance: { revision: "rev123" } },
  },
  { search: { title: "Hit B", url: "https://b.example/2", snippet: "snippet only b" }, doc: null },
  { search: { title: "Hit C", url: "https://c.example/3", snippet: "" }, doc: null, error: "HTTP 403" },
];
const sources = buildSources("topic", fetched, { runDate: RUN_DATE });
check("sources: indexed 1..n", sources[0].index === 1 && sources[1].index === 2 && sources[2].index === 3);
check("sources: fetched doc wins title", sources[0].title === "Doc A");
check("sources: revision provenance carried", sources[0].revision === "rev123");
check("sources: snippet-only fallback", sources[1].snippet === "snippet only b");
check("sources: empty-snippet placeholder", sources[2].snippet === "(no extractable content)");
const userPrompt = buildUserPrompt("AI regulation", sources, ["Acme AI"], false);
check("prompt: sources numbered", userPrompt.includes("[1]") && userPrompt.includes("[3]"));
check("prompt: tracked competitors listed", userPrompt.includes("Acme AI"));
check("prompt: competitor instruction withheld in research mode", !userPrompt.includes("competitorEvents"));
const compPrompt = buildUserPrompt("competitors", sources, ["Acme AI"], true);
check("prompt: competitor instruction present in competitor mode", compPrompt.includes("competitorEvents"));

// ---------- dedup hash ----------
const h1 = dedupHashFor(7, "research", "https://x.example/a", "topic");
const h2 = dedupHashFor(7, "research", "https://x.example/a", "topic");
const h3 = dedupHashFor(7, "research", "https://x.example/b", "topic");
const h4 = dedupHashFor(8, "research", "https://x.example/a", "topic");
check("dedup: stable for same inputs", h1 === h2);
check("dedup: differs by url", h1 !== h3);
check("dedup: differs by BU (cross-BU isolation)", h1 !== h4);

// ---------- fake LLM + fake tools harness ----------
function fakeLlm(responding: (messages: ChatMessage[]) => string): LLMClient {
  return {
    complete: async (messages: ChatMessage[]) => responding(messages),
    embed: async () => { throw new Error("embed not used by research"); },
  };
}

function okFinding(over: Record<string, unknown> = {}): string {
  return JSON.stringify({
    title: "Senate passes AI licensing act",
    summary: "The senate passed the AI act requiring registration of high-risk systems, effective 2026 (sources [1], [2]).",
    score: 88,
    confidence: 0.82,
    ambiguous: false,
    implications: ["Licensing overhead for high-risk systems"],
    actions: ["Review registration requirements"],
    ...over,
  });
}

function searchProviderOf(hits: Array<{ title: string; url: string; snippet: string }>): SearchProvider {
  return { id: "fake", search: async (q: string) => (q.includes("nothing-here") ? [] : hits) };
}

function htmlOf(text: string): FetchImpl {
  return (async () => ({
    ok: true, status: 200,
    headers: { get: (n: string) => (n.toLowerCase() === "content-type" ? "text/html" : null) },
    text: async () => `<html><head><title>Page</title></head><body>${text}</body></html>`,
  })) as unknown as FetchImpl;
}

const HITS = [
  { title: "AI act passes", url: "https://news.example/ai-act", snippet: "senate passed" },
  { title: "Analysis", url: "https://analysis.example/ai", snippet: "what it means" },
];

// ---------- §109 dataset A: known event → cited + scored finding ----------
{
  const llm = fakeLlm((messages) => {
    const user = messages.find((m) => m.role === "user")?.content ?? "";
    // completeJSON prepends its schema-hint system message; the versioned
    // agent prompt arrives as the SECOND system message.
    check("analyze: schema-hint system message first", (messages[0]?.content ?? "").includes("JSON Schema"));
    check("analyze: versioned system prompt used", (messages[1]?.content ?? "") === PROMPT.systemPrompt);
    check("analyze: sources cited to the model", user.includes("[1]") && user.includes("https://news.example/ai-act"));
    return okFinding();
  });
  const tools = makeResearchTools({ searchProvider: searchProviderOf(HITS), fetchImpl: htmlOf("The senate passed the AI act today.") });
  const outcome = await runResearch(
    { businessUnitId: 1, agentSlug: "research", topic: "AI regulation {{date}}", runDate: RUN_DATE },
    { llm, tools, prompt: PROMPT }
  );
  check("run: not degraded", !outcome.result.degraded);
  check("run: one finding produced", outcome.findings.length === 1 && outcome.unprocessed.length === 0);
  const f = outcome.findings[0];
  check("run: finding carries sources for citations", f.sources.length === 2);
  check("run: finding carries dedup hash", f.dedupHash.length === 64);
  check("run: result counters", outcome.result.searched === 1 && outcome.result.fetched === 2 && outcome.result.collected === 2, JSON.stringify(outcome.result));
  check("escalation: clean finding stays in feed", !needsEscalation(f.finding));
}

// ---------- §109 dataset B: ambiguous → escalation ----------
{
  const llm = fakeLlm(() => JSON.stringify({
    title: "Unclear regulatory signal",
    summary: "Sources conflict about whether the bill passed; cannot establish a defensible finding from these excerpts alone.",
    score: 40, confidence: 0.2, ambiguous: true,
  }));
  const tools = makeResearchTools({ searchProvider: searchProviderOf(HITS), fetchImpl: htmlOf("contradictory reports...") });
  const outcome = await runResearch(
    { businessUnitId: 1, agentSlug: "research", topic: "ambiguous topic", runDate: RUN_DATE },
    { llm, tools, prompt: PROMPT }
  );
  check("ambiguous: flagged by the model", outcome.findings[0]?.finding.ambiguous === true);
  check("ambiguous: escalation router agrees", needsEscalation(outcome.findings[0].finding));
}

// low confidence (not flagged) also escalates
check("escalation: low confidence escalates", needsEscalation({ title: "t", summary: "s", score: 30, confidence: 0.1, ambiguous: false }));
check("escalation: threshold is inclusive at 0.35", !needsEscalation({ title: "t", summary: "s", score: 50, confidence: 0.35, ambiguous: false }));

// ---------- competitor mode: events extracted ----------
{
  const llm = fakeLlm(() => JSON.stringify({
    title: "Acme AI cuts prices",
    summary: "Acme AI reduced its enterprise tier pricing by 40% according to [1].",
    score: 75, confidence: 0.7, ambiguous: false,
    competitorEvents: [{ competitor: "Acme AI", kind: "pricing", title: "Enterprise tier -40%", url: "https://news.example/ai-act", citations: [1] }],
  }));
  const tools = makeResearchTools({ searchProvider: searchProviderOf(HITS), fetchImpl: htmlOf("Acme AI cut prices by 40%.") });
  const outcome = await runResearch(
    { businessUnitId: 1, agentSlug: "competitor", topic: "competitor moves", competitorNames: ["Acme AI"], runDate: RUN_DATE },
    { llm, tools, prompt: PROMPT }
  );
  check("competitor: event draft carried on the finding", outcome.result.competitorEvents === 1 && outcome.findings[0].finding.competitorEvents?.length === 1);
}

// ---------- degraded: LLM provider failure → unprocessed material, not a throw ----------
{
  const llm = fakeLlm(() => { throw new Error("429 insufficient_quota: no credits"); });
  const tools = makeResearchTools({ searchProvider: searchProviderOf(HITS), fetchImpl: htmlOf("material...") });
  const outcome = await runResearch(
    { businessUnitId: 1, agentSlug: "research", topic: "topic x", runDate: RUN_DATE },
    { llm, tools, prompt: PROMPT }
  );
  check("degraded: flagged", outcome.result.degraded === true);
  check("degraded: reason captured", typeof outcome.result.degradeReason === "string" && outcome.result.degradeReason.length > 0);
  check("degraded: material stored as unprocessed", outcome.unprocessed.length === 1 && outcome.findings.length === 0);
  check("degraded: unprocessed carries sources for later re-analysis", outcome.unprocessed[0].sources.length === 2);
  check("degraded: unprocessed hash present", outcome.unprocessed[0].dedupHash.length === 64);
}

// schema-invalid model output → degraded (structured output exhausted retries)
{
  const llm = fakeLlm(() => "not json at all");
  const tools = makeResearchTools({ searchProvider: searchProviderOf(HITS), fetchImpl: htmlOf("x") });
  const outcome = await runResearch(
    { businessUnitId: 1, agentSlug: "research", topic: "topic y", runDate: RUN_DATE },
    { llm, tools, prompt: PROMPT }
  );
  check("degraded: unparseable model output degrades instead of failing", outcome.result.degraded === true && outcome.unprocessed.length === 1);
}

// ---------- empty search → empty run, no LLM call ----------
{
  let llmCalled = 0;
  const llm = fakeLlm(() => { llmCalled++; return okFinding(); });
  const tools = makeResearchTools({ searchProvider: searchProviderOf([]), fetchImpl: htmlOf("x") });
  const outcome = await runResearch(
    { businessUnitId: 1, agentSlug: "research", topic: "nothing-here", runDate: RUN_DATE },
    { llm, tools, prompt: PROMPT }
  );
  check("empty: zero sources → no analysis call", llmCalled === 0 && outcome.result.collected === 0 && outcome.findings.length === 0);
}

// ---------- per-query containment: one dead query, one live ----------
{
  const provider: SearchProvider = {
    id: "mixed",
    search: async (q) => {
      if (q.includes("dead")) throw new Error("provider hiccup");
      return HITS;
    },
  };
  const tools = makeResearchTools({ searchProvider: provider, fetchImpl: htmlOf("content") });
  const outcome = await runResearch(
    { businessUnitId: 1, agentSlug: "research", topic: "live query", queries: ["dead query"], runDate: RUN_DATE },
    { llm: fakeLlm(() => okFinding()), tools, prompt: PROMPT }
  );
  check("containment: dead query zero results, live query still analyzed", outcome.result.searched === 2 && outcome.findings.length === 1);
}

// ---------- loadPrompt falls back without DB (defensive) ----------
{
  const p = await loadPrompt("definitely-not-an-agent-slug");
  check("prompt: fallback when agent row missing", p.version === 0 && p.systemPrompt.includes("Research Agent"));
}

console.log(failures === 0 ? "research-pipeline: ALL PASS" : `research-pipeline: ${failures} FAILURE(S)`);
process.exit(failures === 0 ? 0 : 1);
