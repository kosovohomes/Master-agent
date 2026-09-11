/**
 * Rate limiting (Phase 1 M0 — SEC-C2/C3, Phase 0.5 §4.1).
 *
 * Two layers:
 *  1. Fixed-window per-key buckets (in-memory) for per-IP abuse control on
 *     security-sensitive endpoints (login, channels, agents/run, chat).
 *  2. Persistent per-tenant daily LLM-call counters (tenant_usage_daily,
 *     migration 006) implementing the Phase 0.5 "crude per-tenant daily cap"
 *     until the AI Gateway introduces real budgets (Phase 4).
 *
 * Deliberate limitation (documented in PHASE-1-IMPLEMENTATION-REPORT.md):
 * the in-memory buckets are per serverless instance. They bound per-instance
 * abuse and satisfy the Phase 1 acceptance criteria; a shared-visibility
 * limiter (DB-backed) arrives with the Phase 3 job engine. Daily counters
 * are DB-backed from day one, so the cost-control layer is already global.
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

interface Bucket {
  count: number;
  windowStart: number;
}

const buckets = new Map<string, Bucket>();

export function rateLimit(key: string, limit: number, windowMs: number): RateLimitResult {
  const now = Date.now();
  const b = buckets.get(key);
  if (!b || now - b.windowStart >= windowMs) {
    buckets.set(key, { count: 1, windowStart: now });
    return { allowed: true, limit, remaining: limit - 1, resetAt: now + windowMs, retryAfterSec: Math.ceil(windowMs / 1000) };
  }
  b.count += 1;
  const resetAt = b.windowStart + windowMs;
  return {
    allowed: b.count <= limit,
    limit,
    remaining: Math.max(0, limit - b.count),
    resetAt,
    retryAfterSec: Math.max(1, Math.ceil((resetAt - now) / 1000)),
  };
}

/** Test/ops hook: drop all in-memory buckets. */
export function resetRateLimits(): void {
  buckets.clear();
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
