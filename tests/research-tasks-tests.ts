/**
 * Phase 7 — research_run task handler end-to-end against real task rows:
 * flag-off skip, happy path (finding stored + schedule stamped + result
 * counters), degraded mode (unprocessed material, task still succeeds),
 * reprocess mode, and the disabled-schedule skip. The handler is invoked
 * directly (no engine tick) with spawned durable task rows so the FK
 * linkage (research_items.task_id → tasks.id) is exercised for real.
 */
import { query } from "../lib/db";
import { spawnTask } from "../lib/tasks/queue";
import { makeResearchRunHandler } from "../lib/research/tasks";
import { createSchedule, createCompetitor, getItem } from "../lib/research/service";
import { makeResearchTools } from "../lib/research/tools";
import type { LLMClient, ChatMessage } from "../lib/ai/types";
import type { TaskHandlerInput } from "../lib/tasks/types";
import type { TaskRow } from "../lib/tasks/types";
import type { FetchImpl } from "../lib/knowledge/fetchers";

let failures = 0;
function check(name: string, cond: boolean, detail = "") {
  console.log(`${cond ? "PASS" : "FAIL"} ${name}${detail ? " :: " + detail : ""}`);
  if (!cond) failures++;
}

const stamp = Date.now();

async function flag(on: boolean): Promise<void> {
  await query("UPDATE feature_flags SET enabled = $1 WHERE key = 'research'", [on]);
}
async function flagValue(): Promise<boolean> {
  const rows = await query<{ enabled: boolean }>("SELECT enabled FROM feature_flags WHERE key = 'research'");
  return rows[0]?.enabled ?? false;
}
const flagBefore = await flagValue();

const [bu] = await query<{ id: number }>(
  `INSERT INTO business_units (slug, name) VALUES ($1, $2) RETURNING id`,
  [`rst-${stamp}`, `Research Task BU`]
);
const buId = bu.id;

function fakeLlm(responding: (messages: ChatMessage[]) => string): LLMClient {
  return {
    complete: async (messages: ChatMessage[]) => responding(messages),
    embed: async () => { throw new Error("not used"); },
  };
}

const FINDING = JSON.stringify({
  title: "AI act passes senate",
  summary: "The senate passed the AI act requiring registration of high-risk systems (source [1]).",
  score: 90, confidence: 0.9, ambiguous: false,
});

const html: FetchImpl = (async () => ({
  ok: true, status: 200,
  headers: { get: (n: string) => (n.toLowerCase() === "content-type" ? "text/html" : null) },
  text: async () => `<html><head><title>Hit</title></head><body>The senate passed the AI act today.</body></html>`,
})) as unknown as FetchImpl;

// Stable-URL provider: tests 2/3 exercise the dedup gate (same source URL →
// same dedup hash → the second run is a counted duplicate).
const tools = makeResearchTools({
  searchProvider: {
    id: "fake",
    search: async () => [{ title: "AI act passes", url: `https://news.example/${stamp}`, snippet: "senate passed" }],
  },
  fetchImpl: html,
});

// Fresh-URL provider: the degraded run collects NEW material so its
// unprocessed item is not swallowed by the dedup gate from tests 2/3.
const toolsFresh = makeResearchTools({
  searchProvider: {
    id: "fake-fresh",
    search: async () => [{ title: "Fresh material", url: `https://fresh.example/${stamp}-${Math.random().toString(36).slice(2, 8)}`, snippet: "fresh" }],
  },
  fetchImpl: html,
});

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

const handler = makeResearchRunHandler({ llm: fakeLlm(() => FINDING), tools });

// ---------- 1. flag OFF → skip (no error, no work) ----------
await flag(false);
const t1 = await spawnTask({ businessUnitId: buId, kind: "research_run", payload: { topic: "x" }, createdBy: "test" });
const in1 = makeStepRecorder();
const out1 = await handler({ task: await loadTask(t1.taskId), ...in1.input });
check("flag off: skipped cleanly", (out1 as Record<string, unknown>).skipped === true);
check("flag off: no steps ran", in1.names.length === 0);
check("flag off: no items stored", (await query<{ n: number }>("SELECT count(*)::int AS n FROM research_items WHERE business_unit_id = $1", [buId]))[0].n === 0);

// ---------- 2. happy path ----------
await flag(true);
const schedule = await createSchedule({ businessUnitId: buId, agentSlug: "research", name: "run-daily", topic: "AI regulation {{date}}" });
await createCompetitor({ businessUnitId: buId, name: "Zeta Systems" });
const t2 = await spawnTask({
  businessUnitId: buId, kind: "research_run",
  payload: { scheduleId: schedule.id, agentSlug: "research", topic: schedule.topic },
  createdBy: "test",
});
const in2 = makeStepRecorder();
const out2 = (await handler({ task: await loadTask(t2.taskId), ...in2.input })) as Record<string, unknown>;
check("happy: steps recorded (prepare → research)", in2.names.join(",") === "prepare,research", in2.names.join(","));
check("happy: one finding, none degraded", out2.findings === 1 && out2.degraded === false, JSON.stringify(out2));
check("happy: sources collected via fake tools", (out2.collected as number) >= 1);
const items = await query<{ id: number; status: string; task_id: number }>(
  "SELECT id, status, task_id FROM research_items WHERE business_unit_id = $1", [buId]
);
check("happy: item linked to the task row", items.length === 1 && items[0].status === "finding" && items[0].task_id === t2.taskId);
const schedRow = await query<{ last_run_at: Date | null }>("SELECT last_run_at FROM research_schedules WHERE id = $1", [schedule.id]);
check("happy: schedule last_run stamped", schedRow[0]?.last_run_at !== null);

