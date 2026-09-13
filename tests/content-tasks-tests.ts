/**
 * Phase 8 — content chain + content_run task handler against real task rows:
 * three-step LLM sequence (strategy → content → fact_check) from versioned
 * prompts, persistence (version + lifecycle + risk-mapped review submission),
 * research lineage mode, degraded mode (LLM down → item parked, task
 * succeeds, §144), and the reprocess path.
 */
import { query } from "../lib/db";
import { spawnTask } from "../lib/tasks/queue";
import { makeContentRunHandler } from "../lib/content/tasks";
import { getItem, listVersions, listApprovalsForItem } from "../lib/content/service";
import type { LLMClient, ChatMessage } from "../lib/ai/types";
import type { TaskHandlerInput, TaskRow } from "../lib/tasks/types";

let failures = 0;
function check(name: string, cond: boolean, detail = "") {
  console.log(`${cond ? "PASS" : "FAIL"} ${name}${detail ? " :: " + detail : ""}`);
  if (!cond) failures++;
}

const stamp = Date.now();

async function flag(on: boolean): Promise<void> {
  await query("UPDATE feature_flags SET enabled = $1 WHERE key = 'content'", [on]);
}
async function flagValue(): Promise<boolean> {
  const rows = await query<{ enabled: boolean }>("SELECT enabled FROM feature_flags WHERE key = 'content'");
  return rows[0]?.enabled ?? false;
}
const flagBefore = await flagValue();

const [bu] = await query<{ id: number }>(
  `INSERT INTO business_units (slug, name) VALUES ($1, $2) RETURNING id`,
  [`cnt-chain-${stamp}`, `Content Chain BU`]
);
const buId = bu.id;

const PLAN = JSON.stringify({
  angle: "Housing supply squeeze drives demand for modular builds",
  audience: "first-time buyers",
  channel: "blog",
  tone: "informative",
  keyMessages: [{ message: "Modular cuts build time", citations: [1] }],
  outline: ["The squeeze", "Modular answer", "What it means for buyers"],
  ambiguous: false,
});
const DRAFT = JSON.stringify({
  title: "Why modular homes are the answer to the housing squeeze",
  body: "The housing market is tight [1]. Modular construction cuts build times dramatically [1]. For first-time buyers this changes the math [1].",
});
const FACT_PASS = JSON.stringify({
  status: "pass",
  claims: [{ claim: "Modular cuts build time", verdict: "supported", citations: [1], correction: null }],
  summary: "All claims supported by sources.",
});
const FACT_WARN = JSON.stringify({
  status: "warnings",
  claims: [
    { claim: "Modular cuts build time", verdict: "supported", citations: [1], correction: null },
    { claim: "Prices fell 40%", verdict: "unverifiable", citations: [], correction: null },
  ],
  summary: "One claim unverifiable.",
});

function fakeLlm(responding: (messages: ChatMessage[], call: number) => string): { client: LLMClient; calls: number[]; prompts: string[] } {
  let n = 0;
  const prompts: string[] = [];
  return {
    calls: [],
    prompts,
    client: {
      complete: async (messages: ChatMessage[]) => {
        n += 1;
        // completeJSON prepends its own schema-hint system message; the
        // agent's versioned system prompt is the one naming the Agent role.
        prompts.push(String(messages.find((m) => m.role === "system" && /Agent/.test(String(m.content)))?.content ?? "").slice(0, 60));
        return responding(messages, n);
      },
      embed: async () => { throw new Error("not used"); },
    },
  };
}

/** Pick the response by WHICH SCHEMA the caller demanded (call-order agnostic). */
function bySchema(messages: ChatMessage[]): string {
  const hint = String(messages.find((m) => m.role === "system" && /JSON Schema/.test(String(m.content)))?.content ?? "");
  if (hint.includes('"angle"')) return PLAN;
  if (hint.includes('"body"')) return DRAFT;
  if (hint.includes('"verdict"')) return FACT_PASS;
  throw new Error("fakeLlm: unrecognized schema");
}

function makeStepRecorder(): { input: Omit<TaskHandlerInput, "task">; names: string[] } {
  const names: string[] = [];
  return {
    names,
    input: {
      step: async (name: string, fn: () => Promise<Record<string, unknown> | void>) => {
        names.push(name);
        return fn();
      },
      cancelled: async () => false,
    },
  };
}

