/**
 * Phase 13 — report run orchestration + task registration.
 *
 * processReport — THE §102–§103 pipeline: collect (deterministic SQL) →
 *   insights (analytics agent) → digest (reporting agent) →
 *   recommendations (strategy agent + deterministic rules) → complete.
 * Degrades honestly: each LLM leg is attempted only when `allowLlm` (the
 * `analytics` flag) and the gateway succeed; any leg failure falls to its
 * deterministic floor and the report STILL lands 'ready' with provenance
 * naming which legs ran where. The report is never left unready because
 * one leg failed — and never left silent when the whole run failed
 * (failReport + the task.failed machinery).
 *
 * §99 hard rule: the payload is built by collectMetrics/buBreakdown —
 * counts and sums only. No leg ever receives customer rows; prompts
 * receive the aggregate digest only.
 *
 * Task machinery: `report_run` is the background pathway (cron-spawned via
 * spawnDueReportRuns; a supervisor-era caller can enqueue the same work).
 * On-demand generation runs processReport inline from the admin route.
 */
import { query } from "../db";
import { isFlagEnabled } from "../settings";
import { registerTaskHandler } from "../tasks/handlers";
import type { TaskHandler, TaskHandlerInput } from "../tasks/types";
import { emitEvent } from "../tasks/events";
import type { GatewayClient } from "../ai/gateway";
import type { LLMClient } from "../ai/types";
import { windowFor, collectMetrics, buBreakdown } from "./metrics";
import {
  ANALYTICS_DEFAULT_PROMPT,
  REPORTING_DEFAULT_PROMPT,
  STRATEGY_DEFAULT_PROMPT,
  deterministicInsights,
  deterministicRecommendations,
  fingerprint,
  insightsWithLLM,
  loadAgentPrompt,
  narrativeWithLLM,
  recommendationDedupHash,
  recommendationsWithLLM,
  type AnalyticsPrompt,
} from "./pipeline";
import {
  completeReport,
  createReport,
  failReport,
  getReport,
  upsertRecommendation,
} from "./service";
import { AnalyticsServiceError, type InsightRecord, type ReportPayload } from "./types";

export interface ProcessReportResult {
  reportId: number;
  created: boolean;
  status: "ready";
  degraded: boolean;
  insights: number;
  recommendationsCreated: number;
  windowKey: string;
}

/**
 * Per-leg gateway attribution so the llm_requests ledger names the agent +
 * purpose of each leg (executors pattern). Missing gateway → raw client.
 */
function withAttr(
  llm: LLMClient,
  attr: { businessUnitId: number | null; taskId: number; agentSlug: string; purpose: string }
): LLMClient {
  const gateway = llm as LLMClient & Partial<GatewayClient>;
  if (typeof gateway.withAttribution === "function") {
    return gateway.withAttribution({
      businessUnitId: attr.businessUnitId ?? undefined,
      taskId: attr.taskId,
      agentSlug: attr.agentSlug,
      purpose: attr.purpose,
    });
  }
  return llm;
}

