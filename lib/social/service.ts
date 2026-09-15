/**
 * Social workforce service (Phase 10) — the ONLY writer of social_* rows.
 *
 * Storage contracts:
 *  - Structural approval gate (§466 acceptance): social_posts ALWAYS carry
 *    content_item_id and the item must be in lifecycle APPROVED or
 *    SCHEDULED at post creation AND at publish time. There is no path to a
 *    scheduled post that does not trace back to an approved content item.
 *  - Row-locked FSM (§60 contract): transitionPost() reads the lifecycle
 *    under FOR UPDATE, checks SOCIAL_POST_FLOW, writes in ONE transaction —
 *    two concurrent sweeps cannot both claim the same post.
 *  - BU isolation: every write carries business_unit_id; reads filter by it
 *    when a BU scope is given.
 *  - Credentials: encryptChannelToken at rest (SEC-L2 key-id envelope);
 *    plaintext NEVER persists and accounts are serialized without secrets.
 *  - LinkedIn account_ref (R4 fix): required at connect time for linkedin —
 *    the publish adapter uses it as the `author` URN.
 */
import { query, transaction } from "../db";
import { encryptChannelToken } from "../channels";
import {
  canTransitionPost,
  isSocialPlatform,
  PLATFORM_CHAR_BUDGET,
  SocialAccount,
  SocialCampaign,
  SocialCampaignStatus,
  SocialHealth,
  SocialPlatform,
  SocialPost,
  SocialPostMetric,
  SocialPostStatus,
  SocialServiceError,
} from "./types";

/* ------------------------------------------------------------------ */
/* Row mapping                                                         */
/* ------------------------------------------------------------------ */

interface AccountRow {
  id: string | number; business_unit_id: number; website_id: string | number | null;
  platform: string; display_name: string | null; account_ref: string | null;
  oauth_status: string; scopes: string | null; source: string; health: string;
  token_expires_at: string | null; last_checked_at: string | null;
  metadata: Record<string, unknown> | null; created_at: string; updated_at: string;
}

function toAccount(r: AccountRow): SocialAccount {
  return {
    id: Number(r.id), businessUnitId: r.business_unit_id,
    websiteId: r.website_id != null ? Number(r.website_id) : null,
    platform: r.platform as SocialPlatform, displayName: r.display_name,
    accountRef: r.account_ref, oauthStatus: r.oauth_status as SocialAccount["oauthStatus"],
    scopes: r.scopes, source: r.source as SocialAccount["source"],
    health: r.health as SocialHealth, tokenExpiresAt: r.token_expires_at,
    lastCheckedAt: r.last_checked_at, metadata: r.metadata ?? {},
    createdAt: r.created_at, updatedAt: r.updated_at,
  };
}

interface CampaignRow {
  id: string | number; business_unit_id: number; website_id: string | number | null;
  name: string; objective: string | null; status: string;
  starts_at: string | null; ends_at: string | null; created_by_user_id: string | number | null;
  created_at: string; updated_at: string;
}

function toCampaign(r: CampaignRow): SocialCampaign {
  return {
    id: Number(r.id), businessUnitId: r.business_unit_id,
    websiteId: r.website_id != null ? Number(r.website_id) : null,
    name: r.name, objective: r.objective,
    status: r.status as SocialCampaignStatus,
    startsAt: r.starts_at, endsAt: r.ends_at,
    createdByUserId: r.created_by_user_id != null ? Number(r.created_by_user_id) : null,
    createdAt: r.created_at, updatedAt: r.updated_at,
  };
}

interface PostRow {
  id: string | number; business_unit_id: number; website_id: string | number | null;
  content_item_id: string | number; campaign_id: string | number | null;
  platform: string; body: string; status: string; scheduled_at: string | null;
  published_at: string | null; external_id: string | null; external_url: string | null;
  error: string | null; created_by_user_id: string | number | null;
  created_by_agent: string | null; task_id: string | number | null;
  created_at: string; updated_at: string;
}

