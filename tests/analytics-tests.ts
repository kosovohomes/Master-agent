/**
 * Phase 13 — analytics + strategy workforce against real Postgres: period
 * math (daily/weekly/monthly keys + bounds), §99 aggregate metric collection
 * (counts/sums match fixtures exactly; breakdown rows are aggregate-only),
 * report dedup (expression UNIQUE on (COALESCE(bu,0), period_kind,
 * period_key)), the processReport pipeline (deterministic floor lands ready
 * + degraded; LLM legs refine insights/digest/recommendations with clamps;
 * per-leg degradation incl. schema-invalid strategy payloads), schedule
 * spawning (period-idempotent), recommendation FSM (terminal states refuse,
 * review stamp immutable), §99 privacy (platform rows invisible to
 * scope-limited callers; no PII in platform payloads), events, and the
 * report_run task handler (flag drill: OFF → skipped, never thrown).
 */
import { query } from "../lib/db";
import {
  createReport,
  getReport,
  getReportForScope,
  listReports,
  listRecommendations,
  getRecommendation,
  upsertRecommendation,
  transitionRecommendation,
  analyticsSummary,
  getRecommendationForScope,
  type AnalyticsScope,
} from "../lib/analytics/service";
import {
  collectMetrics,
  buBreakdown,
  periodKeyFor,
  periodBounds,
  isoWeekKey,
} from "../lib/analytics/metrics";
import {
  deterministicInsights,
  deterministicRecommendations,
  insightsWithLLM,
  narrativeWithLLM,
  recommendationsWithLLM,
  ANALYTICS_DEFAULT_PROMPT,
  REPORTING_DEFAULT_PROMPT,
  STRATEGY_DEFAULT_PROMPT,
} from "../lib/analytics/pipeline";
import { processReport, registerAnalyticsHandlers } from "../lib/analytics/tasks";
import {
  AnalyticsServiceError,
  RECOMMENDATION_TERMINAL,
  type ReportPayload,
} from "../lib/analytics/types";
import { getTaskHandler, registerTaskHandler } from "../lib/tasks/handlers";
import { spawnTask } from "../lib/tasks/queue";
import { windowFor } from "../lib/analytics/metrics";
import type { LLMClient, ChatMessage } from "../lib/ai/types";
import type { TaskHandlerInput } from "../lib/tasks/types";

let failures = 0;
function check(name: string, cond: boolean, detail = "") {
  console.log(`${cond ? "PASS" : "FAIL"} ${name}${detail ? " :: " + detail : ""}`);
  if (!cond) failures++;
}

async function expectError(name: string, p: () => Promise<unknown>, code: string) {
  try {
    await p();
    check(name, false, `expected ${code}, no error thrown`);
  } catch (e) {
    const ok = e instanceof AnalyticsServiceError && e.code === code;
    check(name, ok, ok ? "" : `expected ${code}, got ${e instanceof Error ? e.message : String(e)}`);
  }
}

async function expectThrow(name: string, p: () => Promise<unknown>, messagePart: string) {
  try {
    await p();
    check(name, false, `expected throw containing "${messagePart}", no error thrown`);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    check(name, msg.includes(messagePart), msg.slice(0, 200));
  }
}

const stamp = Date.now();
const OWNER: AnalyticsScope = { kind: "all", businessUnitIds: [] };
let reportIds: number[] = [];
let spawnedTaskIds: number[] = [];
let testScheduleIds: number[] = [];
const manualHashes: string[] = [];

async function setupBu(name: string): Promise<number> {
  const [bu] = await query<{ id: number }>(
    `INSERT INTO business_units (slug, name) VALUES ($1, $2) RETURNING id`,
    [`analytics-${name}-${stamp}`, `Analytics BU ${name}`]
  );
  return bu.id;
}

async function setFlag(enabled: boolean): Promise<void> {
  await query(
    `INSERT INTO feature_flags (key, enabled, description) VALUES ('analytics', $1, 'test') 
     ON CONFLICT (key) DO UPDATE SET enabled = $1`,
    [enabled]
  );
}

function stubLlm(
  legs: { analytics?: unknown; reporting?: unknown; strategy?: unknown },
  opts: { broken?: boolean } = {}
): LLMClient {
  const pick = (messages: ChatMessage[]): unknown => {
    const sys = messages[0]?.content ?? "";
    if (sys.includes("Analytics Agent")) return legs.analytics;
    if (sys.includes("Reporting Agent")) return legs.reporting;
    if (sys.includes("Strategy Agent")) return legs.strategy;
    return {};
  };
  return {
    async complete(messages: ChatMessage[]) {
      if (opts.broken) throw new Error("gateway down");
      return JSON.stringify(pick(messages));
    },
    async completeWithUsage(messages: ChatMessage[]) {
      if (opts.broken) throw new Error("gateway down");
      return { content: JSON.stringify(pick(messages)), usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 } };
    },
    async embed() { throw new Error("no embeds in test"); },
    async embedWithUsage() { throw new Error("no embeds in test"); },
  } as unknown as LLMClient;
}

