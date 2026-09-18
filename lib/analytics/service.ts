/**
 * Phase 13 — analytics service: the ONLY writer of reports /
 * strategy_recommendations / report_schedules rows.
 *
 * Storage contracts:
 *  - Report dedup is the DB: UNIQUE (COALESCE(bu,0), period_kind,
 *    period_key) + ON CONFLICT DO NOTHING. A duplicate digest run is a
 *    counted no-op returning the existing row, never an error.
 *  - The §99 privacy law is ENFORCED HERE, at the read model: every
 *    list/get takes the caller's BuScope; a scope-limited caller never
 *    sees platform (bu NULL) reports or another BU's rows. Platform
 *    reports exist ONLY for {kind:"all"} scopes.
 *  - Recommendation dedup: UNIQUE (COALESCE(bu,0), dedup_hash) — the same
 *    advice is never stored twice no matter how many reports re-derive it.
 *  - Recommendation FSM: open → accepted|dismissed, both terminal, review
 *    stamp immutable (row-locked transition, sales FSM pattern).
 *  - Schedules spawn period-idempotent report_run tasks
 *    (report_run:<schedule>:<periodKey>) — a duplicate cron tick never
 *    double-spawns.
 */
import { query, transaction } from "../db";
import { spawnTask } from "../tasks/queue";
import { periodBounds, periodKeyFor } from "./metrics";
import { AnalyticsServiceError, RECOMMENDATION_TERMINAL } from "./types";
import type {
  RecommendationKind,
  RecommendationPriority,
  RecommendationRecord,
  RecommendationStatus,
  ReportCadence,
  ReportPeriodKind,
  ReportRecord,
  ReportScheduleRecord,
  ReportStatus,
} from "./types";

/* ------------------------------------------------------------------ */
/* Scope type (§99)                                                    */
/* ------------------------------------------------------------------ */

export interface AnalyticsScope {
  kind: "all" | "list";
  businessUnitIds: number[];
}

function scopeFilter(
  scope: AnalyticsScope,
  col: string
): { clause: string; params: unknown[] } {
  if (scope.kind === "all") return { clause: "TRUE", params: [] };
  // Scope-limited: ONLY own-BU rows. Platform (bu NULL) rows are invisible.
  if (scope.businessUnitIds.length === 0) return { clause: "FALSE", params: [] };
  return {
    clause: `${col} = ANY($SCOPED::int[])`,
    params: [scope.businessUnitIds],
  };
}

/* ------------------------------------------------------------------ */
/* Row mappers                                                         */
/* ------------------------------------------------------------------ */

interface ReportRow {
  id: number | string; business_unit_id: number | null; period_kind: string; period_key: string;
  status: string; title: string; summary: string | null; payload: Record<string, unknown> | string;
  narrative: Record<string, unknown> | string | null; generated_by: string | null; degraded: boolean;
  task_id: number | null; prompt_version: number | null; prompt_hash: string | null;
  created_by_user_id: number | null; metadata: Record<string, unknown> | string;
  created_at: string; updated_at: string;
}

