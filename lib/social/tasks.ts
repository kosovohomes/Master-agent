/**
 * Social workforce task handlers (Phase 10).
 *
 * social_sweep — Workflow #2 (scheduled_social_sweep):
 *   flag gate (fail-closed skip, not error) → claim due posts
 *   (findDuePosts: approval gate re-checked at publish time, archived
 *   items auto-cancelled) → per-post idempotency claim in
 *   content_publications (UNIQUE key social:<post>:<scheduled-at>, §88 —
 *   the SAME zero-duplicate contract as the legacy sweep) → adapter
 *   publish → FSM posted/failed → workforce lifecycle sync (all posts
 *   posted ⇒ content item SCHEDULED → PUBLISHED) → events.
 *
 * IG/TikTok draft-only (§38): the policy gate is checked BEFORE the
 * claim — draft-only platforms never enter publishing and stay
 * scheduled, exactly like the legacy sweep's skipped_draft_only. The
 * `social_publish_ig_tiktok` flag is the future policy switch.
 *
 * Metrics refresh rides the same sweep: recent posted posts get a
 * best-effort provider metrics pull (per-post errors swallowed — metrics
 * are never allowed to fail publishing work).
 *
 * Attribution: the LLM is NOT used by the sweep itself (variants are
 * generated at scheduling time); the sweep is deterministic machinery.
 */
import { isFlagEnabled } from "../settings";
import { query } from "../db";
import { decryptChannelToken } from "../channels";
import { registerTaskHandler } from "../tasks/handlers";
import { TaskCancelledError } from "../tasks/types";
import { heartbeat } from "../tasks/queue";
import type { TaskHandler, TaskHandlerInput } from "../tasks/types";
import { emitEvent } from "../tasks/events";
import {
  findDuePosts,
  latestMetrics,
  ingestMetrics,
  syncItemLifecycleOnPosted,
  transitionPost,
} from "./service";
import { AdapterDraftOnlyError, getSocialAdapter } from "./adapters";
import type { SocialAdapter } from "./adapters";
import type { SocialPlatform } from "./types";

export interface SocialSweepResult {
  skipped?: boolean;
  reason?: string;
  due: number;
  posted: number;
  failed: number;
  skipped_draft_only: number;
  duplicates_prevented: number;
  metrics_refreshed: number;
  publications: Array<{ postId: number; status: string; externalId?: string }>;
}

/** Publication-claim key per scheduled attempt (mirrors draft:<id>). */
export function socialPublicationKey(postId: number, scheduledAt: string): string {
  return `social:${postId}:${new Date(scheduledAt).toISOString()}`;
}

function isDraftOnlyPlatform(platform: SocialPlatform, igTiktokAllowed: boolean): boolean {
  return (platform === "instagram" || platform === "tiktok") && !igTiktokAllowed;
}

export interface SocialSweepDeps {
  /** Test seam: override adapters (production default: getSocialAdapter). */
  adapterFor?: (platform: SocialPlatform) => Pick<SocialAdapter, "platform" | "publish">;
}

