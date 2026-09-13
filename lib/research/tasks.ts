/**
 * Research workforce task handlers (Phase 7).
 *
 * research_run — the durable research execution unit:
 *   flag gate (fail-closed skip, not error) → context load (schedule,
 *   competitors) → pipeline (plan/search/fetch/analyze) → store (dedup,
 *   events, escalation) — with the LLM-unavailable degraded path storing
 *   'unprocessed' material instead of failing the task.
 *
 * Reprocess: the dashboard can push an 'unprocessed' item back through
 * analysis once the LLM is funded again — payload {researchItemId} skips
 * the search/fetch legs and re-analyzes the stored material.
 *
 * Attribution: the gateway client arrives pre-attributed at the
 * composition root (registerBuiltins) — BU + task + agentSlug +
 * purpose="research" — so every analysis call is budgeted and ledgered.
 */
import type { LLMClient } from "../ai/types";
import { completeJSON } from "../ai/structured";
import { isFlagEnabled } from "../settings";
import { query } from "../db";
import { makeResearchTools, type ResearchTools } from "./tools";
import {
  runResearch,
  loadPrompt,
  needsEscalation,
  fingerprint,
  expandTopic,
} from "./pipeline";
import {
  recordFinding,
  recordUnprocessed,
  recordCompetitorEvents,
  getItem,
  listCompetitors,
  updateScheduleLastRun,
} from "./service";
import { FINDING_SCHEMA, type ResearchFinding, type ResearchRunResult, type ResearchSource } from "./types";
import { registerTaskHandler } from "../tasks/handlers";
import type { TaskHandler, TaskHandlerInput, TaskRow } from "../tasks/types";
import { emitEvent } from "../tasks/events";

export interface ResearchRunPayload {
  scheduleId?: number;
  agentSlug?: string;
  topic?: string;
  queries?: string[];
  sources?: Array<{ kind: "url" | "rss" | "sitemap"; ref: string }>;
  maxItems?: number;
  /** Reprocess mode: re-analyze a stored 'unprocessed' item. */
  researchItemId?: number;
}

/**
 * The LLM may arrive as a fixed client (tests) or a per-task factory
 * (production: the gateway factory attaches BU/task/agent attribution per
 * run so every analysis call is budgeted and ledgered).
 */
export type ResearchLlm = LLMClient | ((task: TaskRow) => LLMClient);

function resolveLlm(llm: ResearchLlm, task: TaskRow): LLMClient {
  return typeof llm === "function" ? llm(task) : llm;
}

export function makeResearchRunHandler(deps: {
  llm: ResearchLlm;
  tools?: ResearchTools;
}): TaskHandler {
  return async ({ task, step }: TaskHandlerInput): Promise<Record<string, unknown>> => {
    const payload = task.payload as ResearchRunPayload;

    // Flag gate — fail-closed SKIP (a killed phase must not error-loop).
    if (!(await isFlagEnabled("research", false))) {
      return { skipped: true, reason: "research_flag_off" };
    }

    // Reprocess mode: re-analyze stored material (no search/fetch).
    if (payload.researchItemId != null) {
      return analyzeStoredItem(task.id, Number(payload.researchItemId), resolveLlm(deps.llm, task));
    }

    let agentSlug = String(payload.agentSlug ?? "research");
    let topic = "";
    let scheduleId: number | null = null;
    let queries: string[] = [];
    let sources: Array<{ kind: "url" | "rss" | "sitemap"; ref: string }> = [];
    let competitorNames: string[] = [];
    let skipReason: string | null = null;

    await step("prepare", async () => {
      if (payload.scheduleId != null) {
        const rows = await query<{ id: number; agent_slug: string; topic: string; queries: string[] | null; sources: Array<{ kind: "url" | "rss" | "sitemap"; ref: string }> | null; enabled: boolean }>(
          "SELECT id, agent_slug, topic, queries, sources, enabled FROM research_schedules WHERE id = $1",
          [Number(payload.scheduleId)]
        );
        if (rows.length === 0) throw new Error(`schedule not found: ${payload.scheduleId}`);
        if (!rows[0].enabled) {
          skipReason = "schedule_disabled";
          return { skipped: true };
        }
        scheduleId = rows[0].id;
        topic = rows[0].topic;
        queries = rows[0].queries ?? [];
        sources = rows[0].sources ?? [];
        // Spawn payload wins when it names a workforce agent explicitly;
        // otherwise the schedule's agent executes.
        if (!payload.agentSlug) agentSlug = rows[0].agent_slug;
      } else {
        topic = String(payload.topic ?? "");
        if (topic.trim() === "") throw new Error("research_run: missing topic");
        queries = payload.queries ?? [];
        sources = payload.sources ?? [];
      }
      const comps = await listCompetitors(task.business_unit_id);
      competitorNames = comps.filter((c) => c.enabled).map((c) => c.name);
      return { agentSlug, scheduleId, sources: sources.length, competitorNames };
    });

    if (skipReason !== null) return { skipped: true, reason: skipReason };

    const prompt = await loadPrompt(agentSlug);
    const result: ResearchRunResult = { queries: [], searched: 0, fetched: 0, collected: 0, findings: 0, escalated: 0, unprocessed: 0, duplicates: 0, competitorEvents: 0, degraded: false };

    await step("research", async () => {
      const outcome = await runResearch(
        {
          businessUnitId: task.business_unit_id ?? 0,
          agentSlug,
          topic,
          queries,
          sources,
          scheduleId,
          taskId: task.id,
          competitorNames,
        },
        { llm: resolveLlm(deps.llm, task), tools: deps.tools, prompt }
      );
      Object.assign(result, outcome.result);

      for (const f of outcome.findings) {
        const rec = await recordFinding({
          businessUnitId: task.business_unit_id ?? 0,
          scheduleId,
          agentSlug,
          topic,
          query: f.query,
          finding: f.finding,
          sources: f.sources,
          dedupHash: f.dedupHash,
          material: f.material,
          taskId: task.id,
          prompt,
        });
        if (rec.duplicate) result.duplicates++;
        else {
          result.findings++;
          if (rec.status === "escalated") result.escalated++;
          result.competitorEvents += rec.competitorEvents.length;
        }
      }
      for (const u of outcome.unprocessed) {
        const rec = await recordUnprocessed({
          businessUnitId: task.business_unit_id ?? 0,
          scheduleId,
          agentSlug,
          topic,
          query: u.query,
          sources: u.sources,
          dedupHash: u.dedupHash,
          material: u.material,
          taskId: task.id,
          degradeReason: result.degradeReason ?? "unknown",
        });
        if (!rec.duplicate) result.unprocessed++;
        else result.duplicates++; // unchanged material re-collected → gate held, count it
      }
      return { ...result };
    });

    if (scheduleId != null) await updateScheduleLastRun(scheduleId);
    return { ...result };
  };
}

