/**
 * Spend budgets as first-class objects (Phase 4, SEC-L9 — §26).
 *
 * One `budgets` table, two scope types (business_unit | agent), two periods
 * (daily | monthly). The ledger (llm_requests.cost_usd) is the source of
 * truth for spend; budgets are evaluated pre-call (hard-stop) and
 * re-checked post-call (so the NEXT call is blocked and ops is paged via
 * the event bus, which fans out a notification through the task queue).
 *
 * Per-task ceilings ride tasks.budget_usd (set at spawn time by the engine
 * or API): a task whose lifetime LLM spend crosses its ceiling is stopped.
 */
import { query } from "../db";
import { spendSince } from "./usage";
import { BudgetExceededError, type GatewayAttribution } from "./types";

export type BudgetScopeType = "business_unit" | "agent";
export type BudgetPeriod = "daily" | "monthly";

export interface Budget {
  id: number;
  scopeType: BudgetScopeType;
  scopeId: number;
  scopeLabel: string | null;
  period: BudgetPeriod;
  limitUsd: number;
  enabled: boolean;
  createdAt: string;
  updatedAt: string;
}

function periodStart(period: BudgetPeriod): Date {
  const now = new Date();
  if (period === "daily") return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
}

export async function listBudgets(): Promise<Budget[]> {
  const rows = await query<{
    id: number;
    scope_type: string;
    scope_id: number;
    scope_label: string | null;
    period: string;
    limit_usd: string;
    enabled: boolean;
    created_at: string;
    updated_at: string;
  }>(
    `SELECT b.id, b.scope_type, b.scope_id, b.period, b.limit_usd, b.enabled,
            b.created_at, b.updated_at,
            CASE b.scope_type
              WHEN 'agent' THEN (SELECT a.slug FROM agents a WHERE a.id = b.scope_id)
              ELSE (SELECT bu.name FROM business_units bu WHERE bu.id = b.scope_id)
            END AS scope_label
     FROM budgets b ORDER BY b.scope_type, b.scope_id, b.period`
  );
  return rows.map((r) => ({
    id: r.id,
    scopeType: r.scope_type as BudgetScopeType,
    scopeId: r.scope_id,
    scopeLabel: r.scope_label,
    period: r.period as BudgetPeriod,
    limitUsd: Number(r.limit_usd),
    enabled: r.enabled,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  }));
}

export async function upsertBudget(p: {
  scopeType: BudgetScopeType;
  scopeId: number;
  period: BudgetPeriod;
  limitUsd: number;
  enabled?: boolean;
  createdByUserId?: number | null;
}): Promise<Budget> {
  if (!(p.scopeType === "business_unit" || p.scopeType === "agent")) throw new Error("invalid scope_type");
  if (!(p.period === "daily" || p.period === "monthly")) throw new Error("invalid period");
  if (!(p.limitUsd >= 0) || !Number.isFinite(p.limitUsd)) throw new Error("invalid limit_usd");
  const rows = await query<{ id: number }>(
    `INSERT INTO budgets (scope_type, scope_id, period, limit_usd, enabled, created_by_user_id)
     VALUES ($1,$2,$3,$4,$5,$6)
     ON CONFLICT (scope_type, scope_id, period)
     DO UPDATE SET limit_usd = EXCLUDED.limit_usd, enabled = EXCLUDED.enabled, updated_at = now()
     RETURNING id`,
    [p.scopeType, p.scopeId, p.period, p.limitUsd, p.enabled ?? true, p.createdByUserId ?? null]
  );
  const all = await listBudgets();
  const found = all.find((b) => b.id === rows[0].id);
  if (!found) throw new Error("budget upsert failed");
  return found;
}

export async function setBudgetEnabled(id: number, enabled: boolean): Promise<Budget | null> {
  await query("UPDATE budgets SET enabled = $2, updated_at = now() WHERE id = $1", [id, enabled]);
  return (await listBudgets()).find((b) => b.id === id) ?? null;
}

export async function deleteBudget(id: number): Promise<boolean> {
  const rows = await query<{ id: number }>("DELETE FROM budgets WHERE id = $1 RETURNING id", [id]);
  return rows.length > 0;
}

