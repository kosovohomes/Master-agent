/**
 * Knowledge fetchers (Phase 5 §9.3: "real fetchers — URL/sitemap/RSS first;
 * PDF/DOCX/CSV next"). Today's content_sources declares kinds no code ever
 * fetched; these fetchers close that gap for the web kinds.
 *
 * Contracts:
 *   - Timeout (AbortController), content-type guard and byte cap on every
 *     request; a hostile or oversized source fails its own URL, not the run.
 *   - Sitemap: <loc> extraction, one-level index expansion, per-page HTML →
 *     text, partial-success semantics (individual page failures collected).
 *   - RSS: <item> title/link/description extraction; each item becomes one
 *     document so feed freshness maps to document freshness.
 *   - Every FetchedDoc carries provenance (§18): fetchedAt timestamp, crawler
 *     id, source ref, content revision hash — stamped onto the ingested
 *     document and surfaced verbatim in research citations.
 *   - 'upload'/'github'/'db' kinds are explicitly not fetchable in v1 (they
 *     arrive through other phases); runSourceFetch marks the attempt failed
 *     instead of silently pretending success.
 *
 * HTTP is injectable: tests pass a fake fetchImpl; production uses globalThis.fetch.
 */
import crypto from "node:crypto";

export interface FetchedDoc {
  title: string;
  url: string | null;
  text: string;
  provenance: Record<string, unknown>;
}

export interface FetchResponseLike {
  ok: boolean;
  status: number;
  headers: { get(name: string): string | null };
  text(): Promise<string>;
}

export type FetchImpl = (url: string, init?: RequestInit) => Promise<FetchResponseLike>;

export interface FetcherOptions {
  fetchImpl?: FetchImpl;
  timeoutMs?: number;
  maxBytes?: number;
  maxUrls?: number;
  crawlerId?: string;
}

export interface KnowledgeFetcher {
  fetchForKind(kind: string, ref: string, maxUrls?: number): Promise<FetchedDoc[]>;
  fetchUrlText(url: string): Promise<FetchedDoc>;
  fetchSitemap(sitemapUrl: string, maxUrls?: number): Promise<FetchedDoc[]>;
  fetchRss(feedUrl: string, maxUrls?: number): Promise<FetchedDoc[]>;
  internals: {
    htmlToText(html: string): string;
    extractTitle(html: string): string | null;
    decodeEntities(text: string): string;
  };
}

const ENTITIES: Record<string, string> = {
  amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ", ndash: "–", mdash: "—",
  hellip: "…", rsquo: "’", lsquo: "‘", ldquo: "“", rdquo: "”", copy: "©", reg: "®",
};