async function loadTask(id: number): Promise<TaskRow> {
  const rows = await query<TaskRow>("SELECT * FROM tasks WHERE id = $1", [id]);
  return rows[0];
}

// ---------- 1. flag OFF → skip ----------
await flag(false);
const off = fakeLlm(() => { throw new Error("must not be called"); });
const handlerOff = makeContentRunHandler({ llm: off.client });
const t1 = await spawnTask({ businessUnitId: buId, kind: "content_run", payload: { brief: "test brief for the flag check" }, createdBy: "test" });
const in1 = makeStepRecorder();
const out1 = await handlerOff({ task: await loadTask(t1.taskId), ...in1.input });
check("flag off: skipped cleanly", (out1 as Record<string, unknown>).skipped === true);
check("flag off: no steps ran", in1.names.length === 0);
check("flag off: no items created", (await query<{ n: number }>("SELECT count(*)::int AS n FROM content_items WHERE business_unit_id = $1", [buId]))[0].n === 0);

// ---------- 2. happy path (brief mode): 3 steps in order → REVIEW, risk-mapped ----------
await flag(true);
const happy = fakeLlm((m) => bySchema(m));
const handler = makeContentRunHandler({ llm: happy.client });
const t2 = await spawnTask({ businessUnitId: buId, kind: "content_run", payload: { brief: "Write about modular housing for first-time buyers." }, createdBy: "test" });
const in2 = makeStepRecorder();
const out2 = (await handler({ task: await loadTask(t2.taskId), ...in2.input })) as { itemId: number; lifecycle: string; versions: number; riskLevel: string; approvalSubmitted: boolean; degraded: boolean };
check("happy: not degraded", out2.degraded === false);
check("happy: 3 chain steps recorded", in2.names.join(",") === "prepare,chain", in2.names.join(","));
check("happy: prompt order strategy→content→fact_check", happy.prompts.length === 3 && /Strategy/.test(happy.prompts[0]) && /Content Agent/.test(happy.prompts[1]) && /Fact Check/.test(happy.prompts[2]), happy.prompts.join(" | "));
check("happy: item at REVIEW", out2.lifecycle === "REVIEW");
check("happy: one version appended", out2.versions === 1);
check("happy: fact-check pass → risk low", out2.riskLevel === "low" && out2.approvalSubmitted === true);
const item2 = await getItem(out2.itemId);
check("happy: item lineage + task linkage", item2?.taskId === t2.taskId && item2?.lifecycle === "REVIEW");
const versions2 = await listVersions(out2.itemId);
check("happy: version metadata carries plan + factCheck", versions2.length === 1 && (versions2[0].metadata as { plan?: unknown; factCheck?: unknown }).plan != null && (versions2[0].metadata as { factCheck?: unknown }).factCheck != null);
check("happy: version prompt attribution stamped", versions2[0].createdByAgent === "content-chain" && versions2[0].promptHash != null);

// warnings fact-check → medium risk
const warn = fakeLlm((m) => (bySchema(m) === DRAFT ? DRAFT : bySchema(m) === PLAN ? PLAN : FACT_WARN));
const handlerWarn = makeContentRunHandler({ llm: warn.client });
const t2b = await spawnTask({ businessUnitId: buId, kind: "content_run", payload: { brief: "Warnings-path brief for the housing piece." }, createdBy: "test" });
const out2b = (await handlerWarn({ task: await loadTask(t2b.taskId), ...makeStepRecorder().input })) as { riskLevel: string };
check("happy: warnings → risk medium", out2b.riskLevel === "medium");

// ---------- 3. research lineage mode ----------
const [ri] = await query<{ id: number }>(
  `INSERT INTO research_items (business_unit_id, agent_slug, topic, status, title, summary, sources, dedup_hash)
   VALUES ($1, 'research', 'modular housing market', 'verified', 'Modular demand up', 'Demand for modular homes rose [1].', $2::jsonb, $3) RETURNING id`,
  [buId, JSON.stringify([{ index: 1, title: "Market report", url: `https://mkt.example/${stamp}`, snippet: "Modular demand rose 20%.", fetchedAt: new Date().toISOString(), revision: "r1" }]), `chain-ri-${stamp}`]
);
const lineage = fakeLlm((m) => bySchema(m));
const handlerLineage = makeContentRunHandler({ llm: lineage.client });
const t3 = await spawnTask({ businessUnitId: buId, kind: "content_run", payload: { researchItemId: ri.id, type: "article" }, createdBy: "test" });
const out3 = (await handlerLineage({ task: await loadTask(t3.taskId), ...makeStepRecorder().input })) as { itemId: number; fromResearchItemId: number; lifecycle: string };
const item3 = await getItem(out3.itemId);
check("lineage: item created with research_item_id", out3.fromResearchItemId === ri.id && item3?.researchItemId === ri.id);
check("lineage: brief carries research context", String((item3?.brief as { topic?: string }).topic).includes("modular"));
check("lineage: reached REVIEW", out3.lifecycle === "REVIEW");