function toPost(r: PostRow): SocialPost {
  return {
    id: Number(r.id), businessUnitId: r.business_unit_id,
    websiteId: r.website_id != null ? Number(r.website_id) : null,
    contentItemId: Number(r.content_item_id),
    campaignId: r.campaign_id != null ? Number(r.campaign_id) : null,
    platform: r.platform as SocialPlatform, body: r.body,
    status: r.status as SocialPostStatus, scheduledAt: r.scheduled_at,
    publishedAt: r.published_at, externalId: r.external_id, externalUrl: r.external_url,
    error: r.error,
    createdByUserId: r.created_by_user_id != null ? Number(r.created_by_user_id) : null,
    createdByAgent: r.created_by_agent,
    taskId: r.task_id != null ? Number(r.task_id) : null,
    createdAt: r.created_at, updatedAt: r.updated_at,
  };
}

interface MetricRow {
  id: string | number; social_post_id: string | number; captured_at: string;
  impressions: string | number | null; likes: string | number | null;
  comments: string | number | null; shares: string | number | null;
  clicks: string | number | null; raw: Record<string, unknown> | null; source: string;
}

function num(v: string | number | null): number | null {
  return v == null ? null : Number(v);
}

function toMetric(r: MetricRow): SocialPostMetric {
  return {
    id: Number(r.id), socialPostId: Number(r.social_post_id), capturedAt: r.captured_at,
    impressions: num(r.impressions), likes: num(r.likes), comments: num(r.comments),
    shares: num(r.shares), clicks: num(r.clicks),
    source: r.source as SocialPostMetric["source"], raw: r.raw ?? {},
  };
}

/* ------------------------------------------------------------------ */
/* Accounts                                                            */
/* ------------------------------------------------------------------ */

export async function listAccounts(
  opts: { businessUnitId?: number | null; platform?: SocialPlatform | null; health?: SocialHealth | null } = {}
): Promise<SocialAccount[]> {
  const rows = await query<AccountRow>(
    `SELECT id, business_unit_id, website_id, platform, display_name, account_ref,
            oauth_status, scopes, source, health, token_expires_at, last_checked_at,
            metadata, created_at, updated_at
     FROM social_accounts
     WHERE ($1::bigint IS NULL OR business_unit_id = $1)
       AND ($2::text IS NULL OR platform = $2)
       AND ($3::text IS NULL OR health = $3)
     ORDER BY business_unit_id, platform, id`,
    [opts.businessUnitId ?? null, opts.platform ?? null, opts.health ?? null]
  );
  return rows.map(toAccount);
}

export interface ConnectAccountInput {
  businessUnitId: number;
  platform: SocialPlatform;
  displayName?: string | null;
  accountRef?: string | null;
  /** Plaintext credential (access token / PAT). Encrypted at rest; never stored raw. */
  token: string;
  source?: "manual" | "oauth";
  scopes?: string | null;
  tokenExpiresAt?: Date | string | null;
  metadata?: Record<string, unknown> | null;
}

/**
 * Connect (or reconnect) a platform account. Upsert semantics on the
 * dedup identity (bu, platform, coalesce(account_ref, '')): an existing
 * row gets its credentials/status refreshed (the OAuth reconnect path);
 * otherwise a row is created. linkedin REQUIRES account_ref (R4 fix).
 */
export async function connectAccount(input: ConnectAccountInput): Promise<SocialAccount> {
  if (!isSocialPlatform(input.platform)) {
    throw new SocialServiceError("BAD_PLATFORM", `unsupported platform: ${input.platform}`);
  }
  if (!input.token || typeof input.token !== "string" || input.token.length < 8) {
    throw new SocialServiceError("BAD_TOKEN", "token must be a non-empty credential string");
  }
  const ref = input.accountRef?.trim() || null;
  if (input.platform === "linkedin" && !ref) {
    throw new SocialServiceError(
      "ACCOUNT_REF_REQUIRED",
      "linkedin accounts require account_ref (the author URN, e.g. urn:li:person:xxxx) — the publish adapter uses it"
    );
  }
  const encrypted = encryptChannelToken(input.token);
  const rows = await query<AccountRow>(
    `INSERT INTO social_accounts
       (business_unit_id, platform, display_name, account_ref, credentials_encrypted,
        oauth_status, scopes, source, health, token_expires_at, metadata, last_checked_at)
     VALUES ($1, $2, $3, $4, $5, 'connected', $6, $7, 'healthy', $8, $9::jsonb, now())
     ON CONFLICT (business_unit_id, platform, COALESCE(account_ref, '')) DO UPDATE SET
       display_name = COALESCE(EXCLUDED.display_name, social_accounts.display_name),
       credentials_encrypted = EXCLUDED.credentials_encrypted,
       oauth_status = 'connected',
       scopes = COALESCE(EXCLUDED.scopes, social_accounts.scopes),
       source = EXCLUDED.source,
       health = 'healthy',
       token_expires_at = EXCLUDED.token_expires_at,
       metadata = EXCLUDED.metadata,
       last_checked_at = now(),
       updated_at = now()
     RETURNING *`,
    [
      input.businessUnitId, input.platform, input.displayName ?? null, ref, encrypted,
      input.scopes ?? null, input.source ?? "manual",
      input.tokenExpiresAt ?? null, JSON.stringify(input.metadata ?? {}),
    ]
  );
  return toAccount(rows[0]);
}

