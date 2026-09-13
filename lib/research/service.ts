/**
 * Research workforce service (Phase 7) — the ONLY writer of research rows.
 *
 * Storage contracts:
 *  - Dedup is the DB: UNIQUE (business_unit_id, dedup_hash) + ON CONFLICT
 *    DO NOTHING. A duplicate finding is a counted no-op, never an error.
 *  - Status routing: ambiguous / low-confidence → 'escalated' (ops paged
 *    via the event bus); clean findings → 'finding'; LLM unavailable →
 *    'unprocessed' with full material for later re-analysis (§144).
 *  - Competitor events require a registry match on the tracked-competitor
 *    name (case-insensitive) — the pipeline never fabricates competitors.
 *  - Scheduling: due schedules spawn research_run tasks with a per-period
 *    idempotency key (research_run:<schedule>:<period>) — a duplicate cron
 *    tick never double-spawns (same contract as knowledge fetches).
 */
import { query } from "../db";
import {
  emitEvent,
  type EventName,
} from "../tasks/events";
import { spawnTask } from "../tasks/queue";
import { needsEscalation, fingerprint, type PipelinePrompt } from "./pipeline";
import type {
  Competitor,
  CompetitorEvent,
  CompetitorEventDraft,
  ResearchCadence,
  ResearchFinding,
  ResearchItem,
  ResearchItemStatus,
  ResearchSchedule,
  ResearchSource,
} from "./types";

export class ResearchServiceError extends Error {
  code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = "ResearchServiceError";
    this.code = code;
  }
}

/* ------------------------------------------------------------------ */
/* Schedules                                                           */
/* ------------------------------------------------------------------ */

interface ScheduleRow {
  id: string | number; business_unit_id: number; agent_slug: string; name: string;
  topic: string; queries: string[] | null; cadence: string; max_items: number;
  enabled: boolean; last_run_at: string | null; created_at: string; updated_at: string;
}

function toSchedule(r: ScheduleRow): ResearchSchedule {
  return {
    id: Number(r.id), businessUnitId: r.business_unit_id, agentSlug: r.agent_slug as ResearchSchedule["agentSlug"],
    name: r.name, topic: r.topic, queries: r.queries ?? [], cadence: r.cadence as ResearchCadence,
    maxItems: r.max_items, enabled: r.enabled, lastRunAt: r.last_run_at,
    createdAt: r.created_at, updatedAt: r.updated_at,
  };
}

export async function listSchedules(businessUnitId?: number | null): Promise<ResearchSchedule[]> {
  const rows = businessUnitId != null
    ? await query<ScheduleRow>("SELECT * FROM research_schedules WHERE business_unit_id = $1 ORDER BY id", [businessUnitId])
    : await query<ScheduleRow>("SELECT * FROM research_schedules ORDER BY id");
  return rows.map(toSchedule);
}

export async function createSchedule(p: {
  businessUnitId: number;
  agentSlug: string;
  name: string;
  topic: string;
  queries?: string[];
  cadence?: ResearchCadence;
  maxItems?: number;
}): Promise<ResearchSchedule> {
  if (p.topic.trim() === "") throw new ResearchServiceError("INVALID_TOPIC", "topic must not be empty");
  const rows = await query<ScheduleRow>(
    `INSERT INTO research_schedules (business_unit_id, agent_slug, name, topic, queries, cadence, max_items)
     VALUES ($1, $2, $3, $4, $5::jsonb, $6, $7) RETURNING *`,
    [p.businessUnitId, p.agentSlug, p.name.trim(), p.topic.trim(),
     JSON.stringify((p.queries ?? []).filter((q) => q.trim() !== "").slice(0, 4)),
     p.cadence ?? "daily", Math.min(Math.max(p.maxItems ?? 5, 1), 20)]
  ).catch((e: { code?: string }) => {
    if (e.code === "23505") throw new ResearchServiceError("DUPLICATE", "a schedule with this name exists for the BU");
    if (e.code === "23503") throw new ResearchServiceError("NOT_FOUND", "business unit not found");
    throw e;
  });
  return toSchedule(rows[0]);
}

