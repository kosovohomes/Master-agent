/**
 * knowledge_fetch task handler (Phase 5): durable, retryable knowledge
 * source refresh riding the Phase 3 task engine ("Phase 5 machinery reused",
 * §406). Spawn with kind='knowledge_fetch', payload={knowledgeSourceId}.
 *
 * Steps: load → fetch_and_ingest (runSourceFetch) → emit. Failures emit
 * knowledge.source.failed and rethrow so the queue's backoff/retry machinery
 * handles transience (max_attempts honored); successes emit
 * knowledge.source.fetched with counts for the Operations screen.
 *
 * Embed attribution: the embed context resolves through the gateway with the
 * task's BU so ingest embeddings are budget-enforced and ledgered
 * (purpose=knowledge_ingest).
 */
import type { TaskHandler } from "../tasks/types";
import { emitEvent } from "../tasks/events";
import { getKnowledgeSource, runSourceFetch, type FetchRunResult } from "./service";
import type { EmbedContext } from "./types";
import type { KnowledgeFetcher } from "./fetchers";

export type KnowledgeEmbedProvider = (attrs: {
  businessUnitId: number | null;
  taskId: number;
}) => EmbedContext;

export function makeKnowledgeFetchHandler(deps: {
  fetcher: KnowledgeFetcher;
  embedProvider: KnowledgeEmbedProvider;
}): TaskHandler {
  return async ({ task, step }) => {
    const payload = task.payload as { knowledgeSourceId?: unknown };
    const sourceId = Number(payload.knowledgeSourceId);
    let buId: number | null = null;
    let result: FetchRunResult | undefined = undefined;

    await step("load", async () => {
      if (!Number.isInteger(sourceId) || sourceId <= 0) {
        throw new Error("knowledge_fetch: payload.knowledgeSourceId (positive integer) is required");
      }
      const src = await getKnowledgeSource(sourceId);
      if (!src) throw new Error(`knowledge source not found: ${sourceId}`);
      buId = src.businessUnitId;
      return { sourceId: src.id, kind: src.kind, status: src.status, businessUnitId: buId };
    });

    try {
      await step("fetch_and_ingest", async () => {
        const embed = deps.embedProvider({ businessUnitId: buId, taskId: task.id });
        result = await runSourceFetch(sourceId, { fetcher: deps.fetcher, embed });
        return { ...result };
      });
    } catch (e) {
      await emitEvent(buId, "knowledge.source.failed", {
        sourceId,
        error: (e instanceof Error ? e.message : String(e)).slice(0, 500),
        taskId: task.id,
      });
      throw e;
    }

    await step("emit", async () => {
      const r = result as FetchRunResult;
      await emitEvent(buId, "knowledge.source.fetched", {
        sourceId,
        fetched: r.fetched,
        ingested: r.ingested,
        deduplicated: r.deduplicated,
        chunkCount: r.chunkCount,
        errors: r.errors.length,
        taskId: task.id,
      });
      return { emitted: true };
    });

    if (result === undefined) throw new Error("knowledge_fetch: no result recorded");
    const final = result as FetchRunResult;
    return { ...final };
  };
}