export interface UpdateAccountInput {
  displayName?: string | null;
  accountRef?: string | null;
  health?: SocialHealth;
  oauthStatus?: SocialAccount["oauthStatus"];
  tokenExpiresAt?: Date | string | null;
  metadata?: Record<string, unknown> | null;
}

/** Update mutable account fields. Credentials are NOT updatable here — reconnect instead. */
export async function updateAccount(id: number, patch: UpdateAccountInput): Promise<SocialAccount> {
  const rows = await query<AccountRow>(
    `UPDATE social_accounts SET
       display_name = COALESCE($2, display_name),
       account_ref = COALESCE($3, account_ref),
       health = COALESCE($4, health),
       oauth_status = COALESCE($5, oauth_status),
       token_expires_at = COALESCE($6, token_expires_at),
       metadata = COALESCE($7::jsonb, metadata),
       updated_at = now()
     WHERE id = $1 RETURNING *`,
    [
      id, patch.displayName ?? null, patch.accountRef ?? null, patch.health ?? null,
      patch.oauthStatus ?? null, patch.tokenExpiresAt ?? null,
      patch.metadata ? JSON.stringify(patch.metadata) : null,
    ]
  );
  if (rows.length === 0) throw new SocialServiceError("NOT_FOUND", `social account not found: ${id}`);
  return toAccount(rows[0]);
}

/** Disconnect = delete the row (audited at the route layer). */
export async function disconnectAccount(id: number): Promise<void> {
  // RETURNING is REQUIRED: a bare DELETE yields an empty rows array even
  // when it deleted a row, which would false-positive NOT_FOUND.
  const res = await query<{ id: number }>("DELETE FROM social_accounts WHERE id = $1 RETURNING id", [id]);
  if (res.length === 0) throw new SocialServiceError("NOT_FOUND", `social account not found: ${id}`);
}

/* ------------------------------------------------------------------ */
/* Campaigns                                                           */
/* ------------------------------------------------------------------ */

export async function createCampaign(input: {
  businessUnitId: number;
  name: string;
  objective?: string | null;
  websiteId?: number | null;
  startsAt?: Date | string | null;
  endsAt?: Date | string | null;
  userId?: number | null;
}): Promise<SocialCampaign> {
  const name = input.name?.trim();
  if (!name) throw new SocialServiceError("BAD_NAME", "campaign name is required");
  try {
    const rows = await query<CampaignRow>(
      `INSERT INTO social_campaigns
         (business_unit_id, website_id, name, objective, starts_at, ends_at, created_by_user_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING *`,
      [input.businessUnitId, input.websiteId ?? null, name, input.objective ?? null,
       input.startsAt ?? null, input.endsAt ?? null, input.userId ?? null]
    );
    return toCampaign(rows[0]);
  } catch (e: unknown) {
    if (String(e).includes("social_campaigns_business_unit_id_name_key") || String(e).includes("social_campaigns_business_unit_id_name")) {
      throw new SocialServiceError("DUPLICATE", `campaign name already exists in this BU: ${name}`);
    }
    throw e;
  }
}

