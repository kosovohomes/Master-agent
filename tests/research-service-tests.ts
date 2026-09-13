/**
 * Phase 7 — research service: schedule CRUD + due math + period-idempotent
 * spawning, finding storage with dedup + escalation routing, unprocessed
 * (degraded) storage, human review transitions, competitor registry matching
 * and the events log. Runs against theephemeral/staging Postgres like every
 * other DB suite.
 */
import { query } from "../lib/db";
import crypto from "node:crypto";
import {
  createSchedule,
  listSchedules,
  updateSchedule,
  deleteSchedule,
  dueSchedules,
  spawnDueResearchRuns,
  periodKeyFor,
  recordFinding,
  recordUnprocessed,
  listItems,
  getItem,
  reviewItem,
  createCompetitor,
  listCompetitors,
  deleteCompetitor,
  recordCompetitorEvents,
  listCompetitorEvents,
  stats,
  ResearchServiceError,
} from "../lib/research/service";
import type { ResearchFinding, ResearchSource } from "../lib/research/types";

let failures = 0;
function check(name: string, cond: boolean, detail = "") {
  console.log(`${cond ? "PASS" : "FAIL"} ${name}${detail ? " :: " + detail : ""}`);
  if (!cond) failures++;
}

const stamp = Date.now();

async function setupBu(name: string): Promise<number> {
  const [bu] = await query<{ id: number }>(
    `INSERT INTO business_units (slug, name) VALUES ($1, $2) RETURNING id`,
    [`res-${name}-${stamp}`, `Research BU ${name}`]
  );
  return bu.id;
}

const SRC = (i: number, url: string): ResearchSource => ({
  index: i, title: `Source ${i}`, url, snippet: `excerpt ${i}`,
  fetchedAt: new Date().toISOString(), revision: "rev000",
});

function findingOf(over: Partial<ResearchFinding> = {}): ResearchFinding {
  return {
    title: "Senate passes AI licensing act",
    summary: "The senate passed the AI act requiring registration of high-risk systems (sources [1], [2]).",
    score: 88, confidence: 0.82, ambiguous: false,
    ...over,
  };
}

const buA = await setupBu("a");
const buB = await setupBu("b");

// ---------- schedules ----------
const s1 = await createSchedule({ businessUnitId: buA, agentSlug: "research", name: "daily AI", topic: "AI news {{date}}", queries: ["extra q"], cadence: "daily" });
check("schedule: created with defaults", s1.enabled === true && s1.maxItems === 5 && s1.cadence === "daily");
check("schedule: queries normalized", s1.queries.length === 1);

let dupErr: string | null = null;
try {
  await createSchedule({ businessUnitId: buA, agentSlug: "research", name: "daily AI", topic: "x" });
} catch (e) {
  dupErr = e instanceof ResearchServiceError ? e.code : null;
}
check("schedule: duplicate name rejected", dupErr === "DUPLICATE");

const buMissing = 999999999;
let nfErr: string | null = null;
try {
  await createSchedule({ businessUnitId: buMissing, agentSlug: "research", name: "ghost", topic: "x" });
} catch (e) {
  nfErr = e instanceof ResearchServiceError ? e.code : null;
}
check("schedule: unknown BU 404-coded", nfErr === "NOT_FOUND");

const s2 = await createSchedule({ businessUnitId: buB, agentSlug: "legal_intelligence", name: "legal weekly", topic: "regulatory {{date}}", cadence: "weekly" });
check("schedule: per-BU listing isolated", (await listSchedules(buA)).length === 1 && (await listSchedules(null)).length === 2);

// due math + spawn idempotency (BOTH schedules still enabled here)
const due0 = await dueSchedules();
check("due: fresh schedules due", due0.some((s) => s.id === s1.id) && due0.some((s) => s.id === s2.id));

