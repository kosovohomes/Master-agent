/**
 * Content workforce task handlers (Phase 8).
 *
 * content_run — the durable content execution unit:
 *   flag gate (fail-closed skip, not error) → context load (item, research
 *   lineage) → chain (strategy → content → fact_check) → persist (append-
 *   only version + lifecycle transitions) → submit for review (risk-mapped).
 *
 * Degraded mode (§144 containment, Phase 7 pattern): when the LLM is
 * unavailable the task SUCCEEDS with degraded=true — the item parks in
 * RESEARCHING with unprocessed_reason and the full material preserved in
 * the brief, so a later reprocess (payload {contentItemId}) re-runs the
 * chain once the provider is funded. Nothing is lost, nothing error-loops.
 *
 * Attribution: the gateway client arrives pre-attributed at the composition
 * root (registerBuiltins) — BU + task + purpose="content" — so every chain
 * call is budgeted and ledgered.
 */
import type { LLMClient } from "../ai/types";
import type { GatewayClient } from "../ai/gateway";
import { isFlagEnabled } from "../settings";
import { query } from "../db";
import { promptHash } from "../agents/registry";
import { runChain, type ChainSource } from "./chain";
import { riskFromFactCheck, type ContentRunResult, type FactCheckReport } from "./types";
import {
  createItem,
  getItem,
  appendVersion,
  transitionItem,
  submitForReview,
  setTask,
  setUnprocessedReason,
  ContentServiceError,
} from "./service";
import { registerTaskHandler } from "../tasks/handlers";
import type { TaskHandler, TaskHandlerInput, TaskRow } from "../tasks/types";

export interface ContentRunPayload {
  /** Run the chain for an existing item (also the reprocess path). */
  contentItemId?: number;
  /** Create the item from a research finding, then run the chain. */
  researchItemId?: number;
  /** Create the item from a bare brief, then run the chain. */
  brief?: string;
  type?: string;
  websiteId?: number;
  /** Skip the strategy step when the brief already IS a plan. */
  skipStrategy?: boolean;
}

export type ContentLlm = LLMClient | ((task: TaskRow) => LLMClient);

function resolveLlm(llm: ContentLlm, task: TaskRow): LLMClient {
  return typeof llm === "function" ? llm(task) : llm;
}

interface ResearchItemLite {
  id: number;
  topic: string;
  title: string | null;
  summary: string | null;
  analysis: Record<string, unknown> | null;
  status: string;
  sources: Array<{ index: number; title: string; url: string | null; snippet: string; fetchedAt?: string | null }>;
}

async function loadResearchItem(id: number): Promise<ResearchItemLite> {
  const rows = await query<{
    id: number; topic: string; title: string | null; summary: string | null;
    analysis: Record<string, unknown> | null; status: string;
    sources: ResearchItemLite["sources"] | null;
  }>(
    `SELECT id, topic, title, summary, analysis, status, sources
     FROM research_items WHERE id = $1`,
    [id]
  );
  if (rows.length === 0) throw new ContentServiceError("NOT_FOUND", `research item not found: ${id}`);
  const r = rows[0];
  if (!["finding", "verified"].includes(r.status)) {
    throw new ContentServiceError("INVALID_SOURCE", `research item status '${r.status}' is not a content source (need finding|verified)`);
  }
  return { id: r.id, topic: r.topic, title: r.title, summary: r.summary, analysis: r.analysis, status: r.status, sources: r.sources ?? [] };
}

/** Persist one chain outcome onto the item: version → DRAFT → FACT_CHECK → REVIEW. */
async function persistOutcome(
  itemId: number,
  outcome: Awaited<ReturnType<typeof runChain>>,
  opts: { createdByAgent: string; taskId: number }
): Promise<{ riskLevel: ReturnType<typeof riskFromFactCheck>; factCheck: FactCheckReport }> {
  // RESEARCHING → DRAFT: the version below IS the draft materializing.
  await transitionItem(itemId, "DRAFT", { actorLabel: "content-chain" });
  const version = await appendVersion(itemId, {
    title: outcome.draft.title.slice(0, 200),
    body: outcome.draft.body,
    metadata: {
      plan: {
        angle: outcome.plan.angle,
        audience: outcome.plan.audience,
        keyMessages: outcome.plan.keyMessages,
        outline: outcome.plan.outline,
        ambiguous: outcome.plan.ambiguous,
      },
      factCheck: outcome.factCheck,
    },
    createdByAgent: opts.createdByAgent,
    promptVersion: outcome.prompts.content.version,
    promptHash: promptHash(outcome.prompts.content.systemPrompt),
    changeNote: "content chain v1 (strategy → content → fact_check)",
  });

  await transitionItem(itemId, "FACT_CHECK", { actorLabel: "content-chain" });
  const item = await transitionItem(itemId, "REVIEW", { actorLabel: "content-chain" });
  const riskLevel = riskFromFactCheck(outcome.factCheck.status);
  await submitForReview(item.id, {
    riskLevel,
    requestedAction: "publish",
    taskId: opts.taskId,
    actorLabel: "content-chain",
  });
  return { riskLevel, factCheck: outcome.factCheck };
}

