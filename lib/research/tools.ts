/**
 * Research tools (Phase 7 — Phase 0.5 P6: "tools `web_search`/`fetch_url`
 * with schema/limits"; §6.4 C-3 re-evaluation: the first bounded tool loop
 * ships here, framework-free).
 *
 * Contracts:
 *  - web_search goes through a PROVIDER SEAM (mirrors lib/ai): 'duckduckgo'
 *    needs no key (best-effort HTML endpoint, parse-tolerant), 'brave' uses
 *    BRAVE_SEARCH_API_KEY. A failing search returns [] — one dead query
 *    never kills the run (§144 per-call containment).
 *  - fetch_url reuses the Phase 5 knowledge fetcher (timeout, content-type
 *    guard, byte cap, provenance) and adds the research SSRF guard: only
 *    http(s), no loopback/private/link-local hosts — the agent must not be
 *    turned into an internal-network prober (SEC-L2 posture).
 *  - HARD LIMITS (per run, enforced in pipeline.ts; the tools are the last
 *    line of defense): maxQueries 6, maxResultsPerQuery 10, maxFetches 6,
 *    per-fetch timeout/byte caps inherited from the fetcher.
 *  - HTTP is injectable everywhere for tests.
 */
import { makeKnowledgeFetcher, type FetchedDoc, type FetchImpl, type KnowledgeFetcher } from "../knowledge/fetchers";

export interface WebSearchResult {
  title: string;
  url: string;
  snippet: string;
}

export interface SearchProvider {
  id: string;
  search(query: string, limit: number): Promise<WebSearchResult[]>;
}

/* ------------------------------------------------------------------ */
/* SSRF guard                                                          */
/* ------------------------------------------------------------------ */

const BLOCKED_HOST_PATTERNS: RegExp[] = [
  /^localhost$/i,
  /^127\./,
  /^0\./,
  /^10\./,
  /^169\.254\./,
  /^192\.168\./,
  /^172\.(1[6-9]|2\d|3[01])\./,
  /^::1$/,
  /^\[?::1\]?$/,
  /^fc00:/i,
  /^fd[0-9a-f]{2}:/i,
  /^fe80:/i,
  /\.local$/i,
  /\.internal$/i,
];

/** Returns a safe outer URL or null when the URL must not be fetched. */
export function guardUrl(raw: string): string | null {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return null;
  if (url.port === "22" || url.port === "25" || url.port === "6379" || url.port === "5432") return null;
  const host = url.hostname;
  if (BLOCKED_HOST_PATTERNS.some((re) => re.test(host))) return null;
  return url.toString();
}

/* ------------------------------------------------------------------ */
/* DuckDuckGo provider (no key, best-effort HTML parse)                */
/* ------------------------------------------------------------------ */

export function parseDuckDuckGoHtml(html: string, limit: number): WebSearchResult[] {
  const out: WebSearchResult[] = [];
  const blocks = [...html.matchAll(/<a[^>]+class="[^"]*result__a[^"]*"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/gi)];
  const snippets = [...html.matchAll(/<a[^>]+class="[^"]*result__snippet[^"]*"[^>]*>([\s\S]*?)<\/a>/gi)];
  for (let i = 0; i < blocks.length && out.length < limit; i++) {
    const href = blocks[i][1];
    const title = blocks[i][2].replace(/<[^>]+>/g, "").trim();
    if (!title) continue;
    // DDG wraps URLs in /l/?uddg=<encoded>; unwrap when present.
    let url = href;
    const uddg = /[?&]uddg=([^&]+)/.exec(href);
    if (uddg) url = decodeURIComponent(uddg[1]);
    const snippet = snippets[i]?.[1] ? snippets[i][1].replace(/<[^>]+>/g, "").trim() : "";
    out.push({ title, url, snippet });
  }
  return out;
}

export function makeDuckDuckGoSearch(fetchImpl: FetchImpl): SearchProvider {
  return {
    id: "duckduckgo",
    async search(query, limit) {
      const res = await fetchImpl(
        `https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`,
        {
          headers: {
            "user-agent": "Mozilla/5.0 (compatible; AgentOSResearchBot/1.0)",
            accept: "text/html",
          },
        } as RequestInit
      );
      if (!res.ok) throw new Error(`search HTTP ${res.status}`);
      const html = await res.text();
      return parseDuckDuckGoHtml(html, limit);
    },
  };
}

