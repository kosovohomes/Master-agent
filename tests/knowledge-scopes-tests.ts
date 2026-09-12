/**
 * Phase 5 — THE SCOPE LEAK SUITE (P5 acceptance).
 *
 * "Extended leak tests prove GLOBAL vs BUSINESS vs WEBSITE vs JURISDICTION vs
 * AGENT separation; a legal question scoped to jurisdiction X never returns
 * Y's law." Every assertion here is a leak denial or a legitimate match.
 */
import { query } from "../lib/db";
import { ingestKnowledgeDocument } from "../lib/knowledge/ingest";
import { hybridRetrieveDetailed } from "../lib/knowledge/retrieve";
import type { EmbedContext } from "../lib/knowledge/types";

let failures = 0;
function check(name: string, cond: boolean, detail = "") {
  console.log(`${cond ? "PASS" : "FAIL"} ${name}${detail ? " :: " + detail : ""}`);
  if (!cond) failures++;
}

const dim = (n: number) => Array.from({ length: 1536 }, (_, i) => (i < n ? 1 : 0));
const embed: EmbedContext = {
  embed: async (texts: string[]) => texts.map((_, i) => dim(20 + i)),
};

const stamp = Date.now();
let buA: number | undefined;
let buB: number | undefined;
let siteA1: number | undefined;
const sourceIds: number[] = [];
const docIds: number[] = [];

async function mkBu(slug: string): Promise<number> {
  const [r] = await query<{ id: number }>(
    `INSERT INTO business_units (slug, name) VALUES ($1, $2) RETURNING id`,
    [slug, `BU ${slug}`]
  );
  return r.id;
}

async function mkSource(businessUnitId: number | null, ref: string, accessLevel: string = "internal"): Promise<number> {
  const [r] = await query<{ id: number }>(
    `INSERT INTO knowledge_sources (business_unit_id, kind, ref, access_level)
     VALUES ($1, 'upload', $2, $3) RETURNING id`,
    [businessUnitId, ref, accessLevel]
  );
  sourceIds.push(r.id);
  return r.id;
}

async function ingest(p: {
  sourceId: number; title: string; text: string;
  businessUnitId?: number | null; websiteId?: number | null;
  jurisdiction?: string | null; accessLevel?: string;
  authorityTier?: number; agentScopes?: string[];
}): Promise<number> {
  const r = await ingestKnowledgeDocument(embed, {
    knowledgeSourceId: p.sourceId,
    title: p.title,
    text: p.text,
    businessUnitId: p.businessUnitId ?? null,
    websiteId: p.websiteId ?? null,
    jurisdiction: p.jurisdiction ?? null,
    accessLevel: (p.accessLevel as never) ?? "internal",
    authorityTier: p.authorityTier ?? 3,
    agentScopes: p.agentScopes,
  });
  docIds.push(r.documentId);
  return r.documentId;
}

/** Retrieve with a keyword query and return the matched titles. */
async function titles(p: {
  businessUnitId?: number | null; websiteId?: number | null;
  jurisdiction?: string | null; agentSlug?: string | null;
  publicOnly?: boolean; maxAuthorityTier?: number; unrestricted?: boolean;
  query: string;
}): Promise<string[]> {
  const { citations } = await hybridRetrieveDetailed(embed, {
    scope: {
      businessUnitId: p.businessUnitId ?? null,
      websiteId: p.websiteId ?? null,
      jurisdiction: p.jurisdiction ?? null,
      agentSlug: p.agentSlug ?? null,
      publicOnly: p.publicOnly,
      maxAuthorityTier: p.maxAuthorityTier,
      unrestricted: p.unrestricted,
    },
    query: p.query,
    topK: 10,
    candidateLimit: 40,
  });
  return citations.map((c) => c.title);
}