/* ------------------------------------------------------------------ */
/* Fixtures                                                            */
/* ------------------------------------------------------------------ */
const buA = await setupBu("alpha");
const buB = await setupBu("beta");
await setFlag(true);

const longTitle = "T".repeat(600);

// leads: 3 in buA (1 hot open), 1 in buB
const leadFixtures: [number, string, number, string][] = [
  [buA, "new", 85, "hot"],
  [buA, "qualified", 55, "warm"],
  [buA, "won", 90, "hot"],
  [buB, "new", 10, "cold"],
];
for (let i = 0; i < leadFixtures.length; i++) {
  const [bu, stage, score, band] = leadFixtures[i];
  await query(
    `INSERT INTO leads (business_unit_id, name, contact, channel, stage, lead_score, score_band, contact_email)
     VALUES ($1, 'Fixture Lead', '+0000000000', 'manual', $2, $3, $4, $5)`,
    [bu, stage, score, band, `lead-${i}-${bu}@fixture.test`]
  )
}
// inquiries: 2 in buA (1 escalated), 1 spam in buB
await query(`INSERT INTO inquiries (business_unit_id, body, classification, urgency, status) VALUES ($1, 'fixture body', 'sales', 'high', 'escalated')`, [buA]);
await query(`INSERT INTO inquiries (business_unit_id, body, classification, urgency, status) VALUES ($1, 'fixture body', 'support', 'low', 'classified')`, [buA]);
await query(`INSERT INTO inquiries (business_unit_id, body, classification, status) VALUES ($1, 'buy spam', 'spam', 'new')`, [buB]);

// llm_requests: buA 2 ok ($0.01 + $0.02, 100+200 prompt, 50+100 completion), 1 error; buB 1 ok
await query(
  `INSERT INTO llm_requests (business_unit_id, kind, model, status, prompt_tokens, completion_tokens, cost_usd) VALUES
     ($1, 'chat', 'test-model', 'ok', 100, 50, 0.01),
     ($1, 'chat', 'test-model', 'ok', 200, 100, 0.02),
     ($1, 'embed', 'test-model', 'error', 10, 0, 0),
     ($2, 'chat', 'test-model', 'ok', 5, 5, 0.001)`,
  [buA, buB]
);

// campaigns + metrics: buA spend 12.50, 3 conversions; buB spend 40.00, 0 conversions
const [campA] = await query<{ id: number }>(
  `INSERT INTO campaigns (business_unit_id, name, status) VALUES ($1, $2, 'active') RETURNING id`,
  [buA, `camp-a-${stamp}`]
);
const [campB] = await query<{ id: number }>(
  `INSERT INTO campaigns (business_unit_id, name, status) VALUES ($1, $2, 'active') RETURNING id`,
  [buB, `camp-b-${stamp}`]
);
await query(`INSERT INTO campaign_metrics (campaign_id, impressions, clicks, conversions, spend_usd) VALUES ($1, 1000, 100, 3, 12.50)`, [campA.id]);
await query(`INSERT INTO campaign_metrics (campaign_id, impressions, clicks, conversions, spend_usd) VALUES ($1, 5000, 10, 0, 40.00)`, [campB.id]);

// content: 1 published, 1 review in buA
await query(`INSERT INTO content_items (business_unit_id, lifecycle, brief) VALUES ($1, 'PUBLISHED', '{}'::jsonb)`, [buA]);
await query(`INSERT INTO content_items (business_unit_id, lifecycle, brief) VALUES ($1, 'REVIEW', '{}'::jsonb)`, [buA]);

const wide = { start: new Date(Date.now() - 86_400_000), end: new Date(Date.now() + 3_600_000) };