export async function listCampaigns(
  opts: { businessUnitId?: number | null; status?: SocialCampaignStatus | null } = {}
): Promise<SocialCampaign[]> {
  const rows = await query<CampaignRow>(
    `SELECT * FROM social_campaigns
     WHERE ($1::bigint IS NULL OR business_unit_id = $1)
       AND ($2::text IS NULL OR status = $2)
     ORDER BY created_at DESC LIMIT 200`,
    [opts.businessUnitId ?? null, opts.status ?? null]
  );
  return rows.map(toCampaign);
}

export async function updateCampaign(
  id: number,
  patch: { status?: SocialCampaignStatus; objective?: string | null; startsAt?: Date | string | null; endsAt?: Date | string | null }
): Promise<SocialCampaign> {
  const rows = await query<CampaignRow>(
    `UPDATE social_campaigns SET
       status = COALESCE($2, status),
       objective = COALESCE($3, objective),
       starts_at = COALESCE($4, starts_at),
       ends_at = COALESCE($5, ends_at),
       updated_at = now()
     WHERE id = $1 RETURNING *`,
    [id, patch.status ?? null, patch.objective ?? null, patch.startsAt ?? null, patch.endsAt ?? null]
  );
  if (rows.length === 0) throw new SocialServiceError("NOT_FOUND", `campaign not found: ${id}`);
  return toCampaign(rows[0]);
}

/* ------------------------------------------------------------------ */
/* Posts — creation with the structural approval gate                  */
/* ------------------------------------------------------------------ */

export interface ContentItemRef {
  id: number;
  businessUnitId: number;
  lifecycle: string;
  title: string | null;
  currentVersionId: number | null;
}

export async function loadContentItemRef(itemId: number): Promise<ContentItemRef> {
  const rows = await query<{ id: string | number; business_unit_id: number; lifecycle: string; title: string | null; current_version_id: string | number | null }>(
    "SELECT id, business_unit_id, lifecycle, title, current_version_id FROM content_items WHERE id = $1",
    [itemId]
  );
  if (rows.length === 0) throw new SocialServiceError("ITEM_NOT_FOUND", `content item not found: ${itemId}`);
  const r = rows[0];
  return {
    id: Number(r.id), businessUnitId: r.business_unit_id, lifecycle: r.lifecycle,
    title: r.title, currentVersionId: r.current_version_id != null ? Number(r.current_version_id) : null,
  };
}

/** The approval gate: only APPROVED / SCHEDULED items may become posts. */
export function assertItemApprovable(lifecycle: string): void {
  if (lifecycle !== "APPROVED" && lifecycle !== "SCHEDULED") {
    throw new SocialServiceError(
      "CONTENT_NOT_APPROVED",
      `content item lifecycle is ${lifecycle} — only APPROVED (or SCHEDULED) items can be scheduled to social platforms (§466: nothing publishes without approval)`
    );
  }
}

export interface CreatePostsInput {
  businessUnitId: number;
  contentItemId: number;
  platforms: SocialPlatform[];
  scheduledAt: Date | string | null; // null → drafts (status 'draft', not swept)
  campaignId?: number | null;
  websiteId?: number | null;
  /** Explicit per-platform body overrides (skips the generator for that platform). */
  bodyByPlatform?: Partial<Record<SocialPlatform, string>>;
  /** Async variant generator injected by the caller (pipeline in prod, stub in tests). */
  generateBody?: (platform: SocialPlatform, item: ContentItemRef) => Promise<string>;
  userId?: number | null;
  agent?: string | null;
}

export interface CreatePostsResult {
  posts: SocialPost[];
  skipped: Array<{ platform: SocialPlatform; reason: string; code: string }>;
}

/**
 * Create one post row per platform from an approved content item.
 * Per-platform failures are COLLECTED (skipped) — one bad platform does
 * not block the others. The whole success set inserts atomically.
 */