export function makeContentRunHandler(deps: { llm: ContentLlm }): TaskHandler {
  return async ({ task, step }: TaskHandlerInput): Promise<Record<string, unknown>> => {
    const payload = task.payload as ContentRunPayload;

    // Flag gate — fail-closed SKIP (a killed phase must not error-loop).
    if (!(await isFlagEnabled("content", false))) {
      return { skipped: true, reason: "content_flag_off" };
    }

    let itemId = 0;
    let briefText = String(payload.brief ?? "").trim();
    let sources: ChainSource[] = [];
    const fromResearchItemId = payload.researchItemId ?? null;
    let mode = "existing";

    await step("prepare", async () => {
      if (payload.contentItemId != null) {
        const existing = await getItem(Number(payload.contentItemId));
        if (!existing) throw new ContentServiceError("NOT_FOUND", `content item not found: ${payload.contentItemId}`);
        itemId = existing.id;
        await setTask(itemId, task.id);
        // Reprocess: rebuild the brief from what was preserved.
        if (briefText === "") {
          const rb = existing.brief as { brief?: string; researchTitle?: string; researchSummary?: string; topic?: string };
          const joined = [rb.researchTitle, rb.researchSummary, rb.topic].filter(Boolean).join("\n\n");
          briefText = rb.brief ?? joined ?? "";
        }
        if (briefText === "") throw new ContentServiceError("INVALID_BRIEF", "reprocess item has no preserved brief");
        // Research lineage sources ride along on reprocess.
        if (existing.researchItemId != null) {
          const ri = await loadResearchItem(existing.researchItemId);
          sources = ri.sources.map((s) => ({ index: s.index, title: s.title, url: s.url, snippet: s.snippet }));
        }
        mode = "existing";
        return { mode, itemId, briefChars: briefText.length, sources: sources.length };
      }

      if (payload.researchItemId != null) {
        mode = "research";
        const ri = await loadResearchItem(Number(payload.researchItemId));
        sources = ri.sources.map((s) => ({ index: s.index, title: s.title, url: s.url, snippet: s.snippet }));
        briefText =
          `Write a ${payload.type ?? "article"} for the business unit based on this verified research finding.\n\n` +
          `TOPIC: ${ri.topic}\n` +
          (ri.title ? `FINDING: ${ri.title}\n` : "") +
          (ri.summary ? `SUMMARY: ${ri.summary}\n` : "") +
          (briefText ? `OPERATOR BRIEF: ${briefText}\n` : "");
        const item = await createItem({
          businessUnitId: task.business_unit_id ?? 0,
          websiteId: payload.websiteId ?? null,
          researchItemId: ri.id,
          type: (payload.type as never) ?? "article",
          title: ri.title?.slice(0, 200) ?? ri.topic.slice(0, 200),
          brief: {
            source: "research",
            researchItemId: ri.id,
            topic: ri.topic,
            researchTitle: ri.title,
            researchSummary: ri.summary,
            brief: briefText.slice(0, 8000),
          },
          createdByAgent: "content-chain",
          taskId: task.id,
        });
        itemId = item.id;
        await transitionItem(itemId, "RESEARCHING", { actorLabel: "content-chain" });
        return { mode, itemId, sources: sources.length };
      }

      // Bare brief mode.
      mode = "brief";
      if (briefText === "") throw new ContentServiceError("INVALID_BRIEF", "content_run needs contentItemId, researchItemId or brief");
      const item = await createItem({
        businessUnitId: task.business_unit_id ?? 0,
        websiteId: payload.websiteId ?? null,
        type: (payload.type as never) ?? "article",
        title: briefText.slice(0, 80),
        brief: { source: "manual", brief: briefText.slice(0, 8000) },
        createdByAgent: "content-chain",
        taskId: task.id,
      });
      itemId = item.id;
      await transitionItem(itemId, "RESEARCHING", { actorLabel: "content-chain" });
      return { mode, itemId };
    });

    if (itemId === 0) throw new ContentServiceError("INVALID_PAYLOAD", "prepare did not resolve a content item");

    const result: ContentRunResult = {
      itemId,
      fromResearchItemId,
      lifecycle: "RESEARCHING",
      versions: 0,
      approvalSubmitted: false,
      degraded: false,
    };

    try {
      await step("chain", async () => {
        const outcome = await runChain({
          brief: briefText,
          sources,
          llm: resolveLlm(deps.llm, task),
          type: payload.type,
        });
        const persisted = await persistOutcome(itemId, outcome, { createdByAgent: "content-chain", taskId: task.id });
        result.lifecycle = "REVIEW";
        result.versions = 1;
        result.plan = {
          angle: outcome.plan.angle,
          ambiguous: outcome.plan.ambiguous,
          keyMessages: outcome.plan.keyMessages.length,
        };
        result.factCheck = { status: persisted.factCheck.status, claims: persisted.factCheck.claims.length };
        result.riskLevel = persisted.riskLevel;
        result.approvalSubmitted = true;
        return { ...result };
      });
    } catch (e) {
      // Degraded mode (§144): provider/budget/parse failures park the item —
      // the task SUCCEEDS so the queue never error-loops; the brief and
      // lineage stay on the row for a funded-key reprocess.
      result.degraded = true;
      result.degradeReason = (e instanceof Error ? e.message : String(e)).slice(0, 300);
      await setUnprocessedReason(itemId, result.degradeReason);
      await query(
        `UPDATE content_items SET brief = brief || $2::jsonb, updated_at = now() WHERE id = $1`,
        [itemId, JSON.stringify({ degradeReason: result.degradeReason })]
      );
      return { ...result };
    }

    return { ...result };
  };
}

/** Composition-root registration (called by lib/tasks/executors.registerBuiltins). */
let registered = false;
export function registerContentHandlers(llm: ContentLlm): void {
  if (registered) return;
  registered = true;
  registerTaskHandler("content_run", makeContentRunHandler({ llm }));
}

/** Convenience for API routes: gateway-attributed client (purpose="content"). */
export function attributedContentLlm(gateway: LLMClient & Partial<GatewayClient>, p: {
  businessUnitId: number | null;
  taskId: number;
}): LLMClient {
  if (typeof gateway.withAttribution === "function") {
    return gateway.withAttribution({ businessUnitId: p.businessUnitId, taskId: p.taskId, purpose: "content" });
  }
  return gateway;
}