const p1 = await spawnDueResearchRuns(periodKeyFor(new Date(), "daily"));
check("spawn: both due schedules spawned", p1.spawned === 2 && p1.taskIds.length === 2, JSON.stringify(p1));
const p2 = await spawnDueResearchRuns(periodKeyFor(new Date(), "daily"));
check("spawn: same period never double-spawns", p2.spawned === 0 && p2.due === 0);
const after = await listSchedules(null);
check("spawn: last_run_at stamped", after.every((s) => s.lastRunAt !== null));
const runRows = await query<{ payload: Record<string, unknown>; idempotency_key: string }>(
  "SELECT payload, idempotency_key FROM tasks WHERE id = ANY($1::bigint[]) ORDER BY id", [p1.taskIds]
);
check("spawn: task payload carries schedule context", runRows.every((r) => typeof r.payload.scheduleId === "number" && typeof r.payload.topic === "string"));
check("spawn: idempotency keys period-scoped", runRows.every((r) => /research_run:\d+:\d{4}-\d{2}-\d{2}$/.test(r.idempotency_key)));

const s1upd = await updateSchedule(s1.id, { enabled: false, cadence: "hourly" });
check("schedule: patch applied", s1upd?.enabled === false && s1upd?.cadence === "hourly");
check("schedule: patch unknown id null", (await updateSchedule(999999999, { enabled: true })) === null);

// ---------- findings + dedup + escalation ----------
const rec1 = await recordFinding({
  businessUnitId: buA, scheduleId: s1.id, agentSlug: "research",
  topic: "AI news", query: "AI news 2026-09-13",
  finding: findingOf(), sources: [SRC(1, "https://one.example/a"), SRC(2, "https://two.example/b")],
  dedupHash: `hash-a-${stamp}`, material: "material a", prompt: { version: 2, systemPrompt: "p" },
});
check("finding: stored with status finding", rec1.status === "finding" && !rec1.duplicate && rec1.item !== null);
check("finding: score/confidence persisted", rec1.item?.score === 88 && Math.abs((rec1.item?.confidence ?? 0) - 0.82) < 0.001);
check("finding: prompt fingerprint attached (sha256 of the prompt)", rec1.item?.promptVersion === 2 && rec1.item?.promptHash === crypto.createHash("sha256").update("p").digest("hex"));
check("finding: sources serialized", rec1.item?.sources.length === 2);

const rec1dup = await recordFinding({
  businessUnitId: buA, agentSlug: "research", topic: "AI news", query: "same",
  finding: findingOf({ title: "Different title same source" }),
  sources: [SRC(1, "https://one.example/a")], dedupHash: `hash-a-${stamp}`, material: "material a",
});
check("finding: dedup via (bu, hash) unique", rec1dup.duplicate === true && rec1dup.item === null);

const sameHashOtherBu = await recordFinding({
  businessUnitId: buB, agentSlug: "research", topic: "AI news", query: "q",
  finding: findingOf(), sources: [SRC(1, "https://one.example/a")],
  dedupHash: `hash-a-${stamp}`, material: "m",
});
check("finding: same hash across BUs is NOT a duplicate", sameHashOtherBu.duplicate === false);

const rec2 = await recordFinding({
  businessUnitId: buA, agentSlug: "research", topic: "ambiguous", query: "q",
  finding: findingOf({ ambiguous: true, confidence: 0.2, score: 30, title: "Conflicting reports" }),
  sources: [SRC(1, "https://three.example/c")], dedupHash: `hash-b-${stamp}`, material: "m2",
});
check("escalation: ambiguous → escalated", rec2.status === "escalated");

const rec3 = await recordFinding({
  businessUnitId: buA, agentSlug: "research", topic: "low conf", query: "q",
  finding: findingOf({ confidence: 0.1, title: "Low confidence read" }),
  sources: [SRC(1, "https://four.example/d")], dedupHash: `hash-c-${stamp}`, material: "m3",
});
check("escalation: low confidence → escalated", rec3.status === "escalated");

// events: escalated pages ops (row exists even when suppressed); finding does not page
const evRows = await query<{ name: string }>(
  `SELECT DISTINCT e.name FROM events e JOIN notifications n ON n.event_id = e.id
   WHERE n.created_at > now() - interval '1 minute' AND e.name LIKE 'research.%'`
);
check("events: escalation produced a notification event", evRows.some((r) => r.name === "research.escalated"));
check("events: clean finding does not notify", !evRows.some((r) => r.name === "research.finding"));