/** Reprocess path: stored sources → analyze → update the SAME row. */
async function analyzeStoredItem(
  taskId: number,
  itemId: number,
  llm: LLMClient
): Promise<Record<string, unknown>> {
  const item = await getItem(itemId);
  if (!item) throw new Error(`research item not found: ${itemId}`);
  if (item.status !== "unprocessed") {
    return { skipped: true, reason: `item_status_${item.status}` };
  }
  const prompt = await loadPrompt(item.agentSlug);
  const sources = (item.sources ?? []) as ResearchSource[];
  if (sources.length === 0) {
    await query("UPDATE research_items SET status = 'archived', updated_at = now() WHERE id = $1", [itemId]);
    return { skipped: true, reason: "no_sources" };
  }

  const competitorMode = item.agentSlug === "competitor";
  const user =
    `TOPIC: ${expandTopic(item.topic, new Date())}\n\nSOURCE EXCERPTS:\n\n` +
    sources.map((s) => `[${s.index}] ${s.title}\nURL: ${s.url ?? "n/a"}\n${s.snippet}`).join("\n\n---\n\n") +
    (competitorMode ? "\nAdd competitorEvents for every concrete competitor event." : "") +
    "\n\nProduce the JSON finding now.";

  const out = await completeJSON<ResearchFinding>(
    llm,
    [
      { role: "system", content: prompt.systemPrompt },
      { role: "user", content: user },
    ],
    FINDING_SCHEMA,
    { temperature: 0 }
  );
  const finding = out.value;
  const escalated = needsEscalation(finding);
  const fp = fingerprint(prompt);
  const analysis: Record<string, unknown> = {};
  for (const k of ["implications", "opportunities", "risks", "actions"] as const) {
    if (finding[k]?.length) analysis[k] = finding[k];
  }
  const rows = await query<{ id: number }>(
    `UPDATE research_items SET status = $2, title = $3, summary = $4, analysis = $5::jsonb,
       score = $6, confidence = $7, prompt_version = $8, prompt_hash = $9, updated_at = now()
     WHERE id = $1 RETURNING id`,
    [itemId, escalated ? "escalated" : "finding", finding.title.slice(0, 200), finding.summary,
     JSON.stringify(analysis), Math.min(Math.max(Math.round(finding.score), 0), 100),
     Math.min(Math.max(finding.confidence, 0), 1), fp.promptVersion, fp.promptHash]
  );
  if (rows.length === 0) throw new Error(`reprocess update failed for item ${itemId}`);

  const events = await recordCompetitorEvents(item.businessUnitId, itemId, finding.competitorEvents ?? []);

  await emitEvent(item.businessUnitId, escalated ? "research.escalated" : "research.finding", {
    itemId, agentSlug: item.agentSlug, title: finding.title, score: finding.score, reprocessed: true, taskId,
  });
  return {
    itemId, status: escalated ? "escalated" : "finding", score: finding.score,
    confidence: finding.confidence, competitorEvents: events.length,
  };
}

/** Composition-root registration (called by lib/tasks/executors.registerBuiltins). */
let registered = false;
export function registerResearchHandlers(llm: ResearchLlm, tools?: ResearchTools): void {
  if (registered) return;
  registered = true;
  registerTaskHandler("research_run", makeResearchRunHandler({ llm, tools }));
}