export function decodeEntities(text: string): string {
  return text
    .replace(/&#x([0-9a-fA-F]+);/g, (_, hex: string) => safeCodePoint(parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_, dec: string) => safeCodePoint(parseInt(dec, 10)))
    .replace(/&([a-zA-Z]+);/g, (m, name: string) => ENTITIES[name] ?? m);
}

function safeCodePoint(code: number): string {
  if (!Number.isFinite(code) || code < 0 || code > 0x10ffff) return "";
  try {
    return String.fromCodePoint(code);
  } catch {
    return "";
  }
}

export function htmlToText(html: string): string {
  return decodeEntities(
    html
      .replace(/<!--[\s\S]*?-->/g, " ")
      .replace(/<(script|style|noscript|svg|head)[\s\S]*?<\/\1\s*>/gi, " ")
      .replace(/<\/(p|div|section|article|li|tr|h[1-6]|blockquote|td|th)>/gi, "\n")
      .replace(/<br\s*\/?>/gi, "\n")
      .replace(/<[^>]+>/g, " ")
  )
    .replace(/[ \t]+/g, " ")
    .replace(/\n[ \t]+/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

export function extractTitle(html: string): string | null {
  const title = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(html);
  if (title?.[1]) return decodeEntities(title[1]).replace(/\s+/g, " ").trim() || null;
  const og = /<meta[^>]+property=["']og:title["'][^>]+content=["']([^"']+)["']/i.exec(html);
  if (og?.[1]) return decodeEntities(og[1]).trim() || null;
  const h1 = /<h1[^>]*>([\s\S]*?)<\/h1>/i.exec(html);
  if (h1?.[1]) return decodeEntities(h1[1].replace(/<[^>]+>/g, " ")).replace(/\s+/g, " ").trim() || null;
  return null;
}

function tagContent(xml: string, tag: string): string | null {
  const m = new RegExp(`<${tag}[^>]*>([\\s\\S]*?)</${tag}>`, "i").exec(xml);
  return m?.[1] != null ? decodeEntities(m[1].replace(/<!\[CDATA\[|\]\]>/g, "").trim()) : null;
}

export function makeKnowledgeFetcher(options: FetcherOptions = {}): KnowledgeFetcher {
  const fetchImpl = options.fetchImpl ?? ((url: string, init?: RequestInit) => fetch(url, init));
  const timeoutMs = options.timeoutMs ?? 10_000;
  const maxBytes = options.maxBytes ?? 500_000;
  const defaultMaxUrls = options.maxUrls ?? 10;
  const crawlerId = options.crawlerId ?? "agentos-knowledge-v1";

  function provenance(url: string, body: string): Record<string, unknown> {
    return {
      fetchedAt: new Date().toISOString(),
      crawlerId,
      sourceRef: url,
      revision: crypto.createHash("sha256").update(body).digest("hex").slice(0, 12),
      bytes: body.length,
    };
  }

  async function get(url: string): Promise<string> {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    try {
      const res = await fetchImpl(url, {
        signal: ctrl.signal,
        redirect: "follow",
        headers: {
          "user-agent": `AgentOSKnowledgeBot/1.0 (+${crawlerId})`,
          accept: "text/html, text/plain, application/xml, text/xml, application/rss+xml, application/atom+xml",
        },
      } as RequestInit);
      if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
      const ct = res.headers.get?.("content-type") ?? "";
      if (ct !== "" && !/text\/|xml|json|rss|atom/i.test(ct)) {
        throw new Error(`unsupported content-type "${ct}" for ${url}`);
      }
      const body = await res.text();
      if (body.length > maxBytes) throw new Error(`body exceeds ${maxBytes} bytes for ${url}`);
      return body;
    } finally {
      clearTimeout(timer);
    }
  }

  async function fetchUrlText(url: string): Promise<FetchedDoc> {
    const html = await get(url);
    const text = htmlToText(html);
    if (text === "") throw new Error(`no textual content at ${url}`);
    return {
      title: extractTitle(html) ?? url,
      url,
      text,
      provenance: provenance(url, html),
    };
  }

  function locs(xml: string): string[] {
    return [...xml.matchAll(/<loc>\s*([^<\s]+)\s*<\/loc>/gi)].map((m) => m[1]);
  }

  function pageCandidates(urls: string[]): string[] {
    return urls.filter((u) => !/\.(pdf|jpg|jpeg|png|gif|webp|svg|zip|gz|mp4|mp3|avi|woff2?)$/i.test(u));
  }

  async function fetchSitemap(sitemapUrl: string, maxUrls = defaultMaxUrls): Promise<FetchedDoc[]> {
    const xml = await get(sitemapUrl);
    const isIndex = /<sitemapindex[\s>]/i.test(xml);
    let pageUrls: string[] = [];
    if (isIndex) {
      // One-level index expansion (bounded); child sitemaps that fail are skipped.
      const children = locs(xml).slice(0, 5);
      for (const child of children) {
        try {
          pageUrls.push(...pageCandidates(locs(await get(child))));
        } catch {
          /* partial success: skip broken child sitemap */
        }
      }
    } else {
      pageUrls = pageCandidates(locs(xml));
    }
    const targets = pageUrls.slice(0, Math.max(1, maxUrls));
    if (targets.length === 0) throw new Error(`sitemap has no fetchable page URLs: ${sitemapUrl}`);

    const docs: FetchedDoc[] = [];
    const errors: string[] = [];
    for (const pageUrl of targets) {
      try {
        docs.push(await fetchUrlText(pageUrl));
      } catch (e) {
        errors.push(e instanceof Error ? e.message : String(e));
      }
    }
    if (docs.length === 0) {
      throw new Error(`sitemap produced 0 documents (${errors.length} page failure(s)): ${errors[0] ?? "unknown"}`);
    }
    return docs;
  }

  async function fetchRss(feedUrl: string, maxUrls = defaultMaxUrls): Promise<FetchedDoc[]> {
    const xml = await get(feedUrl);
    const items = [...xml.matchAll(/<(item|entry)[\s>][\s\S]*?<\/\1>/gi)].map((m) => m[0]);
    const docs: FetchedDoc[] = [];
    for (const item of items) {
      const title = tagContent(item, "title") ?? feedUrl;
      const link = tagContent(item, "link") ?? item.match(/<link[^>]+href=["']([^"']+)["']/i)?.[1] ?? null;
      const body = tagContent(item, "description") ?? tagContent(item, "content:encoded") ?? tagContent(item, "summary") ?? "";
      const text = body.startsWith("<") || /<\w+[^>]*>/.test(body) ? htmlToText(body) : body;
      if (text.trim() === "") continue;
      docs.push({
        title: title.slice(0, 300),
        url: link?.trim() || null,
        text,
        provenance: provenance(feedUrl, item),
      });
    }
    if (docs.length === 0) throw new Error(`feed has no parsable items: ${feedUrl}`);
    return docs.slice(0, Math.max(1, maxUrls));
  }

  return {
    async fetchForKind(kind: string, ref: string, maxUrls?: number): Promise<FetchedDoc[]> {
      switch (kind) {
        case "sitemap":
          return fetchSitemap(ref, maxUrls);
        case "rss":
          return fetchRss(ref, maxUrls);
        case "url":
        case "api":
          return [await fetchUrlText(ref)];
        default:
          throw new Error(`kind "${kind}" is not fetchable by knowledge v1 (upload/github/db arrive through other channels)`);
      }
    },
    fetchUrlText,
    fetchSitemap,
    fetchRss,
    internals: { htmlToText, extractTitle, decodeEntities },
  };
}

/** Production fetcher (global fetch, 10s timeout, 500KB cap, 10 URLs/run). */
export const knowledgeFetcher = makeKnowledgeFetcher();
