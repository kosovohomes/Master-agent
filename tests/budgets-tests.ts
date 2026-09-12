import { query } from "../lib/db";
import {
  listBudgets,
  upsertBudget,
  setBudgetEnabled,
  deleteBudget,
  checkBudgets,
  firstOverBudgetAfterCall,
  hardStopEventOnCooldown,
} from "../lib/ai/budgets";
import { recordRequest, spendSince } from "../lib/ai/usage";
import { BudgetExceededError } from "../lib/ai/types";
import { spawnTask } from "../lib/tasks/queue";

/**
 * Budgets suite (Phase 4, SEC-L9):
 *  - budgets are first-class objects: upsert (unique scope+period), list,
 *    enable/disable, delete
 *  - period windows: daily/monthly spend reads the ledger within the window
 *  - pre-call hard-stop per scope and per task lifetime ceiling
 *  - post-call over-budget detection + hard-stop event cooldown
 */
let failures = 0;
function check(name: string, cond: boolean, detail = "") {
  console.log(`${cond ? "PASS" : "FAIL"} ${name}${detail ? " :: " + detail : ""}`);
  if (!cond) failures++;
}

const RUN = `bdg${Date.now()}${Math.floor(Math.random() * 1000)}`;
const BU = 9_400_000 + Math.floor(Math.random() * 100_000);
const AGENT = 9_500_000 + Math.floor(Math.random() * 100_000);
const createdBudgetIds: number[] = [];
const createdTaskIds: number[] = [];

async function cleanup() {
  try {
    if (createdBudgetIds.length) await query("DELETE FROM budgets WHERE id = ANY($1)", [createdBudgetIds]);
    await query("DELETE FROM llm_requests WHERE business_unit_id = $1 OR agent_id = $2", [BU, AGENT]);
    if (createdTaskIds.length) await query("DELETE FROM tasks WHERE id = ANY($1)", [createdTaskIds]);
  } catch (e) {
    console.error("cleanup error", e);
  }
}

try {
  // ---------- 1. first-class budget objects ----------
  const b1 = await upsertBudget({ scopeType: "business_unit", scopeId: BU, period: "monthly", limitUsd: 25 });
  createdBudgetIds.push(b1.id);
  const b1again = await upsertBudget({ scopeType: "business_unit", scopeId: BU, period: "monthly", limitUsd: 30 });
  check("upsert is idempotent per scope+period", b1again.id === b1.id && b1again.limitUsd === 30);
  const listed = await listBudgets();
  check("budget listed with limit", listed.some((b) => b.id === b1.id && b.limitUsd === 30 && b.enabled));
  const daily = await upsertBudget({ scopeType: "business_unit", scopeId: BU, period: "daily", limitUsd: 5 });
  createdBudgetIds.push(daily.id);
  check("same scope, different period = separate object", daily.id !== b1.id);

  // ---------- 2. ledger spend + period window ----------
  await recordRequest({
    provider: "openai", kind: "chat", model: "m", status: "ok",
    attribution: { businessUnitId: BU }, costUsd: 7, promptTokens: 1, completionTokens: 1,
  });
  check("spendSince sums ledger cost for the scope", Math.abs((await spendSince({ businessUnitId: BU })) - 7) < 1e-9);
  // Blocked rows cost 0 — they never inflate spend.
  await recordRequest({
    provider: "openai", kind: "chat", model: "pre-call", status: "budget_blocked",
    attribution: { businessUnitId: BU }, costUsd: 0,
  });
  check("blocked rows cost 0 and do not inflate spend", Math.abs((await spendSince({ businessUnitId: BU })) - 7) < 1e-9);

  // ---------- 3. pre-call hard-stop (BU scope, monthly) ----------
  let monthlyBlocked = false;
  try {
    await checkBudgets({ businessUnitId: BU });
  } catch (e) {
    monthlyBlocked = e instanceof BudgetExceededError && e.scopeType === "business_unit" && e.limitUsd === 30 && e.spentUsd >= 7;
  }
  check("monthly budget hard-stops (spend >= limit)", monthlyBlocked);
  // Disable monthly, then the daily limit (5 vs spend 7) is what blocks.
  await setBudgetEnabled(b1.id, false);
  let dailyBlocked = false;
  try {
    await checkBudgets({ businessUnitId: BU, agentId: AGENT });
  } catch (e) {
    dailyBlocked = e instanceof BudgetExceededError && e.period === "daily";
  }
  check("daily budget hard-stops independently", dailyBlocked);
  check("unrelated scope passes", await checkBudgets({ agentId: AGENT }).then(() => true));

  // disable releases the brake
  await setBudgetEnabled(daily.id, false);
  check("disabled budgets do not block", await checkBudgets({ businessUnitId: BU }).then(() => true));

  // ---------- 4. per-task lifetime ceiling (tasks.budget_usd) ----------
  const task = await spawnTask({
    businessUnitId: null,
    kind: "noop_probe",
    payload: { suite: RUN },
    priority: 10,
    maxAttempts: 1,
    idempotencyKey: `bdg-suite:${RUN}`,
    createdBy: "budgets-suite",
  });
  createdTaskIds.push(task.taskId);
  await query("UPDATE tasks SET budget_usd = 1 WHERE id = $1", [task.taskId]);
  await recordRequest({
    provider: "openai", kind: "chat", model: "m", status: "ok",
    attribution: { taskId: task.taskId }, costUsd: 2,
  });
  let taskBlocked = false;
  try {
    await checkBudgets({ taskId: task.taskId });
  } catch (e) {
    taskBlocked = e instanceof BudgetExceededError && e.scopeType === "task" && e.period === "lifetime";
  }
  check("task lifetime ceiling hard-stops runaway tasks", taskBlocked);

  // ---------- 5. post-call detection + event cooldown ----------
  await setBudgetEnabled(b1.id, true); // monthly limit 30, spend 7
  const over = await firstOverBudgetAfterCall({ businessUnitId: BU });
  check("post-call: not over when spend < limit", over === null);
  await query("UPDATE budgets SET limit_usd = 5 WHERE id = $1", [b1.id]);
  const overNow = await firstOverBudgetAfterCall({ businessUnitId: BU });
  check("post-call: detects crossed limit", overNow !== null && overNow.limitUsd === 5);
  const scope = `business_unit#${BU}`;
  check("cooldown false before any event", (await hardStopEventOnCooldown(scope)) === false);
  // (event emission itself is covered by the gateway suite; here we verify
  //  the cooldown predicate flips once an event exists)
  const ins = await query<{ id: number }>(
    `INSERT INTO events (business_unit_id, name, payload) VALUES ($1, 'budget.hard_stop', $2::jsonb) RETURNING id`,
    [BU, JSON.stringify({ scope })]
  );
  check("cooldown true within 10 minutes of an event", (await hardStopEventOnCooldown(scope)) === true);
  await query("DELETE FROM events WHERE id = $1", [ins[0].id]);

  // ---------- 6. delete ----------
  const removed = await deleteBudget(daily.id);
  check("delete removes the budget", removed && !(await listBudgets()).some((b) => b.id === daily.id));
} catch (e) {
  failures++;
  console.error("SUITE ERROR", e);
} finally {
  await cleanup();
}

if (failures > 0) { console.error(`${failures} FAIL`); process.exit(1); }
console.log("BUDGETS SUITE PASS");
