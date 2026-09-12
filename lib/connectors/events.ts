/**
 * Connector event router (Phase 6): what happens AFTER a webhook delivery
 * is authenticated (HMAC + timestamp), replay-checked, and capability-gated.
 *
 * Executed events (Phase 6):
 *   content.sync / content.updated / sitemap.updated (READ_CONTENT) —
 *     ensure a knowledge source per target (sitemap URL / page URL) scoped
 *     to the sending website, then spawn durable knowledge_fetch tasks —
 *     the Phase 5 fetch→ingest machinery does the actual sync (§406 reuse).
 *   heartbeat — liveness only.
 *
 * Record-only events (lead.created, analytics.ping, unknown types) are
 * accepted and logged with 202 so a site is never told "unsupported" and a
 * later phase can backfill behavior without a contract change (§411: no
 * platform redeploy when a site evolves).
 *
 * Failure containment (§144): every error here is scoped to ONE delivery of
 * ONE website — the route records status='failed' (making the delivery id
 * retryable) and other sites are untouched by construction (no shared state).
 */
import { query } from "../db";
import { spawnTask } from "../tasks/queue";
import { emitEvent } from "../tasks/events";
import { SYNC_EVENT_TYPES, type ConnectorWebsite } from "./types";

export class ConnectorEventError extends Error {
  code: string;
  constructor(code: string, message: string) {
    super(message);
    this.code = code;
    this.name = "ConnectorEventError";
  }
}

interface SyncTarget {
  kind: "sitemap" | "url";
  ref: string;
}

const MAX_URLS_PER_EVENT = 5;

function extractSyncTargets(data: Record<string, unknown>): SyncTarget[] {
  const targets: SyncTarget[] = [];
  const push = (kind: SyncTarget["kind"], ref: unknown) => {
    if (typeof ref !== "string") return;
    const trimmed = ref.trim();
    if (trimmed === "" || targets.some((t) => t.kind === kind && t.ref === trimmed)) return;
    if (!/^https?:\/\//i.test(trimmed)) return; // only fetchable http(s) refs
    targets.push({ kind, ref: trimmed });
  };
  push("sitemap", data.sitemapUrl);
  push("url", data.url);
  if (Array.isArray(data.urls)) {
    for (const u of data.urls) {
      if (targets.length >= MAX_URLS_PER_EVENT) break;
      push("url", u);
    }
  }
  return targets;
}

/** Find-or-create the website-scoped knowledge source for a sync target. */
async function ensureSyncSource(website: ConnectorWebsite, target: SyncTarget): Promise<number> {
  const existing = await query<{ id: number }>(
    `SELECT id FROM knowledge_sources
     WHERE website_id = $1 AND kind = $2 AND ref = $3`,
    [website.id, target.kind, target.ref]
  );
  if (existing.length > 0) return existing[0].id;
  const inserted = await query<{ id: number }>(
    `INSERT INTO knowledge_sources
       (business_unit_id, website_id, kind, ref, title, description,
        access_level, refresh_frequency, status)
     VALUES ($1, $2, $3, $4, $5, $6, $7, 'manual', 'active')
     RETURNING id`,
    [
      website.businessUnitId,
      website.id,
      target.kind,
      target.ref,
      `${website.name} ${target.kind} sync`.slice(0, 200),
      "Created by the website connector content.sync flow",
      "public", // site-published content — widget/customer grounding sees it (P5 backfill parity)
    ]
  );
  return inserted[0].id;
}

export interface ConnectorEventContext {
  website: ConnectorWebsite;
  integrationId: number;
  eventType: string;
  data: Record<string, unknown>;
  deliveryId: string;
}

export interface ConnectorEventResult {
  action: "sync" | "heartbeat" | "recorded" | "ignored";
  sourceIds?: number[];
  taskIds?: number[];
  spawnDeduplicated?: number;
  detail?: string;
}

/** SpawnTask signature narrowed for injection in tests. */
export type SpawnFn = typeof spawnTask;

export function makeConnectorEventHandler(deps: { spawnTask?: SpawnFn } = {}) {
  const spawn = deps.spawnTask ?? spawnTask;
  return async function handleConnectorEvent(ctx: ConnectorEventContext): Promise<ConnectorEventResult> {
    // Every authenticated delivery refreshes the connector liveness stamp.
    await query(
      `UPDATE website_integrations SET last_event_at = now(), updated_at = now() WHERE id = $1`,
      [ctx.integrationId]
    );

    if (SYNC_EVENT_TYPES.includes(ctx.eventType as (typeof SYNC_EVENT_TYPES)[number])) {
      const targets = extractSyncTargets(ctx.data);
      if (targets.length === 0) {
        throw new ConnectorEventError(
          "SYNC_TARGET_REQUIRED",
          "content.sync requires data.sitemapUrl, data.url, or data.urls (http(s), max 5 per event)"
        );
      }
      const sourceIds: number[] = [];
      const taskIds: number[] = [];
      let deduplicated = 0;
      for (const target of targets) {
        const sourceId = await ensureSyncSource(ctx.website, target);
        sourceIds.push(sourceId);
        const { taskId, created } = await spawn({
          businessUnitId: ctx.website.businessUnitId,
          kind: "knowledge_fetch",
          payload: { knowledgeSourceId: sourceId },
          idempotencyKey: `knowledge_fetch:${sourceId}:connector:${ctx.deliveryId}`,
          createdBy: "connector",
        });
        if (created) taskIds.push(taskId);
        else deduplicated++;
      }
      await emitEvent(ctx.website.businessUnitId, "connector.content.sync", {
        websiteId: ctx.website.id,
        connectorId: ctx.integrationId,
        deliveryId: ctx.deliveryId,
        eventType: ctx.eventType,
        sources: sourceIds,
        spawnedTasks: taskIds.length,
        deduplicated,
      });
      return { action: "sync", sourceIds, taskIds, spawnDeduplicated: deduplicated };
    }

    if (ctx.eventType === "heartbeat") {
      return { action: "heartbeat" };
    }

    // lead.created, analytics.ping, and any future event type: recorded,
    // accepted, no pipeline yet — behavior lands in the owning workforce phase.
    return {
      action: "ignored",
      detail: `event type "${ctx.eventType}" accepted (record-only in Phase 6)`,
    };
  };
}