// ---------- degraded / unprocessed ----------
const un1 = await recordUnprocessed({
  businessUnitId: buA, agentSlug: "intelligence", topic: "market state", query: "market q",
  sources: [SRC(1, "https://five.example/e")], dedupHash: `hash-u-${stamp}`,
  material: "raw material", degradeReason: "budget_exceeded",
});
check("unprocessed: stored", un1.item !== null && !un1.duplicate);
check("unprocessed: title carries reason", (un1.item?.title ?? "").includes("budget_exceeded"));
const un1b = await recordUnprocessed({
  businessUnitId: buA, agentSlug: "intelligence", topic: "market state", query: "market q",
  sources: [SRC(1, "https://five.example/e")], dedupHash: `hash-u-${stamp}`,
  material: "raw material", degradeReason: "budget_exceeded",
});
check("unprocessed: dedup prevents duplicates", un1b.duplicate === true);

// ---------- review transitions ----------
const it1 = rec1.item!;
const v = await reviewItem(it1.id, "verify", "owner@test");
check("review: verify transition", v?.status === "verified" && v?.reviewedBy === "owner@test" && v?.reviewedAt !== null);
const r = await reviewItem(it1.id, "reject", "owner@test");
check("review: verified → rejected allowed", r?.status === "rejected");
const a = await reviewItem(it1.id, "archive", "owner@test");
check("review: archive allowed", a?.status === "archived");

// ---------- reprocess source rows ----------
const unItem = un1.item!;
const itemRow = await getItem(unItem.id);
check("item: get returns full row", itemRow?.id === unItem.id && itemRow?.status === "unprocessed");
const listed = await listItems({ businessUnitId: buA, status: "unprocessed" });
check("item: filtered listing", listed.some((i) => i.id === unItem.id));

// ---------- competitors ----------
const c1 = await createCompetitor({ businessUnitId: buA, name: "Acme AI", url: "https://acme.example" });
check("competitor: created", c1.enabled && c1.name === "Acme AI");
let cDup: string | null = null;
try {
  await createCompetitor({ businessUnitId: buA, name: "acme ai" }); // case-insensitive unique
} catch (e) {
  cDup = e instanceof ResearchServiceError ? e.code : null;
}
check("competitor: unique per BU (case-insensitive)", cDup === "DUPLICATE");
const c2 = await createCompetitor({ businessUnitId: buB, name: "Acme AI" });
check("competitor: same name different BU fine", c2.businessUnitId === buB);

const evs = await recordCompetitorEvents(buA, rec1.item!.id, [
  { competitor: "Acme AI", kind: "pricing", title: "Price cut 40%", url: "https://acme.example/pricing", citations: [1] },
  { competitor: "Untracked Corp", kind: "product", title: "No registry row" },
]);
check("competitor events: registry-matched only", evs.length === 1 && evs[0].kind === "pricing" && evs[0].competitorId === c1.id);
check("competitor events: listed newest-first", (await listCompetitorEvents(buA))[0]?.title === "Price cut 40%");

check("stats: grouped by status", (await stats(buA)).some((r) => r.status === "escalated"));
check("stats: BU-scoped", (await stats(buB)).every((r) => r.status !== "escalated"));

check("competitor: delete", await deleteCompetitor(c2.id) === true && (await listCompetitors(buB)).length === 0);

// ---------- schedule delete retains findings ----------
check("schedule: delete works", await deleteSchedule(s2.id) === true);
check("schedule: findings survive schedule delete", (await getItem(rec1.item!.id)) !== null);

console.log(failures === 0 ? "research-service: ALL PASS" : `research-service: ${failures} FAILURE(S)`);

// cleanup
await query(`DELETE FROM notifications WHERE event_id IN (SELECT id FROM events WHERE business_unit_id = ANY($1::bigint[]))`, [[buA, buB]]).catch(() => undefined);
await query(`DELETE FROM events WHERE business_unit_id = ANY($1::bigint[])`, [[buA, buB]]).catch(() => undefined);
await query(`DELETE FROM tasks WHERE kind = 'research_run' AND business_unit_id = ANY($1::bigint[])`, [[buA, buB]]).catch(() => undefined);
await query(`DELETE FROM research_items WHERE business_unit_id = ANY($1::bigint[])`, [[buA, buB]]).catch(() => undefined);
await query(`DELETE FROM research_schedules WHERE business_unit_id = ANY($1::bigint[])`, [[buA, buB]]).catch(() => undefined);
await query(`DELETE FROM business_units WHERE id = ANY($1::bigint[])`, [[buA, buB]]).catch(() => undefined);
process.exit(failures === 0 ? 0 : 1);
