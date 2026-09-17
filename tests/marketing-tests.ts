/**
 * Phase 11 — marketing workforce against real Postgres: audience segment
 * dedup + BU isolation, the campaign FSM (row-locked; launch requires a
 * human approver §91; paused→active re-launch PRESERVES the original
 * approver; terminal states refuse edits), campaign window validation,
 * metrics ingestion (append-only) + rollup sums + summary, exhausted-campaign
 * selection, the marketing_sweep handler (flag-off fail-closed skip; auto-
 * complete of past-end active campaigns; marketing.* events), and the brief
 * pipeline (deterministic evidence-grounded brief incl. thin evidence, LLM
 * leg parse + channel allowlist + clamping, honest refusal → null, LLM
 * failure → deterministic fallback).
 */
import { query } from "../lib/db";
import {
  createSegment,
  updateSegment,
  deleteSegment,
  listSegments,
  createCampaign,
  updateCampaign,
  transitionCampaign,
  ingestMetrics,
  campaignRollup,
  metricsSummary,
  findExhaustedCampaigns,
} from "../lib/marketing/service";
import { MarketingServiceError, canTransitionCampaign } from "../lib/marketing/types";
import { makeMarketingSweepHandler } from "../lib/marketing/tasks";
import { deterministicBrief, runBriefGeneration, generateBrief, gatherBriefContext, MARKETING_DEFAULT_PROMPT } from "../lib/marketing/pipeline";
import type { LLMClient } from "../lib/ai/types";
import { registerTaskHandler } from "../lib/tasks/handlers";

let failures = 0;
function check(name: string, cond: boolean, detail = "") {
  console.log(`${cond ? "PASS" : "FAIL"} ${name}${detail ? " :: " + detail + "" : ""}`);
  if (!cond) failures++;
}

async function expectError(name: string, p: () => Promise<unknown>, code: string) {
  try {
    await p();
    check(name, false, `expected ${code}, no error thrown`);
  } catch (e) {
    const ok = e instanceof MarketingServiceError && e.code === code;
    check(name, ok, ok ? "" : `expected ${code}, got ${e instanceof Error ? e.message : String(e)}`);
  }
}

const stamp = Date.now();

async function setupBu(name: string): Promise<number> {
  const [bu] = await query<{ id: number }>(
    `INSERT INTO business_units (slug, name) VALUES ($1, $2) RETURNING id`,
    [`marketing-${name}-${stamp}`, `Marketing BU ${name}`]
  );
  return bu.id;
}

async function setFlag(enabled: boolean) {
  await query(
    `INSERT INTO feature_flags (key, enabled, emergency, description)
     VALUES ('marketing', $1, false, 'test') ON CONFLICT (key) DO UPDATE SET enabled = $1`,
    [enabled]
  );
}

const buA = await setupBu("a");
const buB = await setupBu("b");

// A real user row — campaigns/segments carry FK references to users(id).
const [testUser] = await query<{ id: number }>(
  `INSERT INTO users (email, display_name, password_hash) VALUES ($1, $2, 'test-only-not-a-login') RETURNING id`,
  [`marketing-test-${stamp}@example.invalid`, `Marketing Test User ${stamp}`]
);
const approverId = testUser.id;

/* ---------------- FSM math (pure) ---------------- */
check("fsm: draft→active legal", canTransitionCampaign("draft", "active"));
check("fsm: draft→paused illegal", !canTransitionCampaign("draft", "paused"));
check("fsm: active→paused legal", canTransitionCampaign("active", "paused"));
check("fsm: paused→active legal", canTransitionCampaign("paused", "active"));
check("fsm: completed→anything illegal", !canTransitionCampaign("completed", "active") && !canTransitionCampaign("completed", "draft"));
check("fsm: cancelled terminal", !canTransitionCampaign("cancelled", "active") && !canTransitionCampaign("cancelled", "completed"));
check("fsm: unknown state safe", !canTransitionCampaign("bogus" as never, "active"));

/* ---------------- segments ---------------- */
const seg1 = await createSegment({ businessUnitId: buA, name: `Enterprise CTOs ${stamp}`, estimatedSize: 1200, criteria: { industry: "legal" } });
check("segment: created with defaults", seg1.id > 0 && seg1.source === "manual" && seg1.criteria.industry === "legal");
await expectError("segment: same-BU name dedup", () => createSegment({ businessUnitId: buA, name: `Enterprise CTOs ${stamp}` }), "DUPLICATE");
const segB = await createSegment({ businessUnitId: buB, name: `Enterprise CTOs ${stamp}` });
check("segment: same name allowed across BUs", segB.id > 0 && segB.businessUnitId === buB);