/** Active budgets for the scopes present in an attribution, if any. */
async function activeBudgetsFor(attr: GatewayAttribution): Promise<Array<{ id: number; scopeType: BudgetScopeType; scopeId: number; period: BudgetPeriod; limitUsd: number }>> {
  const scopes: Array<[BudgetScopeType, number]> = [];
  if (attr.businessUnitId != null) scopes.push(["business_unit", attr.businessUnitId]);
  if (attr.agentId != null) scopes.push(["agent", attr.agentId]);
  if (scopes.length === 0) return [];
  const rows = await query<{
    id: number;
    scope_type: string;
    scope_id: number;
    period: string;
    limit_usd: string;
  }>(
    `SELECT id, scope_type, scope_id, period, limit_usd FROM budgets
     WHERE enabled = TRUE
       AND (scope_type = 'business_unit' AND scope_id = ANY($1::bigint[]))
        OR (scope_type = 'agent' AND scope_id = ANY($2::bigint[]))`,
    [
      scopes.filter(([t]) => t === "business_unit").map(([, id]) => id),
      scopes.filter(([t]) => t === "agent").map(([, id]) => id),
    ]
  );
  return rows.map((r) => ({
    id: r.id,
    scopeType: r.scope_type as BudgetScopeType,
    scopeId: r.scope_id,
    period: r.period as BudgetPeriod,
    limitUsd: Number(r.limit_usd),
  }));
}

/**
 * Pre-call hard-stop (SEC-L9). Throws BudgetExceededError on the FIRST
 * scope/period already at or over its limit. Spend includes every ledgered
 * row in the window — blocked rows cost 0, so they never inflate spend.
 */
export async function checkBudgets(attr: GatewayAttribution): Promise<void> {
  const budgets = await activeBudgetsFor(attr);
  for (const b of budgets) {
    const since = periodStart(b.period);
    const spent = await spendSince(
      b.scopeType === "business_unit" ? { businessUnitId: b.scopeId } : { agentId: b.scopeId },
      since
    );
    if (spent >= b.limitUsd) {
      throw new BudgetExceededError({
        scopeType: b.scopeType,
        scopeId: b.scopeId,
        period: b.period,
        spentUsd: spent,
        limitUsd: b.limitUsd,
      });
    }
  }
  // Per-task lifetime ceiling (engine-provided, tasks.budget_usd).
  if (attr.taskId != null) {
    const rows = await query<{ budget_usd: string | null }>(
      "SELECT budget_usd FROM tasks WHERE id = $1 AND budget_usd IS NOT NULL",
      [attr.taskId]
    );
    if (rows.length > 0) {
      const limit = Number(rows[0].budget_usd);
      const spent = await spendSince({ taskId: attr.taskId });
      if (spent >= limit) {
        throw new BudgetExceededError({
          scopeType: "task",
          scopeId: attr.taskId,
          period: "lifetime",
          spentUsd: spent,
          limitUsd: limit,
        });
      }
    }
  }
}

/** Post-call check: did THIS call push a scope over its budget? */
export async function firstOverBudgetAfterCall(
  attr: GatewayAttribution
): Promise<{ scopeType: BudgetScopeType | "task"; scopeId: number; period: string; spentUsd: number; limitUsd: number } | null> {
  const budgets = await activeBudgetsFor(attr);
  for (const b of budgets) {
    const since = periodStart(b.period);
    const spent = await spendSince(
      b.scopeType === "business_unit" ? { businessUnitId: b.scopeId } : { agentId: b.scopeId },
      since
    );
    if (spent >= b.limitUsd) {
      return { scopeType: b.scopeType, scopeId: b.scopeId, period: b.period, spentUsd: spent, limitUsd: b.limitUsd };
    }
  }
  return null;
}

/**
 * Cooldown for hard-stop events: at most one budget.hard_stop event per
 * scope per 10 minutes, so a hot loop of blocked calls cannot flood the
 * event bus (same loop-guard spirit as the event fanout).
 */
export async function hardStopEventOnCooldown(scopeKey: string): Promise<boolean> {
  const rows = await query<{ id: number }>(
    `SELECT id FROM events
     WHERE name = 'budget.hard_stop' AND payload->>'scope' = $1
       AND created_at > now() - interval '10 minutes'
     LIMIT 1`,
    [scopeKey]
  );
  return rows.length > 0;
}