export async function processReport(
  reportId: number,
  opts: { llm: LLMClient; allowLlm: boolean; windowDays?: number }
): Promise<ProcessReportResult> {
  const report = await getReport(reportId);
  if (!report) throw new AnalyticsServiceError("NOT_FOUND", 404, `report ${reportId} not found`);
  if (report.status === "ready") {
    throw new AnalyticsServiceError("BAD_STATE", 409, `report ${reportId} is already ready`);
  }

  try {
    // --- collect: deterministic SQL aggregation (the §99 payload) ---
    const { window, bounds } = windowFor(report.periodKind, report.periodKey, opts.windowDays ?? 30);
    const metrics = await collectMetrics(report.businessUnitId, bounds);
    const breakdown =
      report.businessUnitId == null
        ? await buBreakdown(
            (await query<{ id: number }>("SELECT id FROM business_units ORDER BY id ASC")).map((r) => Number(r.id)),
            bounds
          )
        : null;

    // --- insights: deterministic floor, analytics agent refines ---
    const basePayload: ReportPayload = {
      window,
      scope: report.businessUnitId == null ? "platform" : "bu",
      businessUnitId: report.businessUnitId,
      metrics,
      breakdown,
      insights: [],
      provenance: {
        insightsBy: "deterministic",
        narrativeBy: "deterministic",
        recommendationsBy: "deterministic",
        promptVersion: 0,
        promptHash: "",
      },
    };

    let insights: InsightRecord[] = deterministicInsights(basePayload);
    let insightsBy: "deterministic" | "llm" = "deterministic";
    let promptRef: AnalyticsPrompt = { version: 0, systemPrompt: REPORTING_DEFAULT_PROMPT };

    if (opts.allowLlm) {
      try {
        const p = await loadAgentPrompt("analytics", ANALYTICS_DEFAULT_PROMPT);
        promptRef = p;
        const llmInsights = await insightsWithLLM(
          withAttr(opts.llm, {
            businessUnitId: report.businessUnitId, taskId: report.id, agentSlug: "analytics", purpose: "analytics",
          }),
          p,
          basePayload
        );
        if (llmInsights.length > 0) {
          insights = llmInsights;
          insightsBy = "llm";
        }
      } catch {
        /* degrade — insights fall to the deterministic floor */
      }
    }

    // --- narrative: deterministic fallback = insight prose; reporting agent refines ---
    let narrative = {
      summary:
        insights.length > 0
          ? insights.map((i) => `${i.metric}: ${i.observation}`).join(" ")
          : `Window ${window.key}: ${metrics.leads.total} leads, ${metrics.inquiries.total} inquiries, ${metrics.llm.requests} LLM requests, $${metrics.marketing.spendUsd.toFixed(2)} spend.`,
      highlights: [] as string[],
      risks: [] as string[],
    };
    let narrativeBy: "deterministic" | "llm" = "deterministic";
    if (opts.allowLlm) {
      try {
        const p = await loadAgentPrompt("reporting", REPORTING_DEFAULT_PROMPT);
        promptRef = p;
        narrative = await narrativeWithLLM(
          withAttr(opts.llm, {
            businessUnitId: report.businessUnitId, taskId: report.id, agentSlug: "reporting", purpose: "reporting",
          }),
          p,
          { ...basePayload, insights }
        );
        narrativeBy = "llm";
      } catch {
        /* degrade — keep deterministic prose */
      }
    }

    // --- recommendations: deterministic rules ALWAYS upsert; strategy agent adds ---
    const payload: ReportPayload = {
      ...basePayload,
      insights,
      provenance: {
        insightsBy,
        narrativeBy,
        recommendationsBy: "deterministic",
        ...fingerprint(promptRef),
      },
    };

    let recommendationsBy: "deterministic" | "llm" = "deterministic";
    const drafts = [...deterministicRecommendations(payload, insights)];
    if (opts.allowLlm) {
      try {
        const p = await loadAgentPrompt("strategy", STRATEGY_DEFAULT_PROMPT);
        promptRef = p;
        const llmRecs = await recommendationsWithLLM(
          withAttr(opts.llm, {
            businessUnitId: report.businessUnitId, taskId: report.id, agentSlug: "strategy", purpose: "strategy",
          }),
          p,
          { ...payload, provenance: { ...payload.provenance, ...fingerprint(p) } }
        );
        drafts.push(...llmRecs);
        if (llmRecs.length > 0) recommendationsBy = "llm";
      } catch {
        /* degrade — deterministic rules already stored */
      }
    }

    let recommendationsCreated = 0;
    for (const d of drafts) {
      const { created } = await upsertRecommendation({
        businessUnitId: report.businessUnitId,
        source: "report",
        reportId: report.id,
        kind: d.kind,
        priority: d.priority,
        title: d.title,
        detail: d.detail,
        evidence: d.evidence,
        dedupHash: recommendationDedupHash(report.businessUnitId ?? 0, d.kind, d.title),
        agentSlug: "strategy",
        promptVersion: payload.provenance.promptVersion,
        promptHash: payload.provenance.promptHash,
        metadata: { reportId: report.id, periodKey: report.periodKey },
      });
      if (created) recommendationsCreated += 1;
    }

    // --- land the report (ready, honest provenance) ---
    payload.provenance.recommendationsBy = recommendationsBy;
    const degraded = insightsBy === "deterministic" && narrativeBy === "deterministic" && recommendationsBy === "deterministic";
    await completeReport(report.id, {
      summary: narrative.summary.slice(0, 2000),
      payload: payload as unknown as Record<string, unknown>,
      narrative,
      generatedBy: degraded ? "deterministic" : "llm",
      degraded,
      promptVersion: payload.provenance.promptVersion,
      promptHash: payload.provenance.promptHash,
    });

    await emitEvent(report.businessUnitId, "analytics.report_ready", {
      reportId: report.id,
      periodKind: report.periodKind,
      periodKey: report.periodKey,
      scope: report.businessUnitId == null ? "platform" : "bu",
      degraded,
    });

    return {
      reportId: report.id,
      created: true,
      status: "ready",
      degraded,
      insights: insights.length,
      recommendationsCreated,
      windowKey: report.periodKey,
    };
  } catch (e) {
    // The report row must never stay 'pending' silently: mark failed, then
    // rethrow so the task engine records the failure (task.failed pages ops
    // on terminal failure).
    await failReport(report.id, e instanceof Error ? e.message : String(e)).catch(() => {});
    throw e;
  }
}