export async function updateSchedule(id: number, patch: {
  enabled?: boolean; cadence?: ResearchCadence; topic?: string; queries?: string[]; maxItems?: number;
}): Promise<ResearchSchedule | null> {
  const rows = await query<ScheduleRow>(
    `UPDATE research_schedules SET
       enabled = COALESCE($2, enabled),
       cadence = COALESCE($3, cadence),
       topic = COALESCE($4, topic),
       queries = COALESCE($5::jsonb, queries),
       max_items = COALESCE($6, max_items),
       updated_at = now()
     WHERE id = $1 RETURNING *`,
    [id, patch.enabled ?? null, patch.cadence ?? null, patch.topic ?? null,
     patch.queries ? JSON.stringify(patch.queries.slice(0, 4)) : null,
     patch.maxItems != null ? Math.min(Math.max(patch.maxItems, 1), 20) : null]
  );
  return rows[0] ? toSchedule(rows[0]) : null;
}

export async function deleteSchedule(id: number): Promise<boolean> {
  const rows = await query("DELETE FROM research_schedules WHERE id = $1 RETURNING id", [id]);
  return rows.length > 0;
}

/** Which schedules are due right now (cadence math vs last_run_at). */
export async function dueSchedules(now = new Date()): Promise<ResearchSchedule[]> {
  const rows = await query<ScheduleRow>(
    `SELECT * FROM research_schedules
     WHERE enabled = true
       AND (
         (cadence = 'hourly' AND (last_run_at IS NULL OR last_run_at < now() - interval '1 hour'))
         OR (cadence = 'daily'  AND (last_run_at IS NULL OR last_run_at < now() - interval '1 day'))
         OR (cadence = 'weekly' AND (last_run_at IS NULL OR last_run_at < now() - interval '7 days'))
       )`
  );
  void now;
  return rows.map(toSchedule);
}

/** Spawn research_run tasks for every due schedule; idempotent per period. */
export async function spawnDueResearchRuns(periodKey = periodKeyFor(new Date())): Promise<{ due: number; spawned: number; taskIds: number[] }> {
  const due = await dueSchedules();
  const taskIds: number[] = [];
  for (const s of due) {
    const { created, taskId } = await spawnTask({
      businessUnitId: s.businessUnitId,
      kind: "research_run",
      payload: { scheduleId: s.id, agentSlug: s.agentSlug, topic: s.topic, queries: s.queries, maxItems: s.maxItems },
      priority: 40,
      maxAttempts: 3,
      idempotencyKey: `research_run:${s.id}:${periodKey}`,
      createdBy: "cron",
    });
    if (created) {
      taskIds.push(taskId);
      await query("UPDATE research_schedules SET last_run_at = now(), updated_at = now() WHERE id = $1", [s.id]);
    }
  }
  return { due: due.length, spawned: taskIds.length, taskIds };
}

/** hourly → 2026-09-13T15Z; daily/weekly → 2026-09-13. */
export function periodKeyFor(now: Date, cadence: ResearchCadence = "daily"): string {
  const iso = now.toISOString();
  return cadence === "hourly" ? `${iso.slice(0, 13)}Z` : iso.slice(0, 10);
}

/** Stamp the run on a schedule (called by the research_run handler post-store). */
export async function updateScheduleLastRun(scheduleId: number): Promise<void> {
  await query("UPDATE research_schedules SET last_run_at = now(), updated_at = now() WHERE id = $1", [scheduleId]);
}

/* ------------------------------------------------------------------ */
/* Items                                                               */
/* ------------------------------------------------------------------ */

interface ItemRow {
  id: string | number; business_unit_id: number; schedule_id: string | number | null;
  agent_slug: string; topic: string; query: string | null; status: string;
  title: string | null; summary: string | null; analysis: Record<string, unknown> | null;
  score: number | null; confidence: string | number | null; sources: ResearchSource[] | null;
  material: string | null; prompt_version: number | null; prompt_hash: string | null;
  task_id: string | number | null; created_at: string; updated_at: string;
  reviewed_at: string | null; reviewed_by: string | null;
}

function toItem(r: ItemRow): ResearchItem {
  return {
    id: Number(r.id), businessUnitId: r.business_unit_id,
    scheduleId: r.schedule_id != null ? Number(r.schedule_id) : null,
    agentSlug: r.agent_slug, topic: r.topic, query: r.query,
    status: r.status as ResearchItemStatus, title: r.title, summary: r.summary,
    analysis: r.analysis, score: r.score,
    confidence: r.confidence != null ? Number(r.confidence) : null,
    sources: r.sources ?? [], material: r.material,
    promptVersion: r.prompt_version, promptHash: r.prompt_hash,
    taskId: r.task_id != null ? Number(r.task_id) : null,
    createdAt: r.created_at, updatedAt: r.updated_at,
    reviewedAt: r.reviewed_at, reviewedBy: r.reviewed_by,
  };
}

