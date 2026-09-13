/**
 * Phase 9 — seo_scan task handler against real task rows: flag gate
 * (fail-closed skip), deterministic harvest → keyword store, deterministic
 * recommendations (gap + content coverage, evidence-backed), degraded mode
 * (LLM down → task succeeds with deterministic artifacts + degradeReason),
 * LLM analysis mode (fake client → intent/difficulty keywords + richer recs
 * with attribution), and repeat-scan dedup (duplicates counted, no new rows).
 */
import { query } from "../lib/db";
import { spawnTask } from "../lib/tasks/queue";
import { makeSeoScanHandler } from "../lib/seo/tasks";
import { listKeywords, listRecommendations, stats } from "../lib/seo/service";
import type { LLMClient, ChatMessage } from "../lib/ai/types";
import type { TaskHandlerInput, TaskRow } from "../lib/tasks/types";

let failures = 0;
function check(name: string, cond: boolean, detail = "") {
  console.log(`${cond ? "PASS" : "FAIL"} ${name}${detail ? " :: " + detail : ""}`);
  if (!cond) failures++;
}

const stamp = Date.now();

async function flag(on: boolean): Promise<void> {
  await query("UPDATE feature_flags SET enabled = $1 WHERE key = 'seo'", [on]);
}
async function flagValue(): Promise<boolean> {
  const rows = await query<{ enabled: boolean }>("SELECT enabled FROM feature_flags WHERE key = 'seo'");
  return rows[0]?.enabled ?? false;
}
const flagBefore = await flagValue();

const [bu] = await query<{ id: number }>(
  `INSERT INTO business_units (slug, name) VALUES ($1, $2) RETURNING id`,
  [`seo-scan-${stamp}`, `SEO Scan BU`]
);
const buId = bu.id;

// Website + competitor registry + research findings for the context loader.
const [site] = await query<{ id: number }>(
  `INSERT INTO websites (business_unit_id, slug, name, domain) VALUES ($1, $2, $3, $4) RETURNING id`,
  [buId, `seo-site-${stamp}`, "SEO Site", "https://seo-test.example"]
);
check("setup: website linked to BU", site.id > 0);

const [comp] = await query<{ id: number }>(
  `INSERT INTO competitors (business_unit_id, name, url) VALUES ($1, $2, $3) RETURNING id`,
  [buId, "RivalCo", "https://rivalco.example"]
);
await query(
  `INSERT INTO competitor_events (business_unit_id, competitor_id, kind, title, url)
   VALUES ($1, $2, 'product', $3, $4)`,
  [buId, comp.id, "RivalCo launches prefab warranty program", "https://rivalco.example/warranty"]
);

async function seedFinding(title: string, summary: string, score: number, url: string): Promise<number> {
  const [row] = await query<{ id: number }>(
    `INSERT INTO research_items (business_unit_id, agent_slug, topic, status, title, summary, score, sources, dedup_hash)
     VALUES ($1, 'research', $2, 'finding', $3, $4, $5, $6::jsonb, $7) RETURNING id`,
    [
      buId, `topic ${stamp} ${title}`, title, summary, score,
      JSON.stringify([{ index: 1, title: "Source", url, snippet: "snippet", fetchedAt: null, revision: null }]),
      `hash-${stamp}-${title.replace(/\s+/g, "-")}`,
    ]
  );
  return row.id;
}
await seedFinding("Modular homes demand rising", "Modular homes are gaining demand as housing supply tightens.", 90, "https://news.example/modular");
await seedFinding("Housing permits slump", "Housing permits slump to a decade low across the region.", 75, "https://news.example/permits");

function makeStepRecorder(): Omit<TaskHandlerInput, "task"> {
  return {
    step: async (name: string, fn: () => Promise<Record<string, unknown> | void>) => {
      void name;
      return fn();
    },
    cancelled: async () => false,
  };
}

async function loadTask(id: number): Promise<TaskRow> {
  const rows = await query<TaskRow>("SELECT * FROM tasks WHERE id = $1", [id]);
  return rows[0];
}