/* ------------------------------------------------------------------ */
/* Task registration                                                   */
/* ------------------------------------------------------------------ */

export type ReportTaskFactory = (
  task: { business_unit_id: number | null; id: number }
) => LLMClient;

export function makeReportRunHandler(factory: ReportTaskFactory): TaskHandler {
  return async ({ task, step }: TaskHandlerInput) => {
    const payload = task.payload as {
      scheduleId?: number;
      businessUnitId?: number | null;
      periodKind?: string;
      periodKey?: string;
      title?: string;
      windowDays?: number;
    };
    if (!payload.periodKind || !payload.periodKey) {
      throw new AnalyticsServiceError("INVALID_PAYLOAD", 400, "report_run requires periodKind + periodKey");
    }

    await step("ensure_report_row", async () => {
      const { report, created } = await createReport({
        businessUnitId: payload.businessUnitId ?? null,
        periodKind: payload.periodKind as "daily" | "weekly" | "monthly" | "on_demand",
        periodKey: payload.periodKey as string,
        title: payload.title ?? `${payload.periodKind} digest (${payload.periodKey})`,
        taskId: task.id,
      });
      return { reportId: report.id, created };
    });

    // Flag drill (background handlers fail closed SKIP, never throw): the
    // `analytics` flag OFF means scheduled report runs skip this tick. The
    // pending report row stays pending — the next enabled tick re-runs it.
    if (!(await isFlagEnabled("analytics", false))) {
      return { skipped: true, reason: "analytics_flag_off" };
    }

    const reportRow = await query<{ id: number }>(
      `SELECT id FROM reports WHERE COALESCE(business_unit_id, 0) = COALESCE($1, 0)
         AND period_kind = $2 AND period_key = $3`,
      [payload.businessUnitId ?? null, payload.periodKind, payload.periodKey]
    );
    if (reportRow.length === 0) {
      throw new AnalyticsServiceError("NOT_FOUND", 404, "report row vanished after ensure step");
    }
    const report = await getReport(reportRow[0].id);
    if (!report) {
      throw new AnalyticsServiceError("NOT_FOUND", 404, "report row vanished after ensure step");
    }

    let result: Record<string, unknown> = {};
    await step("run_pipeline", async () => {
      const llm = factory({ business_unit_id: report.businessUnitId, id: task.id });
      const r = await processReport(report.id, {
        llm,
        allowLlm: true,
        windowDays: payload.windowDays,
      });
      result = r as unknown as Record<string, unknown>;
      return result;
    });
    return result;
  };
}

export function registerAnalyticsHandlers(factory: ReportTaskFactory): void {
  registerTaskHandler("report_run", makeReportRunHandler(factory));
}