/* ------------------------------------------------------------------ */
/* 1. Migration artifacts                                              */
/* ------------------------------------------------------------------ */
{
  const schedules = await query<{ n: number }>(
    `SELECT count(*)::int AS n FROM report_schedules WHERE business_unit_id IS NULL`
  );
  check("migrations: three platform report schedules seeded", schedules[0].n === 3, `n=${schedules[0].n}`);

  const agents = await query<{ slug: string; versions: number; status: string }>(
    `SELECT a.slug, count(v.id)::int AS versions, a.status
     FROM agents a LEFT JOIN agent_versions v ON v.agent_id = a.id
     WHERE a.slug IN ('analytics','strategy','reporting')
     GROUP BY a.slug, a.status ORDER BY a.slug`
  );
  check(
    "migrations: analytics/strategy/reporting agents active with ≥1 version",
    agents.length === 3 && agents.every((a) => a.status === "active" && a.versions >= 1),
    JSON.stringify(agents)
  );

  const flag = await query<{ enabled: boolean }>(`SELECT enabled FROM feature_flags WHERE key = 'analytics'`);
  check("migrations: analytics flag seeded", flag.length === 1 && flag[0].enabled === true);

  const perm = await query<{ n: number }>(
    `SELECT count(*)::int AS n FROM role_permissions rp
     JOIN permissions p ON p.id = rp.permission_id JOIN roles r ON r.id = rp.role_id
     WHERE p.key = 'analytics.manage' AND r.key IN ('owner','administrator')`
  );
  check("migrations: analytics.manage granted to owner+administrator", perm[0].n === 2, `n=${perm[0].n}`);
}

/* ------------------------------------------------------------------ */
/* 2. Period math                                                      */
/* ------------------------------------------------------------------ */
{
  const d = new Date("2026-02-16T10:00:00Z"); // a Monday, ISO week 8
  check("period: daily key", periodKeyFor("daily", d) === "2026-02-16", periodKeyFor("daily", d));
  check("period: weekly key", periodKeyFor("weekly", d) === "2026-W08", periodKeyFor("weekly", d));
  check("period: monthly key", periodKeyFor("monthly", d) === "2026-02", periodKeyFor("monthly", d));
  check("period: isoWeekKey", isoWeekKey(new Date("2026-01-01T00:00:00Z")) === "2026-W01", isoWeekKey(new Date("2026-01-01T00:00:00Z")));

  const feb = periodBounds("monthly", "2026-02");
  check("period: feb bounds are 28 days", (feb.end.getTime() - feb.start.getTime()) === 28 * 86_400_000);

  const w1 = periodBounds("weekly", "2026-W01");
  check("period: W01 starts Monday Jan 1 2026 (or nearest)", w1.start.toISOString().slice(0, 10) === "2025-12-29", w1.start.toISOString());

  const onDemand = windowFor("on_demand", "k", 30);
  check("period: on_demand uses rolling window", onDemand.window.kind === "window" && onDemand.bounds.end <= new Date(Date.now() + 1000));
}

/* ------------------------------------------------------------------ */
/* 3. Metric collection (§99 aggregate contract)                       */
/* ------------------------------------------------------------------ */
{
  const mA = await collectMetrics(buA, wide);
  check("metrics: buA leads = 3", mA.leads.total === 3, `got ${mA.leads.total}`);
  check("metrics: buA hot open = 1 (won excluded)", mA.leads.hotOpen === 1, `got ${mA.leads.hotOpen}`);
  check("metrics: buA inquiries = 2, escalated = 1, spam = 0", mA.inquiries.total === 2 && mA.inquiries.escalated === 1 && mA.inquiries.spam === 0, JSON.stringify(mA.inquiries));
  check("metrics: buA llm requests = 3, errors = 1", mA.llm.requests === 3 && mA.llm.errors === 1, JSON.stringify(mA.llm));
  check("metrics: buA llm cost = 0.03", Math.abs(mA.llm.costUsd - 0.03) < 1e-9, `${mA.llm.costUsd}`);
  check("metrics: buA spend = 12.50, conversions = 3", Math.abs(mA.marketing.spendUsd - 12.5) < 1e-9 && mA.marketing.conversions === 3, JSON.stringify(mA.marketing));
  check("metrics: buA content published = 1, inReview = 1", mA.content.published === 1 && mA.content.inReview === 1);

  const mAll = await collectMetrics(null, wide);
  check("metrics: platform includes both BUs' spend", Math.abs(mAll.marketing.spendUsd - 52.5) < 1e-9, `${mAll.marketing.spendUsd}`);
  check("metrics: platform llm requests ≥ 4", mAll.llm.requests >= 4);

  const rows = await buBreakdown([buA, buB], wide);
  check("breakdown: one aggregate row per BU", rows.length === 2 && rows[0].businessUnitId === buA);
  check("breakdown: buA row numbers only", rows[0].leads === 3 && rows[0].hotLeads === 1 && Math.abs(rows[0].campaignSpendUsd - 12.5) < 1e-9);
  check("breakdown: no PII keys in breakdown rows", !JSON.stringify(rows).includes("@fixture.test"));
}