export async function createPosts(input: CreatePostsInput): Promise<CreatePostsResult> {
  const item = await loadContentItemRef(input.contentItemId);
  if (item.businessUnitId !== input.businessUnitId) {
    throw new SocialServiceError("BU_MISMATCH", `content item ${item.id} belongs to BU ${item.businessUnitId}, not ${input.businessUnitId}`);
  }
  assertItemApprovable(item.lifecycle);

  const platforms = [...new Set(input.platforms)];
  if (platforms.length === 0) throw new SocialServiceError("BAD_PLATFORMS", "at least one platform is required");
  for (const p of platforms) {
    if (!isSocialPlatform(p)) throw new SocialServiceError("BAD_PLATFORM", `unsupported platform: ${p}`);
  }

  const scheduledAt = input.scheduledAt ? new Date(input.scheduledAt) : null;
  if (scheduledAt && Number.isNaN(scheduledAt.getTime())) {
    throw new SocialServiceError("BAD_SCHEDULE", `scheduledAt is not a valid date`);
  }
  // Time semantics: scheduling in the past is rejected (60s grace for "now").
  if (scheduledAt && scheduledAt.getTime() < Date.now() - 60_000) {
    throw new SocialServiceError("BAD_SCHEDULE", "scheduledAt must not be in the past");
  }

  // Healthy-account pre-check for scheduled posts (drafts may exist without accounts).
  if (scheduledAt) {
    const accounts = await listAccounts({ businessUnitId: input.businessUnitId, health: "healthy" });
    const healthy = new Set(accounts.map((a) => a.platform));
    for (const p of platforms) {
      if (!healthy.has(p)) {
        throw new SocialServiceError(
          "SOCIAL_ACCOUNT_MISSING",
          `no healthy ${p} account for BU ${input.businessUnitId} — connect one before scheduling`
        );
      }
    }
  }

  const posts: SocialPost[] = [];
  const skipped: CreatePostsResult["skipped"] = [];
  const bodies = new Map<SocialPlatform, string>();
  for (const p of platforms) {
    const explicit = input.bodyByPlatform?.[p]?.trim();
    if (explicit) {
      bodies.set(p, enforceBudget(explicit, p));
      continue;
    }
    if (!input.generateBody) {
      throw new SocialServiceError("NO_BODY", `no body for ${p}: pass bodyByPlatform or generateBody`);
    }
    const generated = await input.generateBody(p, item);
    if (!generated || !generated.trim()) {
      skipped.push({ platform: p, reason: "variant generation returned empty body", code: "NO_BODY" });
      continue;
    }
    bodies.set(p, enforceBudget(generated, p));
  }

  if (bodies.size > 0) {
    const status = scheduledAt ? "scheduled" : "draft";
    const values: unknown[] = [];
    const tuples = [...bodies.entries()].map(([p, body], i) => {
      values.push(input.businessUnitId, input.websiteId ?? null, input.contentItemId,
        input.campaignId ?? null, p, body, status, scheduledAt, input.userId ?? null, input.agent ?? null);
      const b = i * 10;
      return `($${b + 1}, $${b + 2}, $${b + 3}, $${b + 4}, $${b + 5}, $${b + 6}, $${b + 7}, $${b + 8}, $${b + 9}, $${b + 10})`;
    });
    // Atomic insert of the success set. A partial-UNIQUE violation for one
    // (item, platform) aborts the whole batch and surfaces as POST_EXISTS —
    // the caller sees the DB-level dedup, not a silent partial write.
    const inserted = await transaction(async (q) =>
      q<PostRow>(
        `INSERT INTO social_posts
           (business_unit_id, website_id, content_item_id, campaign_id, platform, body, status, scheduled_at, created_by_user_id, created_by_agent)
         VALUES ${tuples.join(", ")}
         RETURNING *`,
        values
      )
    );
    posts.push(...inserted.map(toPost));
  }

  // Workforce sync (best-effort but loud): first scheduled post moves the
  // item APPROVED → SCHEDULED via the content FSM. Runs after commit; a
  // failure here does not invalidate the posts (the sweep checks item
  // lifecycle independently), so it must not be silently swallowed.
  if (posts.length > 0 && item.lifecycle === "APPROVED" && scheduledAt) {
    await query(
      `UPDATE content_items SET lifecycle = 'SCHEDULED', updated_at = now()
       WHERE id = $1 AND lifecycle = 'APPROVED'`,
      [item.id]
    );
  }

  return { posts, skipped };
}