export async function listItems(opts: { businessUnitId?: number | null; status?: ResearchItemStatus | null; limit?: number } = {}): Promise<ResearchItem[]> {
  const limit = Math.min(opts.limit ?? 50, 200);
  const rows = await query<ItemRow>(
    `SELECT * FROM research_items
     WHERE ($1::bigint IS NULL OR business_unit_id = $1)
       AND ($2::text IS NULL OR status = $2)
     ORDER BY created_at DESC LIMIT $3`,
    [opts.businessUnitId ?? null, opts.status ?? null, limit]
  );
  return rows.map(toItem);
}

export async function getItem(id: number): Promise<ResearchItem | null> {
  const rows = await query<ItemRow>("SELECT * FROM research_items WHERE id = $1", [id]);
  return rows[0] ? toItem(rows[0]) : null;
}

/** Human review transition. Only forward moves out of finding/escalated. */
export async function reviewItem(id: number, action: "verify" | "reject" | "archive" | "escalate", reviewer: string): Promise<ResearchItem | null> {
  const status: ResearchItemStatus = action === "verify" ? "verified" : action === "reject" ? "rejected" : action === "archive" ? "archived" : "escalated";
  const rows = await query<ItemRow>(
    `UPDATE research_items SET status = $2, reviewed_at = now(), reviewed_by = $3, updated_at = now()
     WHERE id = $1 AND status IN ('finding','escalated','unprocessed','verified','rejected','archived')
     RETURNING *`,
    [id, status, reviewer]
  );
  return rows[0] ? toItem(rows[0]) : null;
}

export interface RecordFindingInput {
  businessUnitId: number;
  scheduleId?: number | null;
  agentSlug: string;
  topic: string;
  query: string;
  finding: ResearchFinding;
  sources: ResearchSource[];
  dedupHash: string;
  material: string;
  taskId?: number | null;
  prompt?: PipelinePrompt;
}

export interface RecordResult {
  item: ResearchItem | null;
  duplicate: boolean;
  status: ResearchItemStatus;
  competitorEvents: CompetitorEvent[];
}

const ESCALATION_EVENT: EventName = "research.escalated";
const FINDING_EVENT: EventName = "research.finding";

export async function recordFinding(input: RecordFindingInput): Promise<RecordResult> {
  const escalated = needsEscalation(input.finding);
  const status: ResearchItemStatus = escalated ? "escalated" : "finding";
  const fp = input.prompt ? fingerprint(input.prompt) : { promptVersion: null, promptHash: null };
  const analysis: Record<string, unknown> = {};
  if (input.finding.implications?.length) analysis.implications = input.finding.implications;
  if (input.finding.opportunities?.length) analysis.opportunities = input.finding.opportunities;
  if (input.finding.risks?.length) analysis.risks = input.finding.risks;
  if (input.finding.actions?.length) analysis.actions = input.finding.actions;

  const rows = await query<ItemRow>(
    `INSERT INTO research_items
       (business_unit_id, schedule_id, agent_slug, topic, query, status, title, summary, analysis,
        score, confidence, sources, material, dedup_hash, prompt_version, prompt_hash, task_id)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb,$10,$11,$12::jsonb,$13,$14,$15,$16,$17)
     ON CONFLICT (business_unit_id, dedup_hash) DO NOTHING
     RETURNING *`,
    [input.businessUnitId, input.scheduleId ?? null, input.agentSlug, input.topic, input.query,
     status, input.finding.title.slice(0, 200), input.finding.summary, JSON.stringify(analysis),
     Math.min(Math.max(Math.round(input.finding.score), 0), 100),
     Math.min(Math.max(input.finding.confidence, 0), 1),
     JSON.stringify(input.sources.slice(0, 12)), input.material.slice(0, 60_000),
     input.dedupHash, fp.promptVersion, fp.promptHash, input.taskId ?? null]
  );

  if (rows.length === 0) {
    return { item: null, duplicate: true, status: "finding", competitorEvents: [] };
  }
  const item = toItem(rows[0]);

  const events = await recordCompetitorEvents(input.businessUnitId, item.id, input.finding.competitorEvents ?? []);

  await emitEvent(
    input.businessUnitId,
    escalated ? ESCALATION_EVENT : FINDING_EVENT,
    { itemId: item.id, agentSlug: input.agentSlug, title: item.title, score: item.score, taskId: input.taskId ?? null }
  );
  return { item, duplicate: false, status, competitorEvents: events };
}