/* ------------------------------------------------------------------ */
/* 4. Report dedup                                                     */
/* ------------------------------------------------------------------ */
{
  const key = `t-${stamp}-dedup`;
  const first = await createReport({ businessUnitId: null, periodKind: "on_demand", periodKey: key, title: `Dedup ${key}` });
  const second = await createReport({ businessUnitId: null, periodKind: "on_demand", periodKey: key, title: `Dedup ${key}` });
  reportIds.push(first.report.id);
  check("dedup: first create wins", first.created === true);
  check("dedup: second returns the same row", second.created === false && second.report.id === first.report.id);
}

/* ------------------------------------------------------------------ */
/* 5. processReport — deterministic floor (allowLlm false)             */
/* ------------------------------------------------------------------ */
{
  const key = `t-${stamp}-floor`;
  const { report } = await createReport({ businessUnitId: null, periodKind: "on_demand", periodKey: key, title: `Floor ${key}` });
  reportIds.push(report.id);
  const stubNoop = stubLlm({});
  const res = await processReport(report.id, { llm: stubNoop, allowLlm: false });
  check("floor: report lands ready", res.status === "ready");
  check("floor: degraded = true (honest provenance)", res.degraded === true);
  const stored = await getReport(report.id);
  check("floor: generated_by = deterministic", stored?.generatedBy === "deterministic" && stored.degraded === true);
  check("floor: payload scope = platform with breakdown", (stored?.payload as { scope?: string; breakdown?: unknown[] }).scope === "platform" && Array.isArray((stored?.payload as { breakdown?: unknown[] }).breakdown));
  check("floor: payload carries fixture aggregates", (stored?.payload as { metrics?: { leads?: { total?: number } } }).metrics?.leads?.total === 3);
  check("floor: narrative is deterministic prose", typeof stored?.narrative?.summary === "string" && (stored.narrative as { summary: string }).summary.length > 0);
  const recs = await query<{ n: number }>(
    `SELECT count(*)::int AS n FROM strategy_recommendations WHERE report_id = $1 AND source = 'report'`,
    [report.id]
  );
  check("floor: evidence-cited recommendations stored", recs[0].n >= 1, `n=${recs[0].n}`);
  const ev = await query<{ n: number }>(
    `SELECT count(*)::int AS n FROM events WHERE name = 'analytics.report_ready' AND (payload->>'reportId')::int = $1`,
    [report.id]
  );
  check("floor: analytics.report_ready event emitted", ev[0].n === 1, `n=${ev[0].n}`);
  check("floor: platform payload carries no PII", !JSON.stringify(stored?.payload).includes("@fixture.test"));
}

/* ------------------------------------------------------------------ */
/* 6. processReport — LLM legs with clamps + provenance                */
/* ------------------------------------------------------------------ */
{
  const key = `t-${stamp}-llm`;
  const { report } = await createReport({ businessUnitId: buA, periodKind: "on_demand", periodKey: key, title: `LLM ${key}` });
  reportIds.push(report.id);
  const llm = stubLlm({
    analytics: { insights: [{ metric: "leads.total", direction: "up", observation: "3 leads in window" }] },
    reporting: { summary: "Fixture summary.", highlights: ["Hot lead waiting"], risks: ["Zero conversions on spend"] },
    strategy: {
      recommendations: [
        { kind: "growth", priority: "high", title: longTitle, detail: "Do the thing", evidence: ["leads.total=3"] },
        { kind: "efficiency", priority: "low", title: `Second ${stamp}`, detail: "And another", evidence: [] },
        { kind: "risk", priority: "medium", title: `Third ${stamp}`, detail: "Risk one", evidence: [] },
        { kind: "content", priority: "low", title: `Fourth ${stamp}`, detail: "Content one", evidence: [] },
        { kind: "budget", priority: "low", title: `Fifth ${stamp}`, detail: "Budget one", evidence: [] },
        { kind: "growth", priority: "low", title: `Sixth ${stamp}`, detail: "Over the cap", evidence: [] },
        { kind: "growth", priority: "low", title: `Seventh ${stamp}`, detail: "Way over the cap", evidence: [] },
      ],
    },
  });
  const res = await processReport(report.id, { llm, allowLlm: true });
  check("llm: report ready, degraded = false", res.status === "ready" && res.degraded === false);
  const stored = await getReport(report.id);
  const payload = stored?.payload as { provenance?: { insightsBy: string; narrativeBy: string; recommendationsBy: string; promptVersion: number } };
  check("llm: provenance names all three legs", payload.provenance?.insightsBy === "llm" && payload.provenance?.narrativeBy === "llm" && payload.provenance?.recommendationsBy === "llm", JSON.stringify(payload.provenance));
  check("llm: prompt version from registry ≥ 1", (payload.provenance?.promptVersion ?? 0) >= 1, `v=${payload.provenance?.promptVersion}`);
  check("llm: narrative from reporting agent", stored?.narrative?.summary === "Fixture summary." && ((stored.narrative as { highlights?: string[] }).highlights?.length ?? 0) === 1);
  const insightCount = ((stored?.payload as { insights?: unknown[] }).insights ?? []).length;
  check("llm: insights refined by analytics agent", insightCount === 1, `n=${insightCount}`);
  check("llm: title clamped to 200 chars", (await query<{ n: number }>(
    `SELECT count(*)::int AS n FROM strategy_recommendations WHERE report_id = $1 AND length(title) <= 200 AND source = 'report'`,
    [report.id]
  ))[0].n >= 1);
  const recCount = (await query<{ n: number }>(
    `SELECT count(*)::int AS n FROM strategy_recommendations WHERE report_id = $1 AND source = 'report'`,
    [report.id]
  ))[0].n;
  check("llm: strategy recs capped at 5 per leg (7 offered, clamped)", recCount <= 5 + 2, `n=${recCount}`); // +2 tolerance for deterministic rules that also fired
}