const segRenamed = await updateSegment(seg1.id, { name: `Buyer group ${stamp}`, estimatedSize: 2500 });
check("segment: update renames + resizes", segRenamed.name === `Buyer group ${stamp}` && segRenamed.estimatedSize === 2500);
await expectError("segment: rename to empty rejected", () => updateSegment(seg1.id, { name: "   " }), "BAD_NAME");

const listedA = await listSegments({ businessUnitId: buA });
check("segment: BU filter isolates", listedA.every((s) => s.businessUnitId === buA) && listedA.some((s) => s.id === seg1.id));
check("segment: BU B list excludes A", !(await listSegments({ businessUnitId: buB })).some((s) => s.id === seg1.id));

/* ---------------- campaigns: creation ---------------- */
const camp = await createCampaign({
  businessUnitId: buA,
  name: `Autumn push ${stamp}`,
  objective: "Convert legal-AI readers into trials",
  audienceSegmentId: seg1.id,
  startsAt: new Date().toISOString(),
  endsAt: new Date(Date.now() + 14 * 86_400_000).toISOString(),
  userId: approverId,
});
check("campaign: created as draft with fields", camp.status === "draft" && camp.audienceSegmentId === seg1.id && camp.approvedByUserId === null && camp.activatedAt === null);
await expectError("campaign: duplicate name per BU", () => createCampaign({ businessUnitId: buA, name: `Autumn push ${stamp}` }), "DUPLICATE");
await expectError("campaign: ends before starts", () => createCampaign({
  businessUnitId: buA, name: `Backwards ${stamp}`,
  startsAt: new Date().toISOString(), endsAt: new Date(Date.now() - 86_400_000).toISOString(),
}), "BAD_WINDOW");
await expectError("campaign: segment from another BU rejected", () => createCampaign({
  businessUnitId: buB, name: `Cross-BU ${stamp}`, audienceSegmentId: seg1.id,
}), "SEGMENT_NOT_FOUND");

/* ---------------- campaigns: FSM + approval law ---------------- */
await expectError("fsm: draft→paused illegal at runtime", () => transitionCampaign(camp.id, "paused"), "BAD_TRANSITION");
await expectError("fsm: launch without approver blocked (§91)", () => transitionCampaign(camp.id, "active"), "APPROVAL_REQUIRED");

const launched = await transitionCampaign(camp.id, "active", { approverUserId: approverId });
check("fsm: launch stamps approver + activatedAt", launched.status === "active" && launched.approvedByUserId === approverId && launched.approvedAt != null && launched.activatedAt != null);

const paused = await transitionCampaign(camp.id, "paused");
check("fsm: active→paused keeps approval history", paused.status === "paused" && paused.approvedByUserId === approverId && paused.approvedAt != null);

const relaunched = await transitionCampaign(camp.id, "active", { approverUserId: approverId + 1 });
check("fsm: relaunch PRESERVES original approver (immutable history)", relaunched.status === "active" && relaunched.approvedByUserId === approverId && relaunched.activatedAt != null);

const completed = await transitionCampaign(camp.id, "completed");
check("fsm: completion stamps completedAt", completed.status === "completed" && completed.completedAt != null);
await expectError("fsm: terminal campaign refuses edits", () => updateCampaign(camp.id, { objective: "new" }), "TERMINAL");
await expectError("fsm: terminal campaign refuses transitions", () => transitionCampaign(camp.id, "active", { approverUserId: 7 }), "BAD_TRANSITION");

/* ---------------- campaigns: field edits ---------------- */
const camp2 = await createCampaign({ businessUnitId: buA, name: `Editable ${stamp}` });
const edited = await updateCampaign(camp2.id, { objective: "Updated objective", audienceSegmentId: seg1.id });
check("campaign: field edit works in draft", edited.objective === "Updated objective" && edited.audienceSegmentId === seg1.id);
await expectError("campaign: edit cannot create backwards window", () => updateCampaign(camp2.id, {
  startsAt: new Date().toISOString(),
  endsAt: new Date(Date.now() - 86_400_000).toISOString(),
}), "BAD_WINDOW");
const cancelled = await transitionCampaign(camp2.id, "cancelled");
check("campaign: cancel from draft is legal + terminal", cancelled.status === "cancelled");