function enforceBudget(body: string, platform: SocialPlatform): string {
  const budget = PLATFORM_CHAR_BUDGET[platform];
  if (body.length <= budget) return body;
  return body.slice(0, budget - 1).trimEnd() + "…";
}

/* ------------------------------------------------------------------ */
/* Posts — reads, FSM transitions, scheduling                          */
/* ------------------------------------------------------------------ */

export async function listPosts(
  opts: {
    businessUnitId?: number | null; status?: SocialPostStatus | null;
    contentItemId?: number | null; platform?: SocialPlatform | null; limit?: number;
  } = {}
): Promise<SocialPost[]> {
  const limit = Math.min(opts.limit ?? 100, 500);
  const rows = await query<PostRow>(
    `SELECT * FROM social_posts
     WHERE ($1::bigint IS NULL OR business_unit_id = $1)
       AND ($2::text IS NULL OR status = $2)
       AND ($3::bigint IS NULL OR content_item_id = $3)
       AND ($4::text IS NULL OR platform = $4)
     ORDER BY COALESCE(scheduled_at, created_at) DESC LIMIT ${limit}`,
    [opts.businessUnitId ?? null, opts.status ?? null, opts.contentItemId ?? null, opts.platform ?? null]
  );
  return rows.map(toPost);
}

export async function getPost(id: number): Promise<SocialPost | null> {
  const rows = await query<PostRow>("SELECT * FROM social_posts WHERE id = $1", [id]);
  return rows[0] ? toPost(rows[0]) : null;
}

/**
 * Row-locked FSM transition (§60 contract). `error` attaches to failed
 * transitions; `externalId`/`externalUrl` attach to posted transitions.
 */
export async function transitionPost(
  id: number,
  to: SocialPostStatus,
  opts: { error?: string | null; externalId?: string | null; externalUrl?: string | null } = {}
): Promise<SocialPost> {
  return transaction(async (q) => {
    const locked = await q<PostRow>("SELECT * FROM social_posts WHERE id = $1 FOR UPDATE", [id]);
    if (locked.length === 0) throw new SocialServiceError("NOT_FOUND", `social post not found: ${id}`);
    const from = locked[0].status as SocialPostStatus;
    if (!canTransitionPost(from, to)) {
      throw new SocialServiceError("BAD_TRANSITION", `illegal social post transition: ${from} → ${to}`);
    }
    const rows = await q<PostRow>(
      `UPDATE social_posts SET
         status = $2,
         error = $3,
         external_id = COALESCE($4, external_id),
         external_url = COALESCE($5, external_url),
         published_at = CASE WHEN $2 = 'posted' THEN now() ELSE published_at END,
         updated_at = now()
       WHERE id = $1 RETURNING *`,
      [id, to, opts.error ?? null, opts.externalId ?? null, opts.externalUrl ?? null]
    );
    return toPost(rows[0]);
  });
}

/** Reschedule: draft|failed|scheduled → scheduled with a new time. */
export async function schedulePost(
  id: number,
  scheduledAt: Date | string,
  opts: { body?: string | null } = {}
): Promise<SocialPost> {
  const when = new Date(scheduledAt);
  if (Number.isNaN(when.getTime())) throw new SocialServiceError("BAD_SCHEDULE", "scheduledAt is not a valid date");
  if (when.getTime() < Date.now() - 60_000) throw new SocialServiceError("BAD_SCHEDULE", "scheduledAt must not be in the past");
  return transaction(async (q) => {
    const locked = await q<PostRow>("SELECT * FROM social_posts WHERE id = $1 FOR UPDATE", [id]);
    if (locked.length === 0) throw new SocialServiceError("NOT_FOUND", `social post not found: ${id}`);
    const from = locked[0].status as SocialPostStatus;
    if (from !== "draft" && from !== "failed" && from !== "scheduled") {
      throw new SocialServiceError("BAD_TRANSITION", `cannot schedule a post in status ${from}`);
    }
    const rows = await q<PostRow>(
      `UPDATE social_posts SET
         status = 'scheduled',
         scheduled_at = $2,
         body = COALESCE($3, body),
         error = NULL,
         updated_at = now()
       WHERE id = $1 RETURNING *`,
      [id, when, opts.body ?? null]
    );
    return toPost(rows[0]);
  });
}