function toReport(r: ReportRow): ReportRecord {
  return {
    id: Number(r.id),
    businessUnitId: r.business_unit_id,
    periodKind: r.period_kind as ReportPeriodKind,
    periodKey: r.period_key,
    status: r.status as ReportStatus,
    title: r.title,
    summary: r.summary,
    payload: typeof r.payload === "string" ? JSON.parse(r.payload) : r.payload ?? {},
    narrative: r.narrative == null ? null : typeof r.narrative === "string" ? JSON.parse(r.narrative) : r.narrative,
    generatedBy: r.generated_by as ReportRecord["generatedBy"],
    degraded: r.degraded,
    taskId: r.task_id,
    promptVersion: r.prompt_version,
    promptHash: r.prompt_hash,
    createdByUserId: r.created_by_user_id,
    metadata: typeof r.metadata === "string" ? JSON.parse(r.metadata) : r.metadata ?? {},
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

interface RecRow {
  id: number | string; business_unit_id: number | null; source: string; report_id: number | null;
  kind: string; priority: string; title: string; detail: string; evidence: string[] | string;
  status: string; dedup_hash: string; agent_slug: string; task_id: number | null;
  prompt_version: number | null; prompt_hash: string | null; reviewed_by: string | null;
  reviewed_at: string | null; created_by_user_id: number | null;
  metadata: Record<string, unknown> | string; created_at: string; updated_at: string;
}

function toRecommendation(r: RecRow): RecommendationRecord {
  return {
    id: Number(r.id),
    businessUnitId: r.business_unit_id,
    source: r.source as RecommendationRecord["source"],
    reportId: r.report_id,
    kind: r.kind as RecommendationKind,
    priority: r.priority as RecommendationPriority,
    title: r.title,
    detail: r.detail,
    evidence: typeof r.evidence === "string" ? JSON.parse(r.evidence) : r.evidence ?? [],
    status: r.status as RecommendationStatus,
    dedupHash: r.dedup_hash,
    agentSlug: r.agent_slug,
    taskId: r.task_id,
    promptVersion: r.prompt_version,
    promptHash: r.prompt_hash,
    reviewedBy: r.reviewed_by,
    reviewedAt: r.reviewed_at,
    createdByUserId: r.created_by_user_id,
    metadata: typeof r.metadata === "string" ? JSON.parse(r.metadata) : r.metadata ?? {},
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

function toSchedule(r: Record<string, unknown>): ReportScheduleRecord {
  return {
    id: Number(r.id),
    businessUnitId: (r.business_unit_id as number | null) ?? null,
    cadence: r.cadence as ReportCadence,
    enabled: Boolean(r.enabled),
    lastRunAt: (r.last_run_at as string | null) ?? null,
    createdAt: r.created_at as string,
    updatedAt: r.updated_at as string,
  };
}

/* ------------------------------------------------------------------ */
/* Reports                                                             */
/* ------------------------------------------------------------------ */

export interface CreateReportResult {
  report: ReportRecord;
  created: boolean;
}

export async function createReport(p: {
  businessUnitId: number | null;
  periodKind: ReportPeriodKind;
  periodKey: string;
  title: string;
  createdByUserId?: number | null;
  taskId?: number | null;
  metadata?: Record<string, unknown>;
}): Promise<CreateReportResult> {
  if (p.title.trim() === "") {
    throw new AnalyticsServiceError("INVALID_TITLE", 400, "report title must not be empty");
  }
  const rows = await query<ReportRow>(
    `INSERT INTO reports (business_unit_id, period_kind, period_key, title, created_by_user_id, task_id, metadata)
     VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb)
     ON CONFLICT (COALESCE(business_unit_id, 0), period_kind, period_key) DO NOTHING
     RETURNING *`,
    [p.businessUnitId, p.periodKind, p.periodKey, p.title.trim(), p.createdByUserId ?? null, p.taskId ?? null,
     JSON.stringify(p.metadata ?? {})]
  );
  if (rows.length > 0) return { report: toReport(rows[0]), created: true };
  const existing = await query<ReportRow>(
    `SELECT * FROM reports WHERE COALESCE(business_unit_id, 0) = COALESCE($1, 0)
       AND period_kind = $2 AND period_key = $3`,
    [p.businessUnitId, p.periodKind, p.periodKey]
  );
  if (existing.length === 0) {
    throw new AnalyticsServiceError("REPORT_CREATE_FAILED", 500, "report insert deduplicated but existing row vanished");
  }
  return { report: toReport(existing[0]), created: false };
}

export async function getReport(id: number): Promise<ReportRecord | null> {
  const rows = await query<ReportRow>("SELECT * FROM reports WHERE id = $1", [id]);
  return rows.length > 0 ? toReport(rows[0]) : null;
}

/** §99-aware read: scope-limited callers cannot see platform reports. */
export async function getReportForScope(id: number, scope: AnalyticsScope): Promise<ReportRecord | null> {
  const report = await getReport(id);
  if (!report) return null;
  if (scope.kind === "all") return report;
  if (report.businessUnitId == null) return null;
  if (!scope.businessUnitIds.includes(report.businessUnitId)) return null;
  return report;
}

export async function listReports(
  scope: AnalyticsScope,
  limit = 20
): Promise<ReportRecord[]> {
  const lim = Math.max(1, Math.min(100, limit));
  // §99: scope-limited callers see ONLY their own BUs — never platform rows.
  if (scope.kind === "list") {
    if (scope.businessUnitIds.length === 0) return [];
    const rows = await query<ReportRow>(
      `SELECT * FROM reports WHERE business_unit_id = ANY($1::int[])
       ORDER BY created_at DESC, id DESC LIMIT $2`,
      [scope.businessUnitIds, lim]
    );
    return rows.map(toReport);
  }
  const rows = await query<ReportRow>(
    "SELECT * FROM reports ORDER BY created_at DESC, id DESC LIMIT $1",
    [lim]
  );
  return rows.map(toReport);
}

export async function completeReport(
  id: number,
  p: {
    summary: string;
    payload: Record<string, unknown>;
    narrative: Record<string, unknown> | null;
    generatedBy: "deterministic" | "llm";
    degraded: boolean;
    promptVersion: number;
    promptHash: string;
    insights?: unknown[];
  }
): Promise<ReportRecord> {
  const rows = await query<ReportRow>(
    `UPDATE reports SET status = 'ready', summary = $2, payload = $3::jsonb, narrative = $4::jsonb,
       generated_by = $5, degraded = $6, prompt_version = $7, prompt_hash = $8, updated_at = now()
     WHERE id = $1 RETURNING *`,
    [id, p.summary, JSON.stringify(p.payload), p.narrative ? JSON.stringify(p.narrative) : null,
     p.generatedBy, p.degraded, p.promptVersion, p.promptHash]
  );
  if (rows.length === 0) throw new AnalyticsServiceError("NOT_FOUND", 404, `report ${id} not found`);
  return toReport(rows[0]);
}

export async function failReport(id: number, error: string): Promise<void> {
  await query(
    "UPDATE reports SET status = 'failed', metadata = metadata || $2::jsonb, updated_at = now() WHERE id = $1",
    [id, JSON.stringify({ error: String(error).slice(0, 500) })]
  );
}

/* ------------------------------------------------------------------ */
/* Strategy recommendations                                            */
/* ------------------------------------------------------------------ */

export interface UpsertRecommendationResult {
  recommendation: RecommendationRecord;
  created: boolean;
}

export async function upsertRecommendation(p: {
  businessUnitId: number | null;
  source: "report" | "analytics" | "strategy" | "manual";
  reportId?: number | null;
  kind: RecommendationKind;
  priority: RecommendationPriority;
  title: string;
  detail: string;
  evidence: string[];
  dedupHash: string;
  agentSlug?: string;
  taskId?: number | null;
  promptVersion?: number | null;
  promptHash?: string | null;
  createdByUserId?: number | null;
  metadata?: Record<string, unknown>;
}): Promise<UpsertRecommendationResult> {
  if (p.title.trim() === "" || p.detail.trim() === "") {
    throw new AnalyticsServiceError("INVALID_RECOMMENDATION", 400, "recommendation title and detail must not be empty");
  }
  const rows = await query<RecRow>(
    `INSERT INTO strategy_recommendations
       (business_unit_id, source, report_id, kind, priority, title, detail, evidence,
        dedup_hash, agent_slug, task_id, prompt_version, prompt_hash, created_by_user_id, metadata)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb, $9, $10, $11, $12, $13, $14, $15::jsonb)
     ON CONFLICT (COALESCE(business_unit_id, 0), dedup_hash) DO NOTHING
     RETURNING *`,
    [p.businessUnitId, p.source, p.reportId ?? null, p.kind, p.priority, p.title.trim(), p.detail.trim(),
     JSON.stringify(p.evidence.slice(0, 8)), p.dedupHash, p.agentSlug ?? "strategy", p.taskId ?? null,
     p.promptVersion ?? null, p.promptHash ?? null, p.createdByUserId ?? null, JSON.stringify(p.metadata ?? {})]
  );
  if (rows.length > 0) return { recommendation: toRecommendation(rows[0]), created: true };
  const existing = await query<RecRow>(
    `SELECT * FROM strategy_recommendations WHERE COALESCE(business_unit_id, 0) = COALESCE($1, 0) AND dedup_hash = $2`,
    [p.businessUnitId, p.dedupHash]
  );
  if (existing.length === 0) {
    throw new AnalyticsServiceError("REC_UPSERT_FAILED", 500, "recommendation deduplicated but existing row vanished");
  }
  return { recommendation: toRecommendation(existing[0]), created: false };
}

export async function getRecommendation(id: number): Promise<RecommendationRecord | null> {
  const rows = await query<RecRow>("SELECT * FROM strategy_recommendations WHERE id = $1", [id]);
  return rows.length > 0 ? toRecommendation(rows[0]) : null;
}

/** §99-aware read, same law as reports. */
export async function getRecommendationForScope(id: number, scope: AnalyticsScope): Promise<RecommendationRecord | null> {
  const rec = await getRecommendation(id);
  if (!rec) return null;
  if (scope.kind === "all") return rec;
  if (rec.businessUnitId == null) return null;
  if (!scope.businessUnitIds.includes(rec.businessUnitId)) return null;
  return rec;
}

export async function listRecommendations(
  scope: AnalyticsScope,
  opts: { status?: RecommendationStatus; limit?: number } = {}
): Promise<RecommendationRecord[]> {
  const lim = Math.max(1, Math.min(100, opts.limit ?? 25));
  const statusClause = opts.status ? " AND status = $2" : "";
  const limitIdx = opts.status ? 3 : 2;
  // §99: scope-limited callers see ONLY their own BUs — never platform rows.
  if (scope.kind === "list") {
    if (scope.businessUnitIds.length === 0) return [];
    const rows = await query<RecRow>(
      `SELECT * FROM strategy_recommendations WHERE business_unit_id = ANY($1::int[])${statusClause}
       ORDER BY CASE priority WHEN 'high' THEN 0 WHEN 'medium' THEN 1 ELSE 2 END, created_at DESC
       LIMIT $${limitIdx}`,
      [scope.businessUnitIds, ...(opts.status ? [opts.status] : []), lim]
    );
    return rows.map(toRecommendation);
  }
  const rows = await query<RecRow>(
    `SELECT * FROM strategy_recommendations WHERE TRUE${statusClause}
     ORDER BY CASE priority WHEN 'high' THEN 0 WHEN 'medium' THEN 1 ELSE 2 END, created_at DESC
     LIMIT $1`,
    opts.status ? [lim, opts.status] : [lim]
  );
  return rows.map(toRecommendation);
}

const REC_ACTIONS: Record<string, RecommendationStatus> = {
  accept: "accepted",
  dismiss: "dismissed",
};

/**
 * Row-locked FSM transition (sales pattern): open → accepted|dismissed;
 * terminal states refuse (409); the review stamp is immutable — first
 * transition wins, forever.
 */
export async function transitionRecommendation(
  id: number,
  action: "accept" | "dismiss",
  reviewedBy: string
): Promise<RecommendationRecord> {
  const target = REC_ACTIONS[action];
  if (!target) throw new AnalyticsServiceError("INVALID_ACTION", 400, `unknown recommendation action: ${action}`);

  return transaction(async (q) => {
    const locked = await q<RecRow>(
      "SELECT * FROM strategy_recommendations WHERE id = $1 FOR UPDATE",
      [id]
    );
    if (locked.length === 0) {
      throw new AnalyticsServiceError("NOT_FOUND", 404, `recommendation ${id} not found`);
    }
    const current = locked[0].status as RecommendationStatus;
    if (RECOMMENDATION_TERMINAL.includes(current)) {
      throw new AnalyticsServiceError(
        "BAD_STATE", 409, `recommendation ${id} is ${current} (terminal); no further transitions`
      );
    }
    if (current !== "open") {
      throw new AnalyticsServiceError("BAD_STATE", 409, `recommendation ${id} is ${current}; transition requires open`);
    }
    const updated = await q<RecRow>(
      `UPDATE strategy_recommendations SET status = $2, reviewed_by = $3, reviewed_at = now(), updated_at = now()
       WHERE id = $1 RETURNING *`,
      [id, target, reviewedBy]
    );
    return toRecommendation(updated[0]);
  });
}

/* ------------------------------------------------------------------ */
/* Schedules + due-run spawning                                        */
/* ------------------------------------------------------------------ */

export async function listSchedules(scope: AnalyticsScope): Promise<ReportScheduleRecord[]> {
  if (scope.kind === "all") {
    const rows = await query<Record<string, unknown>>(
      "SELECT * FROM report_schedules ORDER BY id"
    );
    return rows.map(toSchedule);
  }
  if (scope.businessUnitIds.length === 0) return [];
  const rows = await query<Record<string, unknown>>(
    "SELECT * FROM report_schedules WHERE business_unit_id = ANY($1::int[]) ORDER BY id",
    [scope.businessUnitIds]
  );
  return rows.map(toSchedule);
}

export interface SpawnDueReportsResult {
  spawned: number;
  taskIds: number[];
  schedules: number;
}

/**
 * Due platform schedules spawn report_run tasks. Due = enabled AND
 * (never run OR last run before the current period started). The
 * idempotency key carries the schedule id + period key, so a retried or
 * concurrent cron tick cannot double-spawn (research_schedules pattern).
 */
export async function spawnDueReportRuns(
  now: Date = new Date()
): Promise<SpawnDueReportsResult> {
  const rows = await query<Record<string, unknown>>(
    `SELECT * FROM report_schedules WHERE enabled ORDER BY id ASC`
  );
  let spawned = 0;
  const taskIds: number[] = [];
  for (const row of rows) {
    const schedule = toSchedule(row);
    const key = periodKeyFor(schedule.cadence, now);
    const bounds = periodBounds(schedule.cadence, key);
    if (schedule.lastRunAt && new Date(schedule.lastRunAt) >= bounds.start) continue; // already ran this period

    const title =
      schedule.businessUnitId == null
        ? `Platform ${schedule.cadence} digest (${key})`
        : `BU #${schedule.businessUnitId} ${schedule.cadence} digest (${key})`;
    const { taskId, created } = await spawnTask({
      businessUnitId: schedule.businessUnitId ?? undefined,
      kind: "report_run",
      payload: {
        scheduleId: schedule.id,
        businessUnitId: schedule.businessUnitId,
        periodKind: schedule.cadence,
        periodKey: key,
        title,
      },
      priority: 40,
      maxAttempts: 3,
      idempotencyKey: `report_run:${schedule.id}:${key}`,
      createdBy: "cron",
    });
    if (created) {
      spawned += 1;
      taskIds.push(taskId);
      await query(
        "UPDATE report_schedules SET last_run_at = $2, updated_at = now() WHERE id = $1",
        [schedule.id, now.toISOString()]
      );
    }
  }
  return { spawned, taskIds, schedules: rows.length };
}

/* ------------------------------------------------------------------ */
/* Screen summary                                                      */
/* ------------------------------------------------------------------ */

export interface AnalyticsSummary {
  reportsReady: number;
  reportsFailed: number;
  recommendationsOpen: number;
  recommendationsAccepted: number;
  schedules: number;
}

export async function analyticsSummary(scope: AnalyticsScope): Promise<AnalyticsSummary> {
  const f = scopeFilter(scope, "business_unit_id");
  const scopedParams = f.params.length > 0 ? [f.params[0]] : [];
  const buPredicate = scope.kind === "all"
    ? "TRUE"
    : scopedParams.length > 0
      ? "business_unit_id = ANY($1::int[])"
      : "FALSE";

  const [reportsReady, reportsFailed, recsOpen, recsAccepted, schedules] = await Promise.all([
    query<{ n: number }>(`SELECT count(*)::int AS n FROM reports WHERE status = 'ready' AND ${buPredicate}`, scopedParams),
    query<{ n: number }>(`SELECT count(*)::int AS n FROM reports WHERE status = 'failed' AND ${buPredicate}`, scopedParams),
    query<{ n: number }>(`SELECT count(*)::int AS n FROM strategy_recommendations WHERE status = 'open' AND ${buPredicate}`, scopedParams),
    query<{ n: number }>(`SELECT count(*)::int AS n FROM strategy_recommendations WHERE status = 'accepted' AND ${buPredicate}`, scopedParams),
    query<{ n: number }>(`SELECT count(*)::int AS n FROM report_schedules WHERE enabled AND ${buPredicate}`, scopedParams),
  ]);
  return {
    reportsReady: Number(reportsReady[0]?.n ?? 0),
    reportsFailed: Number(reportsFailed[0]?.n ?? 0),
    recommendationsOpen: Number(recsOpen[0]?.n ?? 0),
    recommendationsAccepted: Number(recsAccepted[0]?.n ?? 0),
    schedules: Number(schedules[0]?.n ?? 0),
  };
}
