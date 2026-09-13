/**
 * SEO workforce task handler (Phase 9).
 *
 * seo_scan — the durable SEO execution unit:
 *   flag gate (fail-closed skip, not error) → context load (website,
 *   owned keywords, research findings, competitor intelligence) →
 *   deterministic keyword harvest → ONE LLM analysis leg (versioned seo
 *   prompt; DEGRADED to deterministic-only when the LLM is unavailable or
 *   ambiguous) → store keywords + recommendations (dedup is the DB) →
 *   seo.scan summary event.
 *
 * Degraded mode matters today: with the OpenAI account unfunded, the scan
 * still produces harvested keywords and rule-based evidence-backed
 * recommendations (acceptance: "SEO recommendations appear with evidence").
 * When the LLM is funded again, the same task instantly gains intent/
 * difficulty estimates and richer on_page/technical advice — no rework.
 *
 * Attribution: the gateway client arrives pre-attributed at the composition
 * root (registerBuiltins) — BU + task + purpose="seo" — so the analysis call
 * is budgeted and ledgered like every other LLM leg.
 */
import type { LLMClient } from "../ai/types";
import { isFlagEnabled } from "../settings";
import {
  deterministicRecommendations,
  fingerprint,
  harvestKeywords,
  loadSeoPrompt,
  runSeoAnalysis,
  sanitizeLlmRecommendations,
  type SeoPrompt,
} from "./pipeline";
import {
  listKeywords,
  loadScanContext,
  recordRecommendation,
  upsertKeyword,
  type SeoScanContext,
} from "./service";
import type { SeoRecommendationDraft, SeoScanResult } from "./types";
import { registerTaskHandler } from "../tasks/handlers";
import type { TaskHandler, TaskHandlerInput } from "../tasks/types";
import { emitEvent } from "../tasks/events";

export interface SeoScanPayload {
  businessUnitId?: number;
}

/**
 * The LLM may arrive as a fixed client (tests) or a per-task factory
 * (production: the gateway factory attaches BU/task attribution per run).
 */
export type SeoLlm = LLMClient | ((task: TaskHandlerInput["task"]) => LLMClient);

function resolveLlm(llm: SeoLlm, task: TaskHandlerInput["task"]): LLMClient {
  return typeof llm === "function" ? llm(task) : llm;
}

export function makeSeoScanHandler(deps: { llm: SeoLlm }): TaskHandler {
  return async ({ task, step }: TaskHandlerInput): Promise<Record<string, unknown>> => {
    const payload = (task.payload ?? {}) as SeoScanPayload;

    // Flag gate — fail-closed SKIP (a killed phase must not error-loop).
    if (!(await isFlagEnabled("seo", false))) {
      return { skipped: true, reason: "seo_flag_off" };
    }

    const result: SeoScanResult = {
      keywordsHarvested: 0,
      keywordsStored: 0,
      recommendations: 0,
      duplicates: 0,
      llmAnalysis: false,
      ambiguous: false,
      degraded: false,
    };

    const businessUnitId = payload.businessUnitId != null
      ? Number(payload.businessUnitId)
      : task.business_unit_id;
    if (businessUnitId == null || Number.isNaN(businessUnitId)) {
      throw new Error("seo_scan: missing businessUnitId");
    }

    let ctx: SeoScanContext;
    let prompt: SeoPrompt;
    const llmRecs: SeoRecommendationDraft[] = [];

    await step("context", async () => {
      ctx = await loadScanContext(businessUnitId);
      prompt = await loadSeoPrompt();
      return {
        website: ctx.websiteUrl,
        ownedKeywords: ctx.ownedKeywords.length,
        researchExcerpts: ctx.researchExcerpts.length,
        contentItems: ctx.contentTitles.length,
        competitors: ctx.competitorNames.length,
      };
    });

    // Step 1 — deterministic keyword harvest (always; no LLM required).
    await step("keywords", async () => {
      const harvested = harvestKeywords(ctx);
      result.keywordsHarvested = harvested.length;
      let stored = 0;
      for (const h of harvested) {
        const rec = await upsertKeyword({
          businessUnitId,
          draft: {
            keyword: h.keyword,
            intent: h.intent,
            difficultyEst: h.difficultyEst,
            volumeEst: h.volumeEst ?? null,
            url: h.url ?? null,
            source: h.source,
          },
          taskId: task.id,
        });
        if (rec.created) stored++;
      }
      result.keywordsStored = stored;
      return { harvested: result.keywordsHarvested, stored: result.keywordsStored };
    });

    // Step 2 — ONE LLM analysis leg (keywords + recommendations). Any
    // failure degrades the scan instead of failing it: the deterministic
    // artifacts stand, the reason is recorded for observability.
    await step("analysis", async () => {
      try {
        const outcome = await runSeoAnalysis(ctx, resolveLlm(deps.llm, task), prompt);
        if (outcome.analysis) {
          result.llmAnalysis = true;
          result.ambiguous = outcome.analysis.ambiguous === true;
          let llmStored = 0;
          for (const k of (outcome.analysis.keywords ?? []).slice(0, 25)) {
            if (!k.keyword || String(k.keyword).trim() === "") continue;
            const rec = await upsertKeyword({
              businessUnitId,
              draft: {
                keyword: String(k.keyword),
                intent: k.intent,
                difficultyEst: k.difficultyEst,
                volumeEst: k.volumeEst ?? null,
                url: k.url ?? null,
                source: "scan",
              },
              taskId: task.id,
            });
            if (rec.created) llmStored++;
          }
          result.keywordsStored += llmStored;
          const { kept } = sanitizeLlmRecommendations(outcome.analysis.recommendations ?? []);
          llmRecs.push(...kept);
        }
      } catch {
        result.degraded = true;
        result.degradeReason = "llm_unavailable";
      }
      return {
        llmAnalysis: result.llmAnalysis,
        ambiguous: result.ambiguous,
        degraded: result.degraded,
      };
    });

    // Step 3 — recommendations: deterministic rules ALWAYS (evidence-backed
    // by construction); LLM advice adds on top when funded. The keyword store
    // is RE-READ here so the gap rules see the post-harvest state (a brand
    // term this scan just harvested is "tracked, no target URL" — exactly
    // what the rules advise on).
    await step("recommendations", async () => {
      ctx.ownedKeywords = await listKeywords({ businessUnitId, status: "active", limit: 500 });
      const fp = fingerprint(prompt);
      const drafts = [...deterministicRecommendations(ctx), ...llmRecs];
      for (const draft of drafts) {
        const rec = await recordRecommendation({
          businessUnitId,
          draft,
          taskId: task.id,
          agentSlug: "seo",
          promptVersion: fp.promptVersion,
          promptHash: fp.promptHash,
        });
        if (rec.duplicate) result.duplicates++;
        else result.recommendations++;
      }
      return {
        recommendations: result.recommendations,
        duplicates: result.duplicates,
        degraded: result.degraded,
      };
    });

    await emitEvent(businessUnitId, "seo.scan", {
      taskId: task.id,
      keywordsStored: result.keywordsStored,
      recommendations: result.recommendations,
      duplicates: result.duplicates,
      degraded: result.degraded,
      ambiguous: result.ambiguous,
    });

    return { ...result };
  };
}

/** Composition-root registration (called by lib/tasks/executors.registerBuiltins). */
let registered = false;
export function registerSeoHandlers(llm: SeoLlm): void {
  if (registered) return;
  registered = true;
  registerTaskHandler("seo_scan", makeSeoScanHandler({ llm }));
}