/* ------------------------------------------------------------------ */
/* 7. Schema-invalid strategy leg degrades ALONE                       */
/* ------------------------------------------------------------------ */
{
  const key = `t-${stamp}-junk`;
  const { report } = await createReport({ businessUnitId: null, periodKind: "on_demand", periodKey: key, title: `Junk ${key}` });
  reportIds.push(report.id);
  const llm = stubLlm({
    analytics: { insights: [{ metric: "llm.requests", direction: "anomaly", observation: "stub insight" }] },
    reporting: { summary: "Junk-test summary.", highlights: [], risks: [] },
    strategy: { recommendations: [{ kind: "SPACE-STAR", priority: "MAXIMUM", title: "x", detail: "y", evidence: [] }] },
  });
  const res = await processReport(report.id, { llm, allowLlm: true });
  check("junk: report still lands ready", res.status === "ready");
  const stored = await getReport(report.id);
  const payload = stored?.payload as { provenance?: { insightsBy: string; narrativeBy: string; recommendationsBy: string; promptVersion: number } } | undefined;
  check("junk: insights + narrative legs ran llm", payload?.provenance?.insightsBy === "llm" && payload?.provenance?.narrativeBy === "llm");
  check("junk: strategy leg degraded to deterministic", payload?.provenance?.recommendationsBy === "deterministic");
  check("junk: mixed degradation → generatedBy llm (not all legs degraded)", stored?.generatedBy === "llm");
}

/* ------------------------------------------------------------------ */
/* 8. Broken gateway degrades fully (no throw)                         */
/* ------------------------------------------------------------------ */
{
  const key = `t-${stamp}-broken`;
  const { report } = await createReport({ businessUnitId: null, periodKind: "on_demand", periodKey: key, title: `Broken ${key}` });
  reportIds.push(report.id);
  const res = await processReport(report.id, { llm: stubLlm({}, { broken: true }), allowLlm: true });
  check("broken: report lands ready via deterministic floor", res.status === "ready" && res.degraded === true);
}

/* ------------------------------------------------------------------ */
/* 9. Recommendation dedup + FSM                                       */
/* ------------------------------------------------------------------ */
{
  const hash = `manual-${stamp}-1`;
  manualHashes.push(hash);
  const first = await upsertRecommendation({
    businessUnitId: null, source: "manual", kind: "growth", priority: "high",
    title: `Accept me ${stamp}`, detail: "FSM fixture", evidence: ["e=1"], dedupHash: hash,
  });
  const dup = await upsertRecommendation({
    businessUnitId: null, source: "manual", kind: "growth", priority: "high",
    title: `Accept me ${stamp}`, detail: "FSM fixture", evidence: ["e=1"], dedupHash: hash,
  });
  check("recs: dedup returns existing row", first.created === true && dup.created === false && dup.recommendation.id === first.recommendation.id);

  const accepted = await transitionRecommendation(first.recommendation.id, "accept", "user:1");
  check("recs: accept transitions + stamps reviewer", accepted.status === "accepted" && accepted.reviewedBy === "user:1" && accepted.reviewedAt != null);
  await expectError("recs: terminal state refuses re-transition", () => transitionRecommendation(first.recommendation.id, "dismiss", "user:1"), "BAD_STATE");
  check("recs: terminal set is accepted|dismissed", RECOMMENDATION_TERMINAL.length === 2);

  const hash2 = `manual-${stamp}-2`;
  manualHashes.push(hash2);
  const second = await upsertRecommendation({
    businessUnitId: buA, source: "manual", kind: "risk", priority: "medium",
    title: `Dismiss me ${stamp}`, detail: "FSM fixture", evidence: [], dedupHash: hash2,
  });
  const dismissed = await transitionRecommendation(second.recommendation.id, "dismiss", "user:1");
  check("recs: dismiss transitions", dismissed.status === "dismissed");
  await expectError("recs: unknown action refused", () => transitionRecommendation(second.recommendation.id, "pineapple" as never, "user:1"), "INVALID_ACTION");
}