// ---------- 3. dedup: identical content next run → duplicate counted ----------
const t3 = await spawnTask({
  businessUnitId: buId, kind: "research_run",
  payload: { scheduleId: schedule.id, agentSlug: "research", topic: schedule.topic },
  idempotencyKey: `manual-run-${stamp}-3`, createdBy: "test",
});
const out3 = (await handler({ task: await loadTask(t3.taskId), ...makeStepRecorder().input })) as Record<string, unknown>;
check("dedup: second identical run counted as duplicate", out3.duplicates === 1 && out3.findings === 0, JSON.stringify(out3));
check("dedup: still exactly one item", (await query<{ n: number }>("SELECT count(*)::int AS n FROM research_items WHERE business_unit_id = $1", [buId]))[0].n === 1);

// ---------- 4. degraded: LLM dead → unprocessed, task succeeds ----------
const degradedHandler = makeResearchRunHandler({
  llm: fakeLlm(() => { throw new Error("429 insufficient_quota"); }),
  tools: toolsFresh,
});
const t4 = await spawnTask({
  businessUnitId: buId, kind: "research_run",
  payload: { topic: `fresh topic ${stamp}`, agentSlug: "research" },
  idempotencyKey: `manual-run-${stamp}-4`, createdBy: "test",
});
const out4 = (await degradedHandler({ task: await loadTask(t4.taskId), ...makeStepRecorder().input })) as Record<string, unknown>;
check("degraded: task result reports degraded", out4.degraded === true && (out4.unprocessed as number) >= 1, JSON.stringify(out4));
const unRows = await query<{ status: string; title: string }>(
  "SELECT status, title FROM research_items WHERE business_unit_id = $1 AND status = 'unprocessed'", [buId]
);
check("degraded: unprocessed item stored with reason", unRows.length === 1 && (unRows[0].title ?? "").includes("LLM unavailable"), JSON.stringify(unRows));

// ---------- 5. reprocess: unprocessed → finding via stored material ----------
const unItem = unRows[0] ? (await query<{ id: number }>("SELECT id FROM research_items WHERE business_unit_id = $1 AND status = 'unprocessed'", [buId]))[0] : null;
if (unItem) {
  const t5 = await spawnTask({
    businessUnitId: buId, kind: "research_run",
    payload: { researchItemId: unItem.id, agentSlug: "research" },
    idempotencyKey: `reprocess-${stamp}-5`, createdBy: "test",
  });
  const out5 = (await handler({ task: await loadTask(t5.taskId), ...makeStepRecorder().input })) as Record<string, unknown>;
  check("reprocess: item upgraded to finding", out5.status === "finding", JSON.stringify(out5));
  const reRow = await getItem(unItem.id);
  check("reprocess: row now carries score + summary", reRow?.score === 90 && (reRow?.summary ?? "").length > 20);
  // reprocess of a processed item is a skip, not an error
  const t6 = await spawnTask({
    businessUnitId: buId, kind: "research_run",
    payload: { researchItemId: unItem.id, agentSlug: "research" },
    idempotencyKey: `reprocess-${stamp}-6`, createdBy: "test",
  });
  const out6 = (await handler({ task: await loadTask(t6.taskId), ...makeStepRecorder().input })) as Record<string, unknown>;
  check("reprocess: non-unprocessed item skipped", (out6 as Record<string, unknown>).skipped === true);
} else {
  check("reprocess: setup produced an unprocessed item", false);
}

// ---------- 6. disabled schedule → skip ----------
await query("UPDATE research_schedules SET enabled = false WHERE id = $1", [schedule.id]);
const t7 = await spawnTask({
  businessUnitId: buId, kind: "research_run",
  payload: { scheduleId: schedule.id }, idempotencyKey: `manual-run-${stamp}-7`, createdBy: "test",
});
const out7 = (await handler({ task: await loadTask(t7.taskId), ...makeStepRecorder().input })) as Record<string, unknown>;
check("disabled schedule: skipped", (out7 as Record<string, unknown>).skipped === true);

// ---------- 7. missing topic (no schedule) → handler throws ----------
const t8 = await spawnTask({
  businessUnitId: buId, kind: "research_run",
  payload: {}, idempotencyKey: `manual-run-${stamp}-8`, createdBy: "test",
});
let threw = false;
try {
  await handler({ task: await loadTask(t8.taskId), ...makeStepRecorder().input });
} catch {
  threw = true;
}
check("missing topic: handler throws (engine retries → failed)", threw);

// restore flag
await flag(flagBefore);

console.log(failures === 0 ? "research-tasks: ALL PASS" : `research-tasks: ${failures} FAILURE(S)`);

// cleanup
await query(`DELETE FROM notifications WHERE event_id IN (SELECT id FROM events WHERE business_unit_id = $1)`, [buId]).catch(() => undefined);
await query(`DELETE FROM events WHERE business_unit_id = $1`, [buId]).catch(() => undefined);
await query(`DELETE FROM research_items WHERE business_unit_id = $1`, [buId]).catch(() => undefined);
await query(`DELETE FROM tasks WHERE business_unit_id = $1 AND kind IN ('research_run','send_notification')`, [buId]).catch(() => undefined);
await query(`DELETE FROM research_schedules WHERE business_unit_id = $1`, [buId]).catch(() => undefined);
await query(`DELETE FROM competitors WHERE business_unit_id = $1`, [buId]).catch(() => undefined);
await query(`DELETE FROM business_units WHERE id = $1`, [buId]).catch(() => undefined);
process.exit(failures === 0 ? 0 : 1);