function throwingLlm(): LLMClient {
  return {
    complete: async (_messages: ChatMessage[]) => { throw new Error("insufficient_quota"); },
    embed: async () => { throw new Error("not used"); },
  };
}

function jsonLlm(payload: () => string): { client: LLMClient; calls: () => number } {
  let calls = 0;
  return {
    calls: () => calls,
    client: {
      complete: async () => { calls += 1; return payload(); },
      embed: async () => { throw new Error("not used"); },
    },
  };
}

const ANALYSIS = () => JSON.stringify({
  ambiguous: false,
  keywords: [
    { keyword: "prefab warranty", intent: "commercial", difficultyEst: 35 },
    { keyword: "housing permits", intent: "informational", difficultyEst: 40 },
  ],
  recommendations: [
    {
      kind: "content",
      title: "Publish a prefab warranty explainer",
      detail: "Competitor warranty coverage is a differentiator; explain our position [1].",
      risk: "medium",
      targetKind: "site",
      targetUrl: "https://seo-test.example",
      evidence: [
        { label: "Competitor intelligence term: rivalco warranty program", url: "https://rivalco.example/warranty", note: "Tracked competitor activity mentions a warranty program." },
      ],
    },
  ],
});

// ---------- flag gate ----------
await flag(false);
{
  const spawned = await spawnTask({
    businessUnitId: buId, kind: "seo_scan", payload: { businessUnitId: buId },
    idempotencyKey: `seo-test-flag-${stamp}`, createdBy: "tests",
  });
  const handler = makeSeoScanHandler({ llm: throwingLlm() });
  const out = await handler({ task: await loadTask(spawned.taskId), ...makeStepRecorder() });
  check("flag-off: handler skips fail-closed", (out as { skipped?: boolean }).skipped === true && (out as { reason?: string }).reason === "seo_flag_off");
}
await flag(true);

// ---------- deterministic scan (LLM down → degraded) ----------
{
  const spawned = await spawnTask({
    businessUnitId: buId, kind: "seo_scan", payload: { businessUnitId: buId },
    idempotencyKey: `seo-test-degraded-${stamp}`, createdBy: "tests",
  });
  const handler = makeSeoScanHandler({ llm: throwingLlm() });
  const out = (await handler({ task: await loadTask(spawned.taskId), ...makeStepRecorder() })) as {
    keywordsHarvested: number; keywordsStored: number; recommendations: number; duplicates: number;
    degraded: boolean; degradeReason?: string; llmAnalysis: boolean;
  };

  check("degraded: task SUCCEEDS with deterministic artifacts", out.degraded === true && out.degradeReason === "llm_unavailable");
  check("degraded: no LLM analysis claimed", out.llmAnalysis === false);
  check("degraded: keywords harvested from research + competitor material", out.keywordsHarvested > 0, `n=${out.keywordsHarvested}`);
  check("degraded: keywords stored", out.keywordsStored > 0, `n=${out.keywordsStored}`);
  check("degraded: recommendations recorded", out.recommendations > 0, `n=${out.recommendations}`);

  const kws = await listKeywords({ businessUnitId: buId });
  check("degraded: competitor brand tracked", kws.some((k) => k.normalizedKeyword === "rivalco" && k.source === "scan"));
  check("degraded: research phrase tracked", kws.some((k) => k.keyword.includes("modular homes") && k.source === "research"));
  check("degraded: keywords linked to the task", kws.every((k) => k.taskId !== null));

  const recs = await listRecommendations({ businessUnitId: buId });
  check("degraded: every recommendation carries evidence", recs.length > 0 && recs.every((r) => r.evidence.length >= 1 && r.evidence.every((e) => e.label.trim() && e.note.trim())));
  check("degraded: gap recommendations present", recs.some((r) => r.kind === "gap"));
  check("degraded: prompt attribution recorded (fallback prompt = version 0)", recs.every((r) => r.agentSlug === "seo" && r.taskId !== null));

  const recStats = await stats(buId);
  check("degraded: stats reflect stored rows", recStats.recommendationsOpen >= 1 && recStats.withEvidencePct === 100);
}