/* ------------------------------------------------------------------ */
/* Brave provider (BRAVE_SEARCH_API_KEY)                               */
/* ------------------------------------------------------------------ */

export function makeBraveSearch(fetchImpl: FetchImpl, apiKey: string): SearchProvider {
  return {
    id: "brave",
    async search(query, limit) {
      const res = await fetchImpl(
        `https://api.search.brave.com/res/v1/web/search?q=${encodeURIComponent(query)}&count=${Math.min(limit, 20)}`,
        {
          headers: {
            "x-subscription-token": apiKey,
            accept: "application/json",
          },
        } as RequestInit
      );
      if (!res.ok) throw new Error(`search HTTP ${res.status}`);
      const body = (await (res as unknown as { json(): Promise<unknown> }).json()) as {
        web?: { results?: Array<{ title: string; url: string; description?: string }> };
      };
      return (body.web?.results ?? []).slice(0, limit).map((r) => ({
        title: r.title,
        url: r.url,
        snippet: (r.description ?? "").replace(/<[^>]+>/g, ""),
      }));
    },
  };
}

/* ------------------------------------------------------------------ */
/* Resolver + run-scoped toolbelt                                      */
/* ------------------------------------------------------------------ */

export interface ResearchTools {
  search(query: string, limit?: number): Promise<WebSearchResult[]>;
  fetchUrl(url: string): Promise<FetchedDoc>;
  /** Observability: which search provider served this run. */
  searchProviderId: string;
}

export interface ToolLimits {
  maxQueries: number;
  maxResultsPerQuery: number;
  maxFetches: number;
  searchTimeoutMs: number;
}

export const DEFAULT_TOOL_LIMITS: ToolLimits = {
  maxQueries: 6,
  maxResultsPerQuery: 10,
  maxFetches: 6,
  searchTimeoutMs: 10_000,
};

export function resolveSearchProvider(fetchImpl?: FetchImpl): SearchProvider {
  const impl: FetchImpl = fetchImpl ?? ((url, init) => fetch(url, init));
  const provider = (process.env.SEARCH_PROVIDER ?? "duckduckgo").toLowerCase();
  if (provider === "brave" && process.env.BRAVE_SEARCH_API_KEY) {
    return makeBraveSearch(impl, process.env.BRAVE_SEARCH_API_KEY);
  }
  return makeDuckDuckGoSearch(impl);
}

/**
 * The run-scoped toolbelt: every tool call is guarded, capped and
 * failure-contained. Counts are carried by the caller (pipeline) — the
 * belt enforces the per-call invariants only.
 */
export function makeResearchTools(deps: {
  fetchImpl?: FetchImpl;
  searchProvider?: SearchProvider;
  limits?: Partial<ToolLimits>;
  fetcher?: KnowledgeFetcher;
} = {}): ResearchTools {
  const limits = { ...DEFAULT_TOOL_LIMITS, ...deps.limits };
  const provider = deps.searchProvider ?? resolveSearchProvider(deps.fetchImpl);
  const fetcher =
    deps.fetcher ??
    makeKnowledgeFetcher({
      fetchImpl: deps.fetchImpl,
      timeoutMs: 10_000,
      maxBytes: 400_000,
      crawlerId: "agentos-research-v1",
    });

  return {
    searchProviderId: provider.id,
    async search(query, limit) {
      const capped = Math.min(limit ?? limits.maxResultsPerQuery, limits.maxResultsPerQuery);
      try {
        const raw = await withTimeout(provider.search(query, capped), limits.searchTimeoutMs);
        // Same SSRF posture applies to search-derived URLs at fetch time;
        // here we only drop obviously unsafe hits.
        return raw.filter((r) => guardUrl(r.url) !== null).slice(0, capped);
      } catch {
        return []; // containment: a dead provider = zero results, not a dead run
      }
    },
    async fetchUrl(url) {
      const safe = guardUrl(url);
      if (!safe) throw new Error(`blocked url (ssrf guard): ${url.slice(0, 120)}`);
      return fetcher.fetchUrlText(safe);
    },
  };
}

async function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      p,
      new Promise<never>((_, rej) => {
        timer = setTimeout(() => rej(new Error(`search timeout after ${ms}ms`)), ms);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}
