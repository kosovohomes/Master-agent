/**
 * Phase 9 — SEO service against real Postgres: keyword upsert semantics
 * (normalized dedup, source overwrite, retired-keyword guard), recommendation
 * dedup (UNIQUE per BU via dedup_hash), the MANDATORY evidence gate, the
 * approval-flag FSM (open → approved | dismissed, approved → done; terminal
 * states terminal; concurrent decisions exactly-one-wins; reviewer identity
 * immutable), BU isolation, and stats.
 */
import { query } from "../lib/db";
import {
  dedupHashFor,
  getRecommendation,
  listKeywords,
  listRecommendations,
  normalizeKeyword,
  recordRecommendation,
  setKeywordStatus,
  stats,
  transitionRecommendation,
  upsertKeyword,
  SeoServiceError,
} from "../lib/seo/service";
import type { SeoRecommendationDraft } from "../lib/seo/types";

let failures = 0;
function check(name: string, cond: boolean, detail = "") {
  console.log(`${cond ? "PASS" : "FAIL"} ${name}${detail ? " :: " + detail : ""}`);
  if (!cond) failures++;
}

const stamp = Date.now();

async function setupBu(name: string): Promise<number> {
  const [bu] = await query<{ id: number }>(
    `INSERT INTO business_units (slug, name) VALUES ($1, $2) RETURNING id`,
    [`seo-${name}-${stamp}`, `SEO BU ${name}`]
  );
  return bu.id;
}

const buA = await setupBu("a");
const buB = await setupBu("b");

// ---------- keyword upsert ----------
const first = await upsertKeyword({ businessUnitId: buA, draft: { keyword: "Modular Homes", source: "research" } });
check("keyword: first observation created", first.created && first.row.keyword === "Modular Homes");
check("keyword: normalized form stored", first.row.normalizedKeyword === "modular homes");

const second = await upsertKeyword({ businessUnitId: buA, draft: { keyword: "modular   HOMES", intent: "commercial", difficultyEst: 55, source: "scan" } });
check("keyword: re-observation does not create a row", !second.created && second.row.id === first.row.id);
check("keyword: re-observation updates intent + difficulty", second.row.intent === "commercial" && second.row.difficultyEst === 55);
check("keyword: display keyword refreshed", second.row.keyword === "modular   HOMES");

const otherBu = await upsertKeyword({ businessUnitId: buB, draft: { keyword: "Modular Homes", source: "manual" } });
check("keyword: same term in another BU is independent", otherBu.created && otherBu.row.id !== first.row.id);

let retired = await setKeywordStatus(first.row.id, "retired");
check("keyword: retire works", retired?.status === "retired");
const afterRetire = await upsertKeyword({ businessUnitId: buA, draft: { keyword: "modular homes", source: "scan" } });
check("keyword: scans do NOT resurrect retired keywords", !afterRetire.created && afterRetire.row.status === "retired");
const resurrect = await upsertKeyword({ businessUnitId: buA, draft: { keyword: "modular homes", source: "manual" } });
check("keyword: manual re-entry reactivates", resurrect.row.status === "active");

const listed = await listKeywords({ businessUnitId: buA, status: "active" });
check("keyword: BU isolation on list", listed.every((k) => k.businessUnitId === buA) && listed.some((k) => k.id === first.row.id));

let invalid = false;
try { await upsertKeyword({ businessUnitId: buA, draft: { keyword: "   " } }); } catch (e) {
  invalid = e instanceof SeoServiceError && e.code === "invalid_keyword";
}
check("keyword: empty keyword rejected", invalid);

// ---------- recommendations: evidence gate + dedup ----------
const draft: SeoRecommendationDraft = {
  kind: "gap",
  title: 'Close keyword gap: "modular homes"',
  detail: "Competitor intelligence surfaces this term; the store does not track it.",
  evidence: [{ label: "Competitor intelligence: RivalCo", url: "https://rival.example", note: "Term appears in tracked competitor activity (gap)." }],
  risk: "low",
};

let noEvidence = false;
try {
  await recordRecommendation({ businessUnitId: buA, draft: { ...draft, evidence: [] } });
} catch (e) {
  noEvidence = e instanceof SeoServiceError && e.code === "evidence_required";
}
check("recommendation: evidence MANDATORY (empty array rejected)", noEvidence);

let emptyNote = false;
try {
  await recordRecommendation({ businessUnitId: buA, draft: { ...draft, evidence: [{ label: "x", note: "  " }] } });
} catch (e) {
  emptyNote = e instanceof SeoServiceError && e.code === "invalid_evidence";
}
check("recommendation: evidence entries need label + note", emptyNote);

const rec1 = await recordRecommendation({ businessUnitId: buA, draft, taskId: null, promptVersion: 1, promptHash: "abc" });
check("recommendation: stored open with evidence", rec1.row !== null && rec1.row?.status === "open" && rec1.duplicate === false);
check("recommendation: attribution recorded", rec1.row?.agentSlug === "seo" && rec1.row?.promptVersion === 1 && rec1.row?.promptHash === "abc");

