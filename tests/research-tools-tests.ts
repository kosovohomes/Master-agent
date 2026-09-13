/**
 * Phase 7 — research tools: SSRF guard, DuckDuckGo HTML parsing, the
 * provider seam, fetch limits via the shared knowledge fetcher, and the
 * per-call containment contract (a dead search = [], a bad URL = throw).
 */
import {
  guardUrl,
  parseDuckDuckGoHtml,
  makeDuckDuckGoSearch,
  makeBraveSearch,
  makeResearchTools,
  DEFAULT_TOOL_LIMITS,
} from "../lib/research/tools";
import type { FetchImpl, FetchResponseLike } from "../lib/knowledge/fetchers";

let failures = 0;
function check(name: string, cond: boolean, detail = "") {
  console.log(`${cond ? "PASS" : "FAIL"} ${name}${detail ? " :: " + detail : ""}`);
  if (!cond) failures++;
}

function jsonResponse(body: string, status = 200, contentType = "text/html"): FetchImpl {
  return (async () => ({
    ok: status >= 200 && status < 300,
    status,
    headers: { get: (n: string) => (n.toLowerCase() === "content-type" ? contentType : null) },
    text: async () => body,
  })) as unknown as FetchImpl;
}

// ---------- SSRF guard ----------
check("guard: https url passes", guardUrl("https://example.com/news?a=1") !== null);
check("guard: http url passes", guardUrl("http://example.com") !== null);
check("guard: ftp blocked", guardUrl("ftp://example.com") === null);
check("guard: file blocked", guardUrl("file:///etc/passwd") === null);
check("guard: localhost blocked", guardUrl("http://localhost:3000/x") === null);
check("guard: 127.0.0.1 blocked", guardUrl("http://127.0.0.1/x") === null);
check("guard: 10.x blocked", guardUrl("http://10.0.0.1/x") === null);
check("guard: 192.168 blocked", guardUrl("http://192.168.1.4/x") === null);
check("guard: 172.16 blocked", guardUrl("http://172.16.0.1/x") === null);
check("guard: 172.32 NOT in private range", guardUrl("http://172.32.0.1/x") !== null);
check("guard: 169.254 link-local blocked", guardUrl("http://169.254.169.254/latest/meta-data") === null);
check("guard: ::1 blocked", guardUrl("http://[::1]/x") === null);
check("guard: .internal blocked", guardUrl("http://db.internal/x") === null);
check("guard: garbage blocked", guardUrl("not a url") === null);
check("guard: port 5432 blocked", guardUrl("http://example.com:5432/x") === null);

// ---------- DuckDuckGo parse ----------
const ddgHtml = `
<div class="result results_links results_links_deep web-result">
  <h2 class="result__title">
    <a rel="nofollow" class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fnews.example.com%2Fai-law-2026&amp;rut=abc">AI regulation passes senate</a>
  </h2>
  <a class="result__snippet" href="#">The bill requires AI firms to register high-risk systems by 2026.</a>
</div>
<div class="result">
  <h2><a class="result__a" href="https://direct.example.com/story">Direct link result</a></h2>
  <a class="result__snippet" href="#">Snippet two.</a>
</div>`;
const parsed = parseDuckDuckGoHtml(ddgHtml, 10);
check("ddg: parses two results", parsed.length === 2, JSON.stringify(parsed.map((r) => r.url)));
check("ddg: unwraps uddg redirect", parsed[0]?.url === "https://news.example.com/ai-law-2026");
check("ddg: keeps direct url", parsed[1]?.url === "https://direct.example.com/story");
check("ddg: strips tags from title", parsed[0]?.title === "AI regulation passes senate");
check("ddg: carries snippet", (parsed[0]?.snippet ?? "").includes("register high-risk systems"));
check("ddg: limit respected", parseDuckDuckGoHtml(ddgHtml, 1).length === 1);

// ---------- providers ----------
const ddg = makeDuckDuckGoSearch(jsonResponse(ddgHtml));
const ddgHits = await ddg.search("ai law", 10);
check("ddg provider: search returns hits", ddgHits.length === 2);