export async function recordUnprocessed(input: {
  businessUnitId: number;
  scheduleId?: number | null;
  agentSlug: string;
  topic: string;
  query: string;
  sources: ResearchSource[];
  dedupHash: string;
  material: string;
  taskId?: number | null;
  degradeReason: string;
}): Promise<{ item: ResearchItem | null; duplicate: boolean }> {
  const rows = await query<ItemRow>(
    `INSERT INTO research_items
       (business_unit_id, schedule_id, agent_slug, topic, query, status, title, sources, material, dedup_hash, task_id)
     VALUES ($1,$2,$3,$4,$5,'unprocessed',$6,$7::jsonb,$8,$9,$10)
     ON CONFLICT (business_unit_id, dedup_hash) DO NOTHING
     RETURNING *`,
    [input.businessUnitId, input.scheduleId ?? null, input.agentSlug, input.topic, input.query,
     `(unprocessed — LLM unavailable: ${input.degradeReason})`.slice(0, 200),
     JSON.stringify(input.sources.slice(0, 12)), input.material.slice(0, 60_000),
     input.dedupHash, input.taskId ?? null]
  );
  return { item: rows[0] ? toItem(rows[0]) : null, duplicate: rows.length === 0 };
}

/* ------------------------------------------------------------------ */
/* Competitors                                                         */
/* ------------------------------------------------------------------ */

export async function listCompetitors(businessUnitId?: number | null): Promise<Competitor[]> {
  const rows = businessUnitId != null
    ? await query<{ id: string | number; business_unit_id: number; name: string; url: string | null; notes: string | null; enabled: boolean; created_at: string; updated_at: string }>(
        "SELECT * FROM competitors WHERE business_unit_id = $1 ORDER BY name", [businessUnitId])
    : await query<{ id: string | number; business_unit_id: number; name: string; url: string | null; notes: string | null; enabled: boolean; created_at: string; updated_at: string }>(
        "SELECT * FROM competitors ORDER BY business_unit_id, name");
  return rows.map((r) => ({
    id: Number(r.id), businessUnitId: r.business_unit_id, name: r.name, url: r.url,
    notes: r.notes, enabled: r.enabled, createdAt: r.created_at, updatedAt: r.updated_at,
  }));
}

export async function createCompetitor(p: { businessUnitId: number; name: string; url?: string | null; notes?: string | null }): Promise<Competitor> {
  if (p.name.trim() === "") throw new ResearchServiceError("INVALID_NAME", "name must not be empty");
  // Case-insensitive uniqueness within a BU (the DB UNIQUE is byte-exact;
  // "acme ai" must collide with "Acme AI" at the service layer).
  const clash = await query<{ id: string | number }>(
    "SELECT id FROM competitors WHERE business_unit_id = $1 AND lower(name) = lower($2) LIMIT 1",
    [p.businessUnitId, p.name.trim()]
  );
  if (clash.length > 0) throw new ResearchServiceError("DUPLICATE", "competitor already tracked for this BU");
  const rows = await query<{ id: string | number; business_unit_id: number; name: string; url: string | null; notes: string | null; enabled: boolean; created_at: string; updated_at: string }>(
    `INSERT INTO competitors (business_unit_id, name, url, notes) VALUES ($1,$2,$3,$4) RETURNING *`,
    [p.businessUnitId, p.name.trim(), p.url ?? null, p.notes ?? null]
  ).catch((e: { code?: string }) => {
    if (e.code === "23505") throw new ResearchServiceError("DUPLICATE", "competitor already tracked for this BU");
    if (e.code === "23503") throw new ResearchServiceError("NOT_FOUND", "business unit not found");
    throw e;
  });
  const r = rows[0];
  return { id: Number(r.id), businessUnitId: r.business_unit_id, name: r.name, url: r.url, notes: r.notes, enabled: r.enabled, createdAt: r.created_at, updatedAt: r.updated_at };
}