// invalid research status (unprocessed) → handler fails the task
const [riBad] = await query<{ id: number }>(
  `INSERT INTO research_items (business_unit_id, agent_slug, topic, status, dedup_hash)
   VALUES ($1, 'research', 'bad item', 'unprocessed', $2) RETURNING id`,
  [buId, `chain-ri-bad-${stamp}`]
);
const t3b = await spawnTask({ businessUnitId: buId, kind: "content_run", payload: { researchItemId: riBad.id }, createdBy: "test" });
let rejectedSource = false;
try {
  await handlerLineage({ task: await loadTask(t3b.taskId), ...makeStepRecorder().input });
} catch {
  rejectedSource = true;
}
check("lineage: unprocessed research item rejected as source", rejectedSource);

// ---------- 4. degraded mode: LLM down → parked + task succeeds ----------
const broken = fakeLlm(() => { throw new Error("502 insufficient_quota"); });
const handlerBroken = makeContentRunHandler({ llm: broken.client });
const t4 = await spawnTask({ businessUnitId: buId, kind: "content_run", payload: { brief: "Degraded path brief about housing." }, createdBy: "test" });
const in4 = makeStepRecorder();
const out4 = (await handlerBroken({ task: await loadTask(t4.taskId), ...in4.input })) as { degraded: boolean; degradeReason: string; itemId: number; approvalSubmitted: boolean };
check("degraded: task succeeds with degraded=true", out4.degraded === true && out4.degradeReason.includes("insufficient_quota"));
check("degraded: no approval submitted", out4.approvalSubmitted === false);
const parked = await getItem(out4.itemId);
check("degraded: item parked in RESEARCHING", parked?.lifecycle === "RESEARCHING");
check("degraded: unprocessed_reason preserved", (parked?.unprocessedReason ?? "").includes("insufficient_quota"));
check("degraded: brief preserved for reprocess", ((parked?.brief as { brief?: string }).brief ?? "").includes("Degraded path brief"));

// ---------- 5. reprocess: parked item runs the chain once LLM is back ----------
const t5 = await spawnTask({ businessUnitId: buId, kind: "content_run", payload: { contentItemId: out4.itemId }, createdBy: "test" });
const out5 = (await handler({ task: await loadTask(t5.taskId), ...makeStepRecorder().input })) as { degraded: boolean; lifecycle: string; itemId: number };
check("reprocess: parked item completes once funded", out5.degraded === false && out5.lifecycle === "REVIEW" && out5.itemId === out4.itemId);
const reprocessed = await getItem(out4.itemId);
check("reprocess: reason cleared", reprocessed?.unprocessedReason === null);

// degraded reprocess keeps working: broken LLM again re-parks the SAME item
const t5b = await spawnTask({ businessUnitId: buId, kind: "content_run", payload: { contentItemId: out4.itemId }, createdBy: "test" });
const out5b = (await handlerBroken({ task: await loadTask(t5b.taskId), ...makeStepRecorder().input })) as { degraded: boolean };
check("reprocess: broken provider re-parks (still succeeds)", out5b.degraded === true);

// cleanup: restore flag + cancel leftover queued content_run tasks so the
// shared staging DB's engine sweeps are not starved by test artifacts
// (handlers were invoked directly; their task rows would otherwise sit
// claimable forever — same shared-DB hygiene as the other task suites).
await flag(flagBefore);
await query(
  `UPDATE tasks SET status = 'cancelled', error = 'cleanup: local test artifact',
     finished_at = now(), updated_at = now()
   WHERE kind = 'content_run' AND created_by = 'test' AND status IN ('queued','claimed','running')`
);

if (failures > 0) {
  console.error(`\n${failures} content chain/task check(s) FAILED`);
  process.exit(1);
}
console.log("\nAll content chain/task checks passed.");