export function makeSocialSweepHandler(deps: SocialSweepDeps = {}): TaskHandler {
  const adapterFor = deps.adapterFor ?? ((p: SocialPlatform) => getSocialAdapter(p));
  return async ({ task, step, cancelled }: TaskHandlerInput): Promise<Record<string, unknown>> => {
    const result: SocialSweepResult = {
      due: 0, posted: 0, failed: 0, skipped_draft_only: 0,
      duplicates_prevented: 0, metrics_refreshed: 0, publications: [],
    };

    // Flag gate — fail-closed SKIP (a killed phase must not error-loop).
    if (!(await isFlagEnabled("social", false))) {
      return { skipped: true, reason: "social_flag_off" };
    }
    const igTiktokAllowed = await isFlagEnabled("social_publish_ig_tiktok", false);

    const duePosts = await findDuePosts(100);
    await step("select_due", async () => {
      result.due = duePosts.length;
      return { due: duePosts.length, postIds: duePosts.map((r) => r.id) };
    });
    result.due = duePosts.length;

    for (const p of duePosts) {
      if (await cancelled()) throw new TaskCancelledError();
      await heartbeat(task.id);
      if (isDraftOnlyPlatform(p.platform, igTiktokAllowed)) {
        result.skipped_draft_only++;
        continue;
      }

      // THE IDEMPOTENCY CLAIM (§88): pending row inserted BEFORE the side
      // effect; concurrent sweeps — only the winner publishes.
      const key = socialPublicationKey(p.id, p.scheduledAt);
      const claim = await query<{ id: number }>(
        `INSERT INTO content_publications
           (social_post_id, business_unit_id, channel, idempotency_key, status, attempted_at)
         VALUES ($1, $2, $3, $4, 'pending', now())
         ON CONFLICT (idempotency_key) DO NOTHING
         RETURNING id`,
        [p.id, p.businessUnitId, p.platform, key]
      );
      if (claim.length === 0) {
        result.duplicates_prevented++;
        continue;
      }
      const publicationId = claim[0].id;

      try {
        await transitionPost(p.id, "publishing");
      } catch {
        // Another worker moved it first (e.g. cancelled while we claimed).
        await query("UPDATE content_publications SET status = 'failed', error = $2 WHERE id = $1", [publicationId, "post not claimable"]);
        result.duplicates_prevented++;
        continue;
      }

      try {
        const adapter = adapterFor(p.platform);
        const token = decryptChannelToken(p.credentialsEncrypted);
        const { externalId, externalUrl } = await adapter.publish(
          { env: process.env as NodeJS.ProcessEnv },
          { accountRef: p.accountRef, token, body: p.body, policy: { allowIgTiktokPublish: igTiktokAllowed } }
        );
        await transitionPost(p.id, "posted", { externalId, externalUrl });
        await query(
          "UPDATE content_publications SET status = 'published', external_id = $2, published_at = now() WHERE id = $1",
          [publicationId, externalId]
        );
        result.posted++;
        result.publications.push({ postId: p.id, status: "posted", externalId });
        await emitEvent(p.businessUnitId, "social.posted", { postId: p.id, platform: p.platform, externalId });

        // Workforce sync: last leg posted ⇒ item SCHEDULED → PUBLISHED.
        const itemPublished = await syncItemLifecycleOnPosted(p.contentItemId);
        if (itemPublished) {
          await emitEvent(p.businessUnitId, "content.state_changed", { itemId: p.contentItemId, to: "PUBLISHED", via: "social_sweep" });
        }
      } catch (e) {
        const message = String(e instanceof Error ? e.message : e).slice(0, 300);
        await transitionPost(p.id, "failed", { error: message });
        await query(
          "UPDATE content_publications SET status = 'failed', error = $2 WHERE id = $1",
          [publicationId, message]
        );
        result.failed++;
        result.publications.push({ postId: p.id, status: "failed" });
        await emitEvent(p.businessUnitId, "social.failed", { postId: p.id, platform: p.platform, error: message });
        // Auth-shaped failures poison the credential, not the machinery:
        // mark the account unhealthy so the next sweep skips it (and the
        // dashboard shows the account needs reconnection). Adapters normalize
        // provider failures to "http_<status>: ..." — \b(401)\b would NEVER
        // match that ("_" is a word char, so no boundary precedes "401").
        if (/http_40[13]\b/.test(message)) {
          await query(
            `UPDATE social_accounts SET health = 'unhealthy', oauth_status = 'error', last_checked_at = now(), updated_at = now()
             WHERE business_unit_id = $1 AND platform = $2`,
            [p.businessUnitId, p.platform]
          );
        }
      }
    }

    // Metrics refresh (best-effort): recent posted posts, one snapshot per sweep.
    await step("metrics_refresh", async () => {
      const recent = await query<{ id: string | number; platform: string; external_id: string; business_unit_id: number; credentials_encrypted: string }>(
        `SELECT DISTINCT ON (p.id) p.id, p.platform, p.external_id, p.business_unit_id, a.credentials_encrypted
         FROM social_posts p
         JOIN social_accounts a
           ON a.business_unit_id = p.business_unit_id AND a.platform = p.platform AND a.health = 'healthy'
         WHERE p.status = 'posted' AND p.published_at > now() - interval '7 days'
           AND p.external_id IS NOT NULL
         ORDER BY p.id, a.updated_at DESC
         LIMIT 50`
      );
      for (const r of recent) {
        if (await cancelled()) break;
        const adapter = adapterFor(r.platform as SocialPlatform) as SocialAdapter;
        if (!adapter.fetchMetrics) continue;
        try {
          const m = await adapter.fetchMetrics(
            { env: process.env as NodeJS.ProcessEnv },
            { externalId: r.external_id, token: decryptChannelToken(r.credentials_encrypted) }
          );
          if (!m) continue;
          const latest = await latestMetrics(Number(r.id));
          // Skip ingest when nothing changed since the last snapshot.
          if (
            latest &&
            latest.impressions === m.impressions && latest.likes === m.likes &&
            latest.comments === m.comments && latest.shares === m.shares &&
            latest.clicks === m.clicks
          ) {
            continue;
          }
          await ingestMetrics({
            socialPostId: Number(r.id),
            impressions: m.impressions, likes: m.likes, comments: m.comments,
            shares: m.shares, clicks: m.clicks,
            raw: {}, source: "provider",
          });
          result.metrics_refreshed++;
        } catch {
          /* metrics are best-effort by contract — never fail the sweep */
        }
      }
      return { metrics_refreshed: result.metrics_refreshed };
    });

    await emitEvent(null, "social.sweep", {
      due: result.due, posted: result.posted, failed: result.failed,
      skipped_draft_only: result.skipped_draft_only, duplicates_prevented: result.duplicates_prevented,
    });

    return result as unknown as Record<string, unknown>;
  };
}

export function registerSocialHandlers(): void {
  registerTaskHandler("social_sweep", makeSocialSweepHandler());
}