export async function updateCompetitor(id: number, patch: { enabled?: boolean; url?: string | null; notes?: string | null }): Promise<Competitor | null> {
  const rows = await query<{ id: string | number; business_unit_id: number; name: string; url: string | null; notes: string | null; enabled: boolean; created_at: string; updated_at: string }>(
    `UPDATE competitors SET
       enabled = COALESCE($2, enabled), url = COALESCE($3, url), notes = COALESCE($4, notes), updated_at = now()
     WHERE id = $1 RETURNING *`,
    [id, patch.enabled ?? null, patch.url ?? null, patch.notes ?? null]
  );
  const r = rows[0];
  if (!r) return null;
  return { id: Number(r.id), businessUnitId: r.business_unit_id, name: r.name, url: r.url, notes: r.notes, enabled: r.enabled, createdAt: r.created_at, updatedAt: r.updated_at };
}

export async function deleteCompetitor(id: number): Promise<boolean> {
  const rows = await query("DELETE FROM competitors WHERE id = $1 RETURNING id", [id]);
  return rows.length > 0;
}

/** Registry-matched competitor event persistence (never fabricates rows). */
export async function recordCompetitorEvents(
  businessUnitId: number,
  researchItemId: number,
  drafts: CompetitorEventDraft[]
): Promise<CompetitorEvent[]> {
  if (drafts.length === 0) return [];
  const tracked = await query<{ id: string | number; name: string }>(
    "SELECT id, name FROM competitors WHERE business_unit_id = $1 AND enabled = true",
    [businessUnitId]
  );
  const created: CompetitorEvent[] = [];
  for (const draft of drafts.slice(0, 10)) {
    const match = tracked.find((t) => t.name.toLowerCase() === draft.competitor.toLowerCase())
      ?? tracked.find((t) => draft.competitor.toLowerCase().includes(t.name.toLowerCase()));
    if (!match) continue;
    const rows = await query<{
      id: string | number; business_unit_id: number; competitor_id: string | number; kind: string;
      title: string; url: string | null; snapshot: Record<string, unknown> | null;
      research_item_id: string | number | null; detected_at: string;
    }>(
      `INSERT INTO competitor_events (business_unit_id, competitor_id, kind, title, url, snapshot, research_item_id)
       VALUES ($1,$2,$3,$4,$5,$6::jsonb,$7) RETURNING *`,
      [businessUnitId, match.id, draft.kind, draft.title.slice(0, 300),
       draft.url ?? null, JSON.stringify({ citations: draft.citations ?? [] }), researchItemId]
    );
    const r = rows[0];
    created.push({
      id: Number(r.id), businessUnitId: r.business_unit_id, competitorId: Number(r.competitor_id),
      kind: r.kind, title: r.title, url: r.url, snapshot: r.snapshot,
      researchItemId: r.research_item_id != null ? Number(r.research_item_id) : null,
      detectedAt: r.detected_at,
    });
  }
  return created;
}

export async function listCompetitorEvents(businessUnitId?: number | null, limit = 50): Promise<CompetitorEvent[]> {
  const rows = await query<{
    id: string | number; business_unit_id: number; competitor_id: string | number; kind: string;
    title: string; url: string | null; snapshot: Record<string, unknown> | null;
    research_item_id: string | number | null; detected_at: string;
  }>(
    `SELECT * FROM competitor_events WHERE ($1::bigint IS NULL OR business_unit_id = $1)
     ORDER BY detected_at DESC LIMIT $2`,
    [businessUnitId ?? null, Math.min(limit, 200)]
  );
  return rows.map((r) => ({
    id: Number(r.id), businessUnitId: r.business_unit_id, competitorId: Number(r.competitor_id),
    kind: r.kind, title: r.title, url: r.url, snapshot: r.snapshot,
    researchItemId: r.research_item_id != null ? Number(r.research_item_id) : null,
    detectedAt: r.detected_at,
  }));
}

/** Dashboard stats: counts per status for a BU (or all). */
export async function stats(businessUnitId?: number | null): Promise<{ status: string; n: number }[]> {
  return query<{ status: string; n: number }>(
    `SELECT status, count(*)::int AS n FROM research_items
     WHERE ($1::bigint IS NULL OR business_unit_id = $1) GROUP BY status ORDER BY status`,
    [businessUnitId ?? null]
  );
}
