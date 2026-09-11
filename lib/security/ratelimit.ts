/**
 * Rate limiting (Phase 1 M0 — SEC-C2/C3; Phase 2 pull-forward).
 *
 * Two layers:
 *  1. Fixed-window per-key buckets backed by the `rate_limit_buckets` table
 *     (migration 011). One atomic upsert per check: the window resets when
 *     expired, the counter increments otherwise, and the row lock resolves
 *     concurrent-instance races. This is GLOBAL across serverless instances
 *     (the Phase 1 in-memory buckets were per instance — a documented gap
 *     that mattered for login brute-force protection; pulled forward from
 *     Phase 3 as a tech-lead decision). A cheap probabilistic cleanup prunes
 *     stale windows.
 *  2. Persistent per-tenant daily LLM-call counters (tenant_usage_daily,
 *     migration 006) implementing the Phase 0.5 "crude per-tenant daily cap"
 *     until the AI Gateway introduces real budgets (Phase 4).
 *
 * Deliberate limitation (documented in the Phase 2 report): fixed-window
 * buckets allow up to 2x limit across a window boundary; acceptable for
 * abuse control, not a billing control (the daily LLM cap is the billing
 * control and is exact per day).
 */
import { query } from "../db";

export interface RateLimitResult {
  allowed: boolean;
  limit: number;
  remaining: number;
  /** epoch ms when the window resets */
  resetAt: number;
  retryAfterSec: number;
}

interface BucketRow {
  count: number;
  window_start: string | Date;
}

/**
 * DB-backed fixed-window limiter. Falls back to allow-on-error: availability
 * beats strictness for a limiter (an outage must not turn into a global 429
 * storm); abuse protection on auth additionally comes from the account
 * lockout counters on users (Phase 1 M1).
 */
export async function rateLimit(key: string, limit: number, windowMs: number): Promise<RateLimitResult> {
  const windowSec = Math.max(1, Math.round(windowMs / 1000));
  try {
    const rows = await query<BucketRow>(
      `INSERT INTO rate_limit_buckets (key, count, window_start)
       VALUES ($1, 1, now())
       ON CONFLICT (key) DO UPDATE SET
         count = CASE
           WHEN rate_limit_buckets.window_start + make_interval(secs => $2::double precision) < now()
           THEN 1 ELSE rate_limit_buckets.count + 1 END,
         window_start = CASE
           WHEN rate_limit_buckets.window_start + make_interval(secs => $2::double precision) < now()
           THEN now() ELSE rate_limit_buckets.window_start END
       RETURNING count, window_start`,
      [key, windowSec]
    );
    // Opportunistic cleanup of stale windows (~1% of calls) keeps the table
    // tiny without a cron dependency.
    if (Math.random() < 0.01) {
      void query("DELETE FROM rate_limit_buckets WHERE window_start < now() - interval '1 hour'")
        .catch(() => undefined);
    }
    const r = rows[0];
    const count = r?.count ?? 1;
    const start = r?.window_start ? new Date(r.window_start).getTime() : Date.now();
    const resetAt = start + windowMs;
    return {
      allowed: count <= limit,
      limit,
      remaining: Math.max(0, limit - count),
      resetAt,
      retryAfterSec: Math.max(1, Math.ceil((resetAt - Date.now()) / 1000)),
    };
  } catch {
    // Table missing (cold boot before migrations) or transient DB failure.
    return { allowed: true, limit, remaining: limit, resetAt: Date.now() + windowMs, retryAfterSec: Math.ceil(windowMs / 1000) };
  }
}

/** Test/ops hook: clear the bucket table (ephemeral DBs only). */
export async function resetRateLimits(): Promise<void> {
  try {
    await query("DELETE FROM rate_limit_buckets");
  } catch {
    // table may not exist yet in a fresh test DB — nothing to reset
  }
}

/** First client IP from proxy headers (Vercel sets x-forwarded-for). */
export function clientIp(req: Request): string {
  const fwd = req.headers.get("x-forwarded-for");
  if (fwd) {
    const first = fwd.split(",")[0]?.trim();
    if (first) return first;
  }
  return req.headers.get("x-real-ip")?.trim() || "unknown";
}

// ---------- per-tenant daily LLM caps ----------

function dailyCap(): number {
  const n = Number(process.env.DAILY_TENANT_LLM_CAP ?? "");
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : 200;
}

export interface DailyCapResult {
  allowed: boolean;
  used: number;
  cap: number;
}

/**
 * Records one LLM-touching invocation for (day, tenant) and returns whether
 * the tenant remains under the daily cap. The call is counted even when it
 * trips the cap (crude-lossy by design; the Gateway replaces this in Phase 4).
 *
 * Unknown tenants (FK violation) are reported as allowed: the cap protects
 * real tenants; requests referencing nonexistent tenants are rejected by the
 * execution layer's own error handling.
 */
export async function hitDailyLlmCap(tenantId: number): Promise<DailyCapResult> {
  const cap = dailyCap();
  try {
    const rows = await query<{ llm_calls: number }>(
      `INSERT INTO tenant_usage_daily (day, tenant_id, llm_calls, updated_at)
       VALUES (CURRENT_DATE, $1, 1, now())
       ON CONFLICT (day, tenant_id) DO UPDATE
         SET llm_calls = tenant_usage_daily.llm_calls + 1, updated_at = now()
       RETURNING llm_calls`,
      [tenantId]
    );
    const used = rows[0]?.llm_calls ?? 0;
    return { allowed: used <= cap, used, cap };
  } catch {
    return { allowed: true, used: 0, cap };
  }
}

/** Read-only usage check (dashboards). */
export async function dailyLlmUsage(tenantId: number): Promise<{ used: number; cap: number }> {
  const rows = await query<{ llm_calls: number | null }>(
    "SELECT llm_calls FROM tenant_usage_daily WHERE day = CURRENT_DATE AND tenant_id = $1",
    [tenantId]
  );
  return { used: rows[0]?.llm_calls ?? 0, cap: dailyCap() };
}