/** Cancel: draft|scheduled|failed → cancelled (terminal, frees the slot). */
export async function cancelPost(id: number): Promise<SocialPost> {
  return transitionPost(id, "cancelled");
}

/* ------------------------------------------------------------------ */
/* Calendar (time semantics, §466)                                     */
/* ------------------------------------------------------------------ */

export interface CalendarDay {
  date: string; // YYYY-MM-DD (UTC)
  posts: SocialPost[];
}

/**
 * Group posts with scheduled_at inside [from, to] by UTC day. The calendar
 * is derived state — no denormalized calendar tables (§466: time semantics,
 * not a cron pile).
 */
export async function calendar(
  opts: { businessUnitId?: number | null; from: Date | string; to: Date | string }
): Promise<{ from: string; to: string; days: CalendarDay[] }> {
  const from = new Date(opts.from);
  const to = new Date(opts.to);
  if (Number.isNaN(from.getTime()) || Number.isNaN(to.getTime())) {
    throw new SocialServiceError("BAD_RANGE", "calendar from/to must be valid dates");
  }
  if (to.getTime() < from.getTime()) throw new SocialServiceError("BAD_RANGE", "calendar `to` is before `from`");
  const rows = await query<PostRow>(
    `SELECT * FROM social_posts
     WHERE scheduled_at IS NOT NULL
       AND scheduled_at >= $1 AND scheduled_at < $2
       AND ($3::bigint IS NULL OR business_unit_id = $3)
       AND status IN ('draft','scheduled','publishing','posted','failed')
     ORDER BY scheduled_at ASC`,
    [from, to, opts.businessUnitId ?? null]
  );
  const byDay = new Map<string, SocialPost[]>();
  for (const r of rows.map(toPost)) {
    const key = new Date(r.scheduledAt as string).toISOString().slice(0, 10);
    const bucket = byDay.get(key) ?? [];
    bucket.push(r);
    byDay.set(key, bucket);
  }
  const days = [...byDay.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([date, posts]) => ({ date, posts }));
  return { from: from.toISOString(), to: to.toISOString(), days };
}

/* ------------------------------------------------------------------ */
/* Metrics ingestion + summary                                         */
/* ------------------------------------------------------------------ */

export async function ingestMetrics(input: {
  socialPostId: number;
  impressions?: number | null;
  likes?: number | null;
  comments?: number | null;
  shares?: number | null;
  clicks?: number | null;
  raw?: Record<string, unknown> | null;
  source?: "manual" | "provider" | "backfill";
}): Promise<SocialPostMetric> {
  const post = await getPost(input.socialPostId);
  if (!post) throw new SocialServiceError("NOT_FOUND", `social post not found: ${input.socialPostId}`);
  const rows = await query<MetricRow>(
    `INSERT INTO social_post_metrics
       (social_post_id, impressions, likes, comments, shares, clicks, raw, source)
     VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, $8) RETURNING *`,
    [
      input.socialPostId, input.impressions ?? null, input.likes ?? null,
      input.comments ?? null, input.shares ?? null, input.clicks ?? null,
      JSON.stringify(input.raw ?? {}), input.source ?? "manual",
    ]
  );
  return toMetric(rows[0]);
}

export async function latestMetrics(socialPostId: number): Promise<SocialPostMetric | null> {
  const rows = await query<MetricRow>(
    "SELECT * FROM social_post_metrics WHERE social_post_id = $1 ORDER BY captured_at DESC LIMIT 1",
    [socialPostId]
  );
  return rows[0] ? toMetric(rows[0]) : null;
}

export interface MetricsSummary {
  posts: number;
  totals: { impressions: number; likes: number; comments: number; shares: number; clicks: number };
  latest: SocialPostMetric[];
}