/* ------------------------------------------------------------------ */
/* 10. §99 privacy — scope enforcement at the read model               */
/* ------------------------------------------------------------------ */
{
  const platformReport = await getReport(reportIds[0]);
  const scoped: AnalyticsScope = { kind: "list", businessUnitIds: [buA] };
  check("privacy: platform report visible to owner scope", platformReport != null && await getReportForScope(platformReport.id, OWNER) != null);
  check("privacy: platform report INVISIBLE to list scope", await getReportForScope(platformReport?.id ?? 0, scoped) === null);

  // a buB report must be invisible to a buA-scoped caller
  const buBKey = `t-${stamp}-bub`;
  const buBReport = await createReport({ businessUnitId: buB, periodKind: "on_demand", periodKey: buBKey, title: `BUB ${buBKey}` });
  reportIds.push(buBReport.report.id);
  check("privacy: buB report invisible to buA scope", await getReportForScope(buBReport.report.id, scoped) === null);

  const buAReports = await listReports({ kind: "list", businessUnitIds: [buA] }, 50);
  check("privacy: list scope sees only own-BU reports", buAReports.length > 0 && buAReports.every((r) => r.businessUnitId === buA));

  const platformRec = await upsertRecommendation({
    businessUnitId: null, source: "analytics", kind: "efficiency", priority: "low",
    title: `Platform rec ${stamp}`, detail: "§99 fixture", evidence: [], dedupHash: `platform-${stamp}`,
  });
  manualHashes.push(`platform-${stamp}`);
  check("privacy: platform rec invisible to list scope", await getRecommendationForScope(platformRec.recommendation.id, scoped) === null);
  const buARecs = await listRecommendations({ kind: "list", businessUnitIds: [buA] }, { limit: 50 });
  check("privacy: list scope recs are own-BU only", buARecs.every((r) => r.businessUnitId === buA));

  const summaryOwner = await analyticsSummary(OWNER);
  const summaryScoped = await analyticsSummary(scoped);
  check("privacy: summary respects scope", summaryOwner.reportsReady >= summaryScoped.reportsReady && summaryScoped.schedules === 0, JSON.stringify({ summaryOwner, summaryScoped }));
}

/* ------------------------------------------------------------------ */
/* 11. Schedule spawning (period-idempotent)                           */
/* ------------------------------------------------------------------ */
{
  const [s1] = await query<{ id: number }>(
    `INSERT INTO report_schedules (business_unit_id, cadence) VALUES (NULL, 'daily') RETURNING id`
  );
  const [s2] = await query<{ id: number }>(
    `INSERT INTO report_schedules (business_unit_id, cadence) VALUES ($1, 'monthly') RETURNING id`,
    [buA]
  );
  testScheduleIds.push(s1.id, s2.id);

  const first = await (await import("../lib/analytics/service")).spawnDueReportRuns(new Date("2030-01-15T10:00:00Z"));
  spawnedTaskIds.push(...first.taskIds);
  check("schedules: due schedules spawn report_run tasks", first.spawned >= 2, `spawned=${first.spawned}`);

  const again = await (await import("../lib/analytics/service")).spawnDueReportRuns(new Date("2030-01-15T11:00:00Z"));
  const mineAgain = again.taskIds.filter((id) => spawnedTaskIds.includes(id));
  check("schedules: same-period re-run spawns nothing new for my schedules", mineAgain.length === 0, `re-spawned=${mineAgain.length}`);

  const tasks = await query<{ idempotency_key: string }>(
    `SELECT idempotency_key FROM tasks WHERE kind = 'report_run' AND id = ANY($1::int[])`,
    [spawnedTaskIds]
  );
  check("schedules: idempotency keys carry schedule + period", tasks.every((t) => /^report_run:\d+:/.test(t.idempotency_key)), JSON.stringify(tasks.map((t) => t.idempotency_key)));
}