let braveCalls = 0;
const brave = makeBraveSearch((async (url: string | URL | Request) => {
  braveCalls++;
  const u = String(url);
  check("brave: api endpoint used", u.includes("api.search.brave.com"));
  return {
    ok: true, status: 200,
    headers: { get: () => "application/json" },
    text: async () => "",
    json: async () => ({ web: { results: [{ title: "Brave hit", url: "https://b.example/1", description: "desc" }] } }),
  } as unknown as FetchResponseLike;
}) as unknown as FetchImpl, "test-key");
const braveHits = await brave.search("q", 5);
check("brave: parses json web results", braveHits.length === 1 && braveHits[0].title === "Brave hit");

// dead provider → the provider throws; the BELT contains (tested below)
const dead = makeDuckDuckGoSearch((async () => {
  return { ok: false, status: 503, headers: { get: () => "text/html" }, text: async () => "" } as unknown as FetchResponseLike;
}) as unknown as FetchImpl);
let deadThrew = false;
try {
  await dead.search("q", 5);
} catch {
  deadThrew = true;
}
check("ddg provider: http 503 throws (belt contains)", deadThrew);

// ---------- toolbelt ----------
const tools = makeResearchTools({
  fetchImpl: jsonResponse(ddgHtml),
  limits: { maxResultsPerQuery: 3 },
});
const searchHits = await tools.search("ai law");
check("tools: search returns parsed hits", searchHits.length === 2);
check("tools: provider id surfaced", tools.searchProviderId === "duckduckgo");

// failing search inside the belt → [] (containment), not a throw
const failingTools = makeResearchTools({
  fetchImpl: (async () => { throw new Error("network down"); }) as unknown as FetchImpl,
});
const contained = await failingTools.search("q");
check("tools: dead network contained to []", Array.isArray(contained) && contained.length === 0);

// fetchUrl honors the SSRF guard
let fetchBlocked = false;
try {
  await tools.fetchUrl("http://169.254.169.254/latest/meta-data");
} catch {
  fetchBlocked = true;
}
check("tools: fetchUrl throws on SSRF-guarded url", fetchBlocked);

// fetchUrl returns text through the knowledge fetcher
const htmlPage = "<html><head><title>Gov AI Bill</title></head><body><p>The senate passed the AI act today with provisions for licensing.</p></body></html>";
const fetchTools = makeResearchTools({
  searchProvider: { id: "test", search: async () => [] },
  fetchImpl: jsonResponse(htmlPage),
});
const doc = await fetchTools.fetchUrl("https://gov.example/ai-bill");
check("tools: fetchUrl extracts title", doc.title === "Gov AI Bill");
check("tools: fetchUrl extracts body text", doc.text.includes("senate passed the AI act"));
check("tools: fetchUrl carries provenance revision", typeof (doc.provenance as { revision?: string }).revision === "string");

// search strips unsafe hit URLs before they reach the pipeline
const unsafeTools = makeResearchTools({
  fetchImpl: jsonResponse(ddgHtml),
  searchProvider: {
    id: "unsafe",
    search: async () => [
      { title: "ok", url: "https://fine.example/a", snippet: "" },
      { title: "bad", url: "http://127.0.0.1:8080/admin", snippet: "" },
      { title: "worse", url: "file:///etc/passwd", snippet: "" },
    ],
  },
});
const filtered = await unsafeTools.search("q", 10);
check("tools: unsafe search hits stripped", filtered.length === 1 && filtered[0].url === "https://fine.example/a");

check("limits: defaults are the bounded-loop contract", DEFAULT_TOOL_LIMITS.maxQueries === 6 && DEFAULT_TOOL_LIMITS.maxFetches === 6 && DEFAULT_TOOL_LIMITS.maxResultsPerQuery === 10);

console.log(failures === 0 ? "research-tools: ALL PASS" : `research-tools: ${failures} FAILURE(S)`);
process.exit(failures === 0 ? 0 : 1);