/* ---------------- metrics ---------------- */
await ingestMetrics({ campaignId: camp.id, impressions: 1000, clicks: 50, conversions: 5, spendUsd: 12.5, source: "provider" });
await ingestMetrics({ campaignId: camp.id, impressions: 500, clicks: 30, conversions: 2, spendUsd: 7.5, source: "manual" });
const roll = await campaignRollup(camp.id);
check("metrics: rollup sums append-only snapshots", roll.impressions === 1500 && roll.clicks === 80 && roll.conversions === 7 && Math.abs(roll.spendUsd - 20) < 0.001 && roll.snapshots === 2);
check("metrics: latest points at most recent snapshot", roll.latest != null && roll.latest.clicks === 30);
await expectError("metrics: unknown campaign rejected", () => ingestMetrics({ campaignId: 999999999, impressions: 1 }), "NOT_FOUND");
const summary = await metricsSummary({ businessUnitId: buA });
check("metrics: summary pairs campaigns with rollups", summary.some((s) => s.campaign.id === camp.id && s.rollup.impressions === 1500));

/* ---------------- exhausted + sweep ---------------- */
check("exhausted: completed/future campaign not selected", !(await findExhaustedCampaigns()).some((c) => c.id === camp.id));
const stale = await createCampaign({
  businessUnitId: buA, name: `Stale ${stamp}`,
  startsAt: new Date(Date.now() - 10 * 86_400_000).toISOString(),
  endsAt: new Date(Date.now() - 86_400_000).toISOString(),
});
await transitionCampaign(stale.id, "active", { approverUserId: approverId });
check("exhausted: past-end active campaign selected", (await findExhaustedCampaigns()).some((c) => c.id === stale.id));

// flag OFF → fail-closed skip
await setFlag(false);
registerTaskHandler("marketing_sweep", makeMarketingSweepHandler());
// run the handler through the task engine's stored registry by invoking directly:
const { getTaskHandler } = await import("../lib/tasks/handlers");
const handler = getTaskHandler("marketing_sweep");
check("sweep: handler registered", handler != null);
const offResult = await handler!({
  task: { id: 0, kind: "marketing_sweep", payload: {}, business_unit_id: null } as never,
  step: async () => {},
  cancelled: async () => false,
  log: async () => {},
} as never);
check("sweep: flag OFF skips fail-closed", (offResult as { skipped?: boolean }).skipped === true);

// flag ON → auto-completes the stale campaign, emits events
await setFlag(true);
const eventsBefore = (await query<{ n: string }>(`SELECT COUNT(*)::text AS n FROM events WHERE name = 'marketing.campaign_completed'`))[0].n;
const onResult = (await handler!({
  task: { id: 0, kind: "marketing_sweep", payload: {}, business_unit_id: null } as never,
  step: async () => {},
  cancelled: async () => false,
  log: async () => {},
} as never)) as { completed: number; campaigns: Array<{ campaignId: number; status: string }> };
check("sweep: past-end campaign auto-completed", onResult.completed >= 1 && onResult.campaigns.some((c) => c.campaignId === stale.id && c.status === "completed"));
const staleAfter = await query<{ status: string }>(`SELECT status FROM campaigns WHERE id = $1`, [stale.id]);
check("sweep: DB status flipped to completed", staleAfter[0]?.status === "completed");
const eventsAfter = (await query<{ n: string }>(`SELECT COUNT(*)::text AS n FROM events WHERE name = 'marketing.campaign_completed'`))[0].n;
check("sweep: marketing.campaign_completed event emitted", Number(eventsAfter) > Number(eventsBefore));

// re-run → alreadyTransitioned (idempotent, no double-count)
const rerun = (await handler!({
  task: { id: 0, kind: "marketing_sweep", payload: {}, business_unit_id: null } as never,
  step: async () => {},
  cancelled: async () => false,
  log: async () => {},
} as never)) as { completed: number; alreadyTransitioned: number; campaigns: Array<{ campaignId: number }> };
check("sweep: re-run does not double-complete", !rerun.campaigns.some((c) => c.campaignId === stale.id) && rerun.completed === 0);

/* ---------------- brief pipeline: deterministic leg ---------------- */
const thinCtx = { evidence: { buName: "Wakeely", brandVoice: "", persona: "", audience: "", contentTitles: [], segmentNames: [], connectedPlatforms: [] }, thin: true };
const thinBrief = deterministicBrief(thinCtx);
check("brief: thin evidence still yields honest brief", thinBrief.degraded && thinBrief.channels.length > 0 && thinBrief.notes!.includes("thin"));
check("brief: thin key message carries no invented claims", thinBrief.keyMessages.length === 1 && thinBrief.keyMessages[0].includes("no invented claims"));