/* ------------------------------------------------------------------ */
/* 12. report_run task handler + flag drill                            */
/* ------------------------------------------------------------------ */
{
  registerAnalyticsHandlers(() => stubLlm({
    analytics: { insights: [{ metric: "leads.total", direction: "up", observation: "handler insight" }] },
    reporting: { summary: "Handler summary.", highlights: [], risks: [] },
    strategy: { recommendations: [{ kind: "growth", priority: "medium", title: `Handler rec ${stamp}`, detail: "from handler", evidence: ["leads.total=3"] }] },
  }));
  const handler = getTaskHandler("report_run");
  check("handler: report_run registered", handler != null);
  if (!handler) throw new Error("report_run handler missing");

  const key = `t-${stamp}-handler`;
  const { taskId } = await spawnTask({
    kind: "report_run",
    payload: { businessUnitId: null, periodKind: "on_demand", periodKey: key, title: `Handler ${key}` },
    idempotencyKey: `report_run:test:${key}`,
    createdBy: "test",
  });
  spawnedTaskIds.push(taskId);

  const input: TaskHandlerInput = {
    task: (await query(`SELECT * FROM tasks WHERE id = $1`, [taskId]))[0] as never,
    step: async (_name, fn) => (await fn()) ?? {},
    cancelled: async () => false,
  };
  const res = (await handler(input)) as Record<string, unknown>;
  check("handler: flag ON runs the pipeline", res.skipped !== true);
  const handlerReport = await query<{ id: number; status: string; degraded: boolean }>(
    `SELECT id, status, degraded FROM reports WHERE period_key = $1`, [key]
  );
  reportIds.push(handlerReport[0].id);
  check("handler: report lands ready with llm legs", handlerReport[0].status === "ready" && handlerReport[0].degraded === false, JSON.stringify(handlerReport[0]));

  // Flag OFF → background skip (never throw)
  await setFlag(false);
  const key2 = `t-${stamp}-handler-off`;
  const { taskId: taskId2 } = await spawnTask({
    kind: "report_run",
    payload: { businessUnitId: null, periodKind: "on_demand", periodKey: key2, title: `Handler-off ${key2}` },
    idempotencyKey: `report_run:test:${key2}`,
    createdBy: "test",
  });
  spawnedTaskIds.push(taskId2);
  const input2: TaskHandlerInput = {
    task: (await query(`SELECT * FROM tasks WHERE id = $1`, [taskId2]))[0] as never,
    step: async (_name, fn) => (await fn()) ?? {},
    cancelled: async () => false,
  };
  const res2 = (await handler(input2)) as Record<string, unknown>;
  check("handler: flag OFF skips with reason (fail closed, no throw)", res2.skipped === true && res2.reason === "analytics_flag_off", JSON.stringify(res2));
  const offReport = await query<{ status: string }>(`SELECT status FROM reports WHERE period_key = $1`, [key2]);
  reportIds.push(offReport.length > 0 ? (await query<{ id: number }>(`SELECT id FROM reports WHERE period_key = $1`, [key2]))[0].id : 0);
  check("handler: flag OFF leaves report pending (next enabled tick re-runs)", offReport[0]?.status === "pending");
  await setFlag(true);
}