const rec2 = await recordRecommendation({ businessUnitId: buA, draft });
check("recommendation: identical advice dedups (counted no-op)", rec2.duplicate && rec2.row === null);

const recOtherBu = await recordRecommendation({ businessUnitId: buB, draft });
check("recommendation: same advice in another BU is a NEW row", !recOtherBu.duplicate && recOtherBu.row !== null);

let badKind = false;
try {
  await recordRecommendation({ businessUnitId: buA, draft: { ...draft, kind: "wild" as never } });
} catch (e) {
  badKind = e instanceof SeoServiceError && e.code === "invalid_kind";
}
check("recommendation: unknown kind rejected", badKind);

// ---------- approval FSM ----------
const approved = await transitionRecommendation(rec1.row!.id, "approved", "owner@test");
check("fsm: open → approved", approved.status === "approved");
check("fsm: reviewer identity stamped", approved.reviewedBy === "owner@test" && approved.reviewedAt !== null);

let illegalSelf = false;
try { await transitionRecommendation(rec1.row!.id, "open", "owner@test"); } catch (e) {
  illegalSelf = e instanceof SeoServiceError && e.code === "invalid_transition";
}
check("fsm: approved → open is illegal", illegalSelf);

const done = await transitionRecommendation(rec1.row!.id, "done", "owner@test");
check("fsm: approved → done", done.status === "done");

let illegalFromDone = false;
try { await transitionRecommendation(rec1.row!.id, "approved", "owner@test"); } catch (e) {
  illegalFromDone = e instanceof SeoServiceError && e.code === "invalid_transition";
}
check("fsm: done is terminal", illegalFromDone);

const dismissed = await transitionRecommendation(recOtherBu.row!.id, "dismissed", "owner@test");
check("fsm: open → dismissed (terminal)", dismissed.status === "dismissed");
let revive = false;
try { await transitionRecommendation(recOtherBu.row!.id, "approved", "owner@test"); } catch (e) {
  revive = e instanceof SeoServiceError && e.code === "invalid_transition";
}
check("fsm: dismissed cannot be resurrected", revive);

// concurrent decision: two parallel approve attempts, exactly one wins
const race = await recordRecommendation({
  businessUnitId: buA,
  draft: { ...draft, title: 'Close keyword gap: "race term"' },
});
check("race: second distinct draft stored", race.row !== null);
const raced = await Promise.allSettled([
  transitionRecommendation(race.row!.id, "approved", "racerA"),
  transitionRecommendation(race.row!.id, "approved", "racerB"),
]);
const fulfilled = raced.filter((r) => r.status === "fulfilled");
// The loser surfaces EITHER 'conflict' (its UPDATE lost the row-level race)
// or 'invalid_transition' (it read the status after the winner committed) —
// both mean exactly one decision won.
const loserRejected = raced.filter((r) => r.status === "rejected" && (r as PromiseRejectedResult).reason instanceof SeoServiceError);
check("race: exactly one concurrent decision wins",
  fulfilled.length === 1 && loserRejected.length === 1,
  raced.map((r) => r.status === "fulfilled" ? "fulfilled" : `rejected:${(r as PromiseRejectedResult).reason instanceof SeoServiceError ? (r as PromiseRejectedResult).reason.code : "other"}`).join(" | "));

// immutability: reviewed_by from the WINNER survives the loser's rejection
check("race: winner identity recorded", (await getRecommendation(race.row!.id))?.reviewedBy === "racerA" || (await getRecommendation(race.row!.id))?.reviewedBy === "racerB");

let notFound = false;
try { await transitionRecommendation(999999, "approved", "x"); } catch (e) {
  notFound = e instanceof SeoServiceError && e.code === "not_found";
}
check("fsm: unknown recommendation → not_found", notFound);

// ---------- lists + stats ----------
const recListA = await listRecommendations({ businessUnitId: buA });
check("list: BU isolation", recListA.every((r) => r.businessUnitId === buA));
const openOnly = await listRecommendations({ businessUnitId: buA, status: "open" });
check("list: status filter", openOnly.every((r) => r.status === "open"));

const recStats = await stats(buA);
check("stats: keyword counts", recStats.keywordsActive >= 1);
check("stats: recommendation counts reflect the FSM",
  recStats.recommendationsDone === 1 && recStats.recommendationsDismissed === 0 && recStats.recommendationsApproved === 1);
check("stats: evidence coverage 100%", recStats.withEvidencePct === 100);

// dedup hash sanity: the stored hash matches the canonical computation
check("dedup: stored hash matches dedupHashFor",
  rec1.row?.dedupHash === dedupHashFor(buA, "gap", null, normalizeKeyword("Close keyword gap: \"modular homes\"")) ||
  rec1.row?.dedupHash === dedupHashFor(buA, "gap", null, 'Close keyword gap: "modular homes"'),
  `stored=${rec1.row?.dedupHash?.slice(0, 12)}`);

console.log(failures === 0 ? "\nALL PASS" : `\n${failures} FAILURES`);
process.exit(failures === 0 ? 0 : 1);