const richCtx = {
  evidence: {
    buName: "Wakeely", brandVoice: "precise", persona: "", audience: "in-house counsel",
    contentTitles: ["AI compliance in 2026", "Vendor risk checklists"],
    segmentNames: [`Buyer group ${stamp}`],
    connectedPlatforms: ["linkedin", "x", "tiktok"],
  },
  thin: false,
};
const richBrief = deterministicBrief(richCtx);
check("brief: deterministic channels come from evidence + blog floor", richBrief.channels.includes("linkedin") && richBrief.channels.includes("x") && !richBrief.channels.includes("instagram"));
check("brief: deterministic keyMessages quote real evidence", richBrief.keyMessages.some((m) => m.includes("AI compliance in 2026")));
check("brief: audience falls back to BU audience field", richBrief.audienceSummary === "in-house counsel");

/* ---------------- brief pipeline: LLM leg ---------------- */
const stubLlm = (payload: unknown): LLMClient => ({
  complete: async () => JSON.stringify(payload),
  embed: async () => { throw new Error("not used"); },
});
const llmOut = await runBriefGeneration(richCtx, stubLlm({
  name: "Compliance season", objective: "Own the compliance conversation",
  audienceSummary: "Counsel evaluating AI tooling", keyMessages: ["Grounded", "  ", "Risk-first"],
  channels: ["linkedin", "BOGUS", "blog"], startOffsetDays: 40, durationDays: 300, notes: "assumed Q4",
}), { version: 2, systemPrompt: MARKETING_DEFAULT_PROMPT });
check("brief: LLM leg parses + allowlists channels", llmOut != null && !llmOut.degraded && llmOut.channels.includes("linkedin") && llmOut.channels.includes("blog") && !llmOut.channels.includes("BOGUS"));
check("brief: clamping bounds offsets/durations", llmOut!.startOffsetDays === 30 && llmOut!.durationDays === 90);
check("brief: blank key messages dropped", llmOut!.keyMessages.length === 2);

const refused = await runBriefGeneration(thinCtx, stubLlm({ name: "", objective: "", audienceSummary: "", keyMessages: [], channels: [], startOffsetDays: 0, durationDays: 0, notes: "insufficient evidence" }), { version: 2, systemPrompt: MARKETING_DEFAULT_PROMPT });
check("brief: honest refusal → null (not silent replacement)", refused === null);

const fallback = await generateBrief(richCtx, stubLlm({ error: { message: "insufficient_quota" } }), { version: 2, systemPrompt: MARKETING_DEFAULT_PROMPT });
check("brief: LLM failure degrades to deterministic", fallback.degraded && fallback.name.length > 0);

const refusedFallsBack = await generateBrief(richCtx, stubLlm({ name: "", objective: "", audienceSummary: "", keyMessages: [], channels: [], startOffsetDays: 0, durationDays: 0, notes: "insufficient evidence" }), { version: 2, systemPrompt: MARKETING_DEFAULT_PROMPT });
check("brief: refusal degrades to deterministic too", refusedFallsBack.degraded && refusedFallsBack.name.length > 0);

/* ---------------- gatherBriefContext (DB read-only legs) ---------------- */
const gathered = await gatherBriefContext(buA);
check("gather: BU profile loaded", gathered.evidence.buName === "Marketing BU a");
// seg1 still exists in buA (deleted only at cleanup) → not thin; verify thin on a virgin BU.
check("gather: not thin while segment exists", gathered.thin === false && gathered.evidence.segmentNames.length >= 1);
const buC = await setupBu("c");
const gatheredC = await gatherBriefContext(buC);
check("gather: thin for a BU with no content/segments", gatheredC.thin === true);

/* ---------------- segment delete ---------------- */
check("segment: delete returns true", await deleteSegment(segB.id));
check("segment: delete missing returns false", !(await deleteSegment(segB.id)));

/* ---------------- cleanup ---------------- */
await query(`DELETE FROM campaigns WHERE id = ANY($1::bigint[])`, [[camp.id, camp2.id, stale.id]]);
await query(`DELETE FROM audience_segments WHERE business_unit_id IN ($1, $2)`, [buA, buB]);
await query(`DELETE FROM business_units WHERE id IN ($1, $2, $3)`, [buA, buB, buC]);
await query(`DELETE FROM users WHERE id = $1`, [approverId]);
await query(`DELETE FROM feature_flags WHERE key = 'marketing'`);

console.log(failures === 0 ? "ALL MARKETING CHECKS PASS" : `FAILURES: ${failures}`);
process.exit(failures === 0 ? 0 : 1);