try {
  buA = await mkBu(`ksc-a-${stamp}`);
  buB = await mkBu(`ksc-b-${stamp}`);
  const [site] = await query<{ id: number }>(
    `INSERT INTO websites (business_unit_id, slug, name) VALUES ($1, $2, $3) RETURNING id`,
    [buA, `ksc-site-a1-${stamp}`, "A1"]
  );
  siteA1 = site.id;

  const srcA = await mkSource(buA, `ksc-src-a-${stamp}`);
  const srcB = await mkSource(buB, `ksc-src-b-${stamp}`);
  const srcGlobal = await mkSource(null, `ksc-src-global-${stamp}`);
  const srcPublic = await mkSource(buA, `ksc-src-public-${stamp}`, "public");

  // corpus — distinctive keywords per document
  await ingest({ sourceId: srcGlobal, title: "Global Handbook", text: "The universal brand onboarding handbook covers global values.", businessUnitId: null });
  await ingest({ sourceId: srcA, title: "A Roadmap", text: "Acme A internal roadmap mentions project bluebird deadlines.", businessUnitId: buA });
  await ingest({ sourceId: srcB, title: "B Secret", text: "Beta B confidential roadmap project canary never leaks.", businessUnitId: buB });
  await ingest({ sourceId: srcA, title: "A1 Landing", text: "Website A1 landing copy promotes the spring sale widgets.", businessUnitId: buA, websiteId: siteA1 });
  await ingest({ sourceId: srcA, title: "US Tax Deadlines", text: "US federal tax filing deadlines are april fifteenth.", businessUnitId: buA, jurisdiction: "US" });
  await ingest({ sourceId: srcA, title: "UK Tax Deadlines", text: "UK HMRC self assessment filing deadline january thirty first.", businessUnitId: buA, jurisdiction: "UK" });
  await ingest({ sourceId: srcA, title: "Research-Only Brief", text: "Research-only brief about competitor quadrant analysis.", businessUnitId: buA, agentScopes: ["research"] });
  await ingest({ sourceId: srcA, title: "Pricing Committee", text: "Internal margin figures for the pricing committee.", businessUnitId: buA, accessLevel: "internal" });
  await ingest({ sourceId: srcPublic, title: "Public FAQ", text: "The public FAQ explains shipping times and returns.", businessUnitId: buA, accessLevel: "public" });

  // ---- BUSINESS separation ----
  const aView = await titles({ businessUnitId: buA, query: "roadmap project" });
  check("BU A sees own roadmap", aView.includes("A Roadmap"));
  check("BU A never sees BU B corpus", !aView.includes("B Secret"), JSON.stringify(aView));
  const bView = await titles({ businessUnitId: buB, query: "roadmap project" });
  check("BU B sees own corpus", bView.includes("B Secret"));
  check("BU B never sees BU A roadmap", !bView.includes("A Roadmap"), JSON.stringify(bView));

  // ---- GLOBAL visibility ----
  const globalView = await titles({ businessUnitId: buA, query: "universal onboarding handbook" });
  check("global docs are visible to every BU", globalView.includes("Global Handbook"));
  const globalOnly = await titles({ businessUnitId: null, query: "handbook universal roadmap canary" });
  check("global-only caller sees only global docs", globalOnly.includes("Global Handbook") && !globalOnly.includes("A Roadmap") && !globalOnly.includes("B Secret"), JSON.stringify(globalOnly));

  // ---- WEBSITE refinement ----
  const siteView = await titles({ businessUnitId: buA, websiteId: siteA1, query: "spring sale widgets landing" });
  check("website caller sees website-scoped doc", siteView.includes("A1 Landing"));
  check("website caller still sees BU-wide docs", siteView.includes("A Roadmap"));

  // ---- JURISDICTION separation (legal contract) ----
  const usLaw = await titles({ businessUnitId: buA, jurisdiction: "US", query: "tax filing deadlines" });
  check("US caller sees US law", usLaw.includes("US Tax Deadlines"));
  check("US caller NEVER sees UK law", !usLaw.includes("UK Tax Deadlines"), JSON.stringify(usLaw));
  const ukLaw = await titles({ businessUnitId: buA, jurisdiction: "UK", query: "tax filing deadlines" });
  check("UK caller sees UK law", ukLaw.includes("UK Tax Deadlines"));
  check("UK caller NEVER sees US law", !ukLaw.includes("US Tax Deadlines"), JSON.stringify(ukLaw));

  // ---- AGENT separation ----
  const researchView = await titles({ businessUnitId: buA, agentSlug: "research", query: "competitor quadrant analysis" });
  check("research agent sees research-scoped doc", researchView.includes("Research-Only Brief"));
  const marketingView = await titles({ businessUnitId: buA, agentSlug: "marketing", query: "competitor quadrant analysis" });
  check("marketing agent NEVER sees research-scoped doc", !marketingView.includes("Research-Only Brief"), JSON.stringify(marketingView));

  // ---- ACCESS LEVEL for anonymous callers ----
  const publicView = await titles({ businessUnitId: buA, publicOnly: true, query: "margin figures pricing shipping returns FAQ" });
  check("public caller sees public docs", publicView.includes("Public FAQ"));
  check("public caller NEVER sees internal docs", !publicView.includes("Pricing Committee"), JSON.stringify(publicView));
  const staffView = await titles({ businessUnitId: buA, query: "margin figures pricing" });
  check("staff caller sees internal docs", staffView.includes("Pricing Committee"));

  // ---- AUTHORITY ceiling ----
  const tiered = await titles({ businessUnitId: buA, maxAuthorityTier: 1, query: "roadmap bluebird deadlines" });
  check("authority ceiling T1 excludes T3 docs", !tiered.includes("A Roadmap"), JSON.stringify(tiered));

  // ---- ADMIN unrestricted ----
  const adminView = await titles({ unrestricted: true, query: "roadmap canary" });
  check("admin unrestricted sees both BUs", adminView.includes("A Roadmap") && adminView.includes("B Secret"), JSON.stringify(adminView));

  // ---- scope-safe dedup: same text under different scopes is NOT deduped ----
  const dupText = "Shared identical paragraph used for scope dedup verification.";
  const dupA = await ingest({ sourceId: srcA, title: "Dup A", text: dupText, businessUnitId: buA });
  const dupB = await ingest({ sourceId: srcB, title: "Dup B", text: dupText, businessUnitId: buB });
  check("same text under different BUs creates separate documents", dupA !== dupB);
  const dupA2 = await ingestKnowledgeDocument(embed, {
    knowledgeSourceId: srcA, title: "Dup A (again)", text: dupText, businessUnitId: buA,
  });
  check("same text within a scope dedups", dupA2.deduplicated && dupA2.documentId === dupA);

  // ---- scope re-check on hydration (belt and braces): crafted ids cannot leak ----
  const { citations } = await hybridRetrieveDetailed(embed, {
    scope: { businessUnitId: buB },
    query: "bluebird canary",
    topK: 10,
    candidateLimit: 40,
  });
  check("hydration re-check keeps BU B clean", citations.every((c) => c.documentId !== dupA));
} finally {
  // cleanup order: docs (chunks cascade) → sources → website → BUs
  if (docIds.length > 0) await query("DELETE FROM documents WHERE id = ANY($1)", [docIds]).catch(() => undefined);
  if (sourceIds.length > 0) await query("DELETE FROM knowledge_sources WHERE id = ANY($1)", [sourceIds]).catch(() => undefined);
  if (siteA1 != null) await query("DELETE FROM websites WHERE id = $1", [siteA1]).catch(() => undefined);
  const bus = [buA, buB].filter((v): v is number => v != null);
  if (bus.length > 0) await query("DELETE FROM business_units WHERE id = ANY($1)", [bus]).catch(() => undefined);
}

if (failures > 0) { console.error(`${failures} FAIL`); process.exit(1); }
console.log("KNOWLEDGE SCOPES SUITE PASS");