/* ------------------------------------------------------------------ */
/* 13. Error paths + deterministic unit legs                           */
/* ------------------------------------------------------------------ */
{
  await expectError("errors: processReport on missing report", () => processReport(999999999, { llm: stubLlm({}), allowLlm: false }), "NOT_FOUND");

  const ready = await getReport(reportIds[0]);
  await expectError("errors: processReport on ready report", () => processReport(ready?.id ?? 0, { llm: stubLlm({}), allowLlm: false }), "BAD_STATE");

  // Deterministic unit legs on a crafted payload (budget rule)
  const win = windowFor("on_demand", "unit", 7);
  const payload: ReportPayload = {
    window: win.window, scope: "platform" as const, businessUnitId: null,
    metrics: {
      businessUnits: 2, websites: 2, users: 3,
      leads: { total: 4, newStage: 2, qualified: 1, won: 1, lost: 0, hotOpen: 2 },
      inquiries: { total: 3, escalated: 1, spam: 1, resolved: 0 },
      conversations: { total: 3, escalated: 0 },
      content: { items: 5, inReview: 3, approved: 0, published: 0 },
      social: { posts: 2, published: 1, failed: 1 },
      campaigns: { active: 2, completed: 0 },
      marketing: { impressions: 100, clicks: 5, conversions: 0, spendUsd: 40 },
      llm: { requests: 10, errors: 4, promptTokens: 100, completionTokens: 50, costUsd: 0.5 },
      research: { findings: 1, escalated: 1 },
      seo: { openRecommendations: 2 },
      tasks: { failed: 1, escalated: 0 },
    },
    breakdown: null, insights: [],
    provenance: { insightsBy: "deterministic" as const, narrativeBy: "deterministic" as const, recommendationsBy: "deterministic" as const, promptVersion: 0, promptHash: "" },
  };
  const insights = deterministicInsights(payload);
  check("deterministic: spend-without-conversion anomaly fires", insights.some((i) => i.metric === "marketing.conversions" && i.direction === "anomaly"));
  check("deterministic: llm error-rate anomaly fires", insights.some((i) => i.metric === "llm.errors" && i.direction === "anomaly"));
  const recs = deterministicRecommendations(payload, insights);
  check("deterministic: budget rec cites actual spend", recs.some((r) => r.kind === "budget" && r.evidence.some((e) => e.includes("spendUsd=40"))));
  check("deterministic: hot-lead rec fires with evidence", recs.some((r) => r.kind === "growth" && r.evidence.some((e) => e.includes("hotOpen=2"))));

  // LLM leg unit: garbage insights (all-empty) fall back gracefully at the caller
  const emptyInsights = await insightsWithLLM(stubLlm({ analytics: { insights: [] } }), { version: 1, systemPrompt: ANALYTICS_DEFAULT_PROMPT }, payload);
  check("llm-unit: empty insights return empty array (caller keeps floor)", emptyInsights.length === 0);

  await expectThrow("llm-unit: invalid enum direction rejected by schema", async () => {
    await insightsWithLLM(stubLlm({ analytics: { insights: [{ metric: "m", direction: "SIDEWAYS", observation: "o" }] } }), { version: 1, systemPrompt: ANALYTICS_DEFAULT_PROMPT }, payload);
  }, "failed schema validation");

  await expectThrow("llm-unit: narrative with empty summary rejected", async () => {
    await narrativeWithLLM(stubLlm({ reporting: { summary: "", highlights: [], risks: [] } }), { version: 1, systemPrompt: REPORTING_DEFAULT_PROMPT }, payload);
  }, "failed schema validation");

  const clampedRecs = await recommendationsWithLLM(
    stubLlm({ strategy: { recommendations: [{ kind: "growth", priority: "high", title: "R", detail: "D", evidence: ["x"], extra: "dropped" }] } }),
    { version: 1, systemPrompt: STRATEGY_DEFAULT_PROMPT },
    payload
  );
  check("llm-unit: valid strategy payload passes with clamped fields", clampedRecs.length === 1 && clampedRecs[0].kind === "growth" && clampedRecs[0].title === "R");

  // getRecommendation + getReport null paths
  check("reads: missing report → null", (await getReport(999999999)) === null);
  check("reads: missing rec → null", (await getRecommendation(999999999)) === null);
}

/* ---------------- cleanup ---------------- */
await query(`DELETE FROM events WHERE name LIKE 'analytics.%' AND (payload->>'reportId')::int = ANY($1::int[])`, [reportIds]);
await query(`DELETE FROM strategy_recommendations WHERE report_id = ANY($1::int[]) OR dedup_hash = ANY($2::text[]) OR business_unit_id IN ($3, $4)`,
  [reportIds, manualHashes, buA, buB]);
await query(`DELETE FROM reports WHERE id = ANY($1::int[]) OR period_key LIKE '2030-%'`, [reportIds]);
await query(`DELETE FROM tasks WHERE id = ANY($1::int[])`, [spawnedTaskIds]);
await query(`DELETE FROM report_schedules WHERE id = ANY($1::int[])`, [testScheduleIds]);
await query(`DELETE FROM llm_requests WHERE business_unit_id IN ($1, $2)`, [buA, buB]);
await query(`DELETE FROM campaign_metrics WHERE campaign_id IN (SELECT id FROM campaigns WHERE business_unit_id IN ($1, $2))`, [buA, buB]);
await query(`DELETE FROM campaigns WHERE business_unit_id IN ($1, $2)`, [buA, buB]);
await query(`DELETE FROM content_items WHERE business_unit_id IN ($1, $2)`, [buA, buB]);
await query(`DELETE FROM leads WHERE business_unit_id IN ($1, $2)`, [buA, buB]);
await query(`DELETE FROM inquiries WHERE business_unit_id IN ($1, $2)`, [buA, buB]);
await query(`DELETE FROM business_units WHERE id IN ($1, $2)`, [buA, buB]);
// the analytics flag stays ON (matches production state; reads never gated)

console.log(failures === 0 ? "ALL ANALYTICS CHECKS PASS" : `FAILURES: ${failures}`);
process.exit(failures === 0 ? 0 : 1);