/** Totals over the LATEST snapshot per posted post + the snapshots themselves. */
export async function metricsSummary(opts: { businessUnitId?: number | null; limit?: number } = {}): Promise<MetricsSummary> {
  const limit = Math.min(opts.limit ?? 20, 100);
  const latest = await query<MetricRow>(
    `SELECT m.* FROM social_post_metrics m
     JOIN (
       SELECT DISTINCT ON (social_post_id) social_post_id, id
       FROM social_post_metrics ORDER BY social_post_id, captured_at DESC
     ) pick ON pick.id = m.id
     JOIN social_posts p ON p.id = m.social_post_id
     WHERE ($1::bigint IS NULL OR p.business_unit_id = $1)
     ORDER BY m.captured_at DESC LIMIT ${limit}`,
    [opts.businessUnitId ?? null]
  );
  const snapshots = latest.map(toMetric);
  const totals = { impressions: 0, likes: 0, comments: 0, shares: 0, clicks: 0 };
  for (const s of snapshots) {
    totals.impressions += s.impressions ?? 0;
    totals.likes += s.likes ?? 0;
    totals.comments += s.comments ?? 0;
    totals.shares += s.shares ?? 0;
    totals.clicks += s.clicks ?? 0;
  }
  return { posts: snapshots.length, totals, latest: snapshots };
}

/* ------------------------------------------------------------------ */
/* Sweep support — due-post selection with the content gate            */
/* ------------------------------------------------------------------ */

export interface DuePost {
  id: number;
  businessUnitId: number;
  websiteId: number | null;
  platform: SocialPlatform;
  body: string;
  scheduledAt: string;
  accountRef: string | null;
  credentialsEncrypted: string;
  contentItemId: number;
}

/**
 * Due posts JOINed with their healthy account credentials. Posts whose
 * content item was ARCHIVED (withdrawn after scheduling) are auto-cancelled
 * here — the approval gate must hold at publish time, not just at creation.
 */
export async function findDuePosts(limit = 50): Promise<DuePost[]> {
  // 1) auto-cancel posts whose item is no longer approvable
  await query(
    `UPDATE social_posts p SET status = 'cancelled', error = 'content item archived/withdrawn', updated_at = now()
     WHERE p.status = 'scheduled' AND p.scheduled_at <= now()
       AND EXISTS (SELECT 1 FROM content_items c WHERE c.id = p.content_item_id AND c.lifecycle NOT IN ('APPROVED','SCHEDULED'))`
  );
  // 2) select claimable due posts with a healthy account
  const rows = await query<{
    id: string | number; business_unit_id: number; website_id: string | number | null;
    platform: string; body: string; scheduled_at: string; account_ref: string | null;
    credentials_encrypted: string; content_item_id: string | number;
  }>(
    `SELECT p.id, p.business_unit_id, p.website_id, p.platform, p.body, p.scheduled_at,
            p.content_item_id, a.account_ref, a.credentials_encrypted
     FROM social_posts p
     JOIN content_items c ON c.id = p.content_item_id AND c.lifecycle IN ('APPROVED','SCHEDULED')
     JOIN social_accounts a
       ON a.business_unit_id = p.business_unit_id AND a.platform = p.platform
      AND a.health = 'healthy' AND a.oauth_status = 'connected'
     WHERE p.status = 'scheduled' AND p.scheduled_at <= now()
     ORDER BY p.scheduled_at ASC
     LIMIT $1`,
    [limit]
  );
  return rows.map((r) => ({
    id: Number(r.id), businessUnitId: r.business_unit_id,
    websiteId: r.website_id != null ? Number(r.website_id) : null,
    platform: r.platform as SocialPlatform, body: r.body, scheduledAt: r.scheduled_at,
    accountRef: r.account_ref, credentialsEncrypted: r.credentials_encrypted,
    contentItemId: Number(r.content_item_id),
  }));
}

/** Workforce sync: all non-cancelled posts posted → item SCHEDULED → PUBLISHED. */
export async function syncItemLifecycleOnPosted(contentItemId: number): Promise<boolean> {
  const rows = await query<{ remaining: string }>(
    `SELECT COUNT(*)::text AS remaining FROM social_posts
     WHERE content_item_id = $1 AND status NOT IN ('posted','cancelled')`,
    [contentItemId]
  );
  if (rows[0]?.remaining !== "0") return false;
  const updated = await query<{ id: string | number }>(
    `UPDATE content_items SET lifecycle = 'PUBLISHED', updated_at = now()
     WHERE id = $1 AND lifecycle = 'SCHEDULED' RETURNING id`,
    [contentItemId]
  );
  return updated.length > 0;
}