// ---------- LLM analysis mode ----------
{
  const llm = jsonLlm(ANALYSIS);
  const spawned = await spawnTask({
    businessUnitId: buId, kind: "seo_scan", payload: { businessUnitId: buId },
    idempotencyKey: `seo-test-llm-${stamp}`, createdBy: "tests",
  });
  const handler = makeSeoScanHandler({ llm: llm.client });
  const out = (await handler({ task: await loadTask(spawned.taskId), ...makeStepRecorder() })) as {
    llmAnalysis: boolean; degraded: boolean; recommendations: number; duplicates: number; keywordsStored: number;
  };
  check("llm: analysis leg ran exactly once", llm.calls() === 1);
  check("llm: not degraded", out.llmAnalysis === true && out.degraded === false);

  const kws = await listKeywords({ businessUnitId: buId });
  const prefab = kws.find((k) => k.normalizedKeyword === "prefab warranty");
  check("llm: keyword enriched with intent + difficulty", prefab !== undefined && prefab.intent === "commercial" && prefab.difficultyEst === 35 && prefab.source === "scan");

  const recs = await listRecommendations({ businessUnitId: buId });
  const explainer = recs.find((r) => r.title === "Publish a prefab warranty explainer");
  check("llm: LLM recommendation stored with evidence", explainer !== undefined && explainer.evidence.length === 1);
  check("llm: repeat deterministic recs dedup (duplicates counted)", out.duplicates > 0 && recs.every((r) => r.evidence.length >= 1));
}

// ---------- repeat scan: dedup ----------
{
  const before = await listRecommendations({ businessUnitId: buId });
  const llm = jsonLlm(ANALYSIS);
  const spawned = await spawnTask({
    businessUnitId: buId, kind: "seo_scan", payload: { businessUnitId: buId },
    idempotencyKey: `seo-test-repeat-${stamp}`, createdBy: "tests",
  });
  const handler = makeSeoScanHandler({ llm: llm.client });
  const out = (await handler({ task: await loadTask(spawned.taskId), ...makeStepRecorder() })) as {
    recommendations: number; duplicates: number; keywordsStored: number;
  };
  const after = await listRecommendations({ businessUnitId: buId });
  check("repeat: no NEW recommendation rows (all deduped)", after.length === before.length && out.recommendations === 0);
  check("repeat: duplicates counted", out.duplicates > 0);
  check("repeat: keyword store stable (no new harvest rows)", out.keywordsStored === 0);
}

// ---------- BU scoping on the scan payload ----------
{
  const [otherBu] = await query<{ id: number }>(
    `INSERT INTO business_units (slug, name) VALUES ($1, $2) RETURNING id`,
    [`seo-other-${stamp}`, "SEO Other BU"]
  );
  const llm = jsonLlm(ANALYSIS);
  const spawned = await spawnTask({
    businessUnitId: otherBu.id, kind: "seo_scan", payload: { businessUnitId: otherBu.id },
    idempotencyKey: `seo-test-other-${stamp}`, createdBy: "tests",
  });
  const handler = makeSeoScanHandler({ llm: llm.client });
  await handler({ task: await loadTask(spawned.taskId), ...makeStepRecorder() });
  const otherKws = await listKeywords({ businessUnitId: otherBu.id });
  const otherRecs = await listRecommendations({ businessUnitId: otherBu.id });
  check("payload: scan is scoped to the payload BU (own keywords, empty recs)",
    otherKws.every((k) => k.businessUnitId === otherBu.id) && otherRecs.length === 0);
}

// ---------- restore flag ----------
await flag(flagBefore);
check("cleanup: seo flag restored", (await flagValue()) === flagBefore);

console.log(failures === 0 ? "\nALL PASS" : `\n${failures} FAILURES`);
process.exit(failures === 0 ? 0 : 1);
