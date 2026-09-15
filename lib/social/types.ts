/**
 * Phase 10 — social workforce types (§11 P9, §38, §466).
 *
 * Platforms mirror the legacy ChannelKind social subset (linkedin/x/
 * instagram/tiktok). Email is NOT a social platform: it stays on the
 * legacy channels path (documented decision, Phase 10 report §email).
 *
 * The social_posts FSM is a strict contract enforced in service code
 * (row-locked transactions, same contract as the content FSM §60 and
 * the legacy drafts FSM SEC-C7):
 *
 *   draft ─→ scheduled ─→ publishing ─→ posted
 *     │         │    ↑        │
 *     │         │    └──── failed (reschedule, new claim)
 *     │         │             │
 *     ↓         ↓             ↓
 *  cancelled (terminal)    cancelled
 *
 *  - `publishing` is entered ONLY after the content_publications
 *    idempotency claim wins (§88) — two concurrent sweeps cannot both
 *    publish.
 *  - `posted` records external_id / external_url / published_at.
 *  - `failed` is retryable via reschedule (new scheduled_at → new claim
 *    key) — the same pattern as the legacy markFailed → re-queue path.
 *  - `cancelled` is terminal and frees the (content_item, platform) slot.
 */

export type SocialPlatform = "linkedin" | "x" | "instagram" | "tiktok";

export const SOCIAL_PLATFORMS: SocialPlatform[] = ["linkedin", "x", "instagram", "tiktok"];

export function isSocialPlatform(v: unknown): v is SocialPlatform {
  return typeof v === "string" && (SOCIAL_PLATFORMS as string[]).includes(v);
}

/** Platform character budgets the pipeline enforces deterministically. */
export const PLATFORM_CHAR_BUDGET: Record<SocialPlatform, number> = {
  linkedin: 1300,
  x: 280,
  instagram: 2200,
  tiktok: 150,
};

export type SocialAccountStatus = "connected" | "expired" | "revoked" | "error";
export type SocialAccountSource = "manual" | "oauth" | "backfill";
export type SocialHealth = "healthy" | "unhealthy";

export interface SocialAccount {
  id: number;
  businessUnitId: number;
  websiteId: number | null;
  platform: SocialPlatform;
  displayName: string | null;
  accountRef: string | null;
  oauthStatus: SocialAccountStatus;
  scopes: string | null;
  source: SocialAccountSource;
  health: SocialHealth;
  tokenExpiresAt: string | null;
  lastCheckedAt: string | null;
  metadata: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
  // Credentials NEVER leave the publish path: not part of any API response.
}

export type SocialCampaignStatus = "planning" | "active" | "paused" | "completed";

export interface SocialCampaign {
  id: number;
  businessUnitId: number;
  websiteId: number | null;
  name: string;
  objective: string | null;
  status: SocialCampaignStatus;
  startsAt: string | null;
  endsAt: string | null;
  createdByUserId: number | null;
  createdAt: string;
  updatedAt: string;
}

export type SocialPostStatus =
  | "draft"
  | "scheduled"
  | "publishing"
  | "posted"
  | "failed"
  | "cancelled";

export const SOCIAL_POST_FLOW: Record<SocialPostStatus, SocialPostStatus[]> = {
  draft: ["scheduled", "cancelled"],
  scheduled: ["publishing", "scheduled", "cancelled"], // re-schedule = move the time
  publishing: ["posted", "failed"], // occupied while in-flight; exits to a terminal-or-retry state
  posted: [],
  failed: ["scheduled", "cancelled"], // retry via reschedule
  cancelled: [],
};

export function canTransitionPost(from: SocialPostStatus, to: SocialPostStatus): boolean {
  return SOCIAL_POST_FLOW[from]?.includes(to) ?? false;
}

export interface SocialPost {
  id: number;
  businessUnitId: number;
  websiteId: number | null;
  contentItemId: number;
  campaignId: number | null;
  platform: SocialPlatform;
  body: string;
  status: SocialPostStatus;
  scheduledAt: string | null;
  publishedAt: string | null;
  externalId: string | null;
  externalUrl: string | null;
  error: string | null;
  createdByUserId: number | null;
  createdByAgent: string | null;
  taskId: number | null;
  createdAt: string;
  updatedAt: string;
}

export interface SocialPostMetric {
  id: number;
  socialPostId: number;
  capturedAt: string;
  impressions: number | null;
  likes: number | null;
  comments: number | null;
  shares: number | null;
  clicks: number | null;
  source: "manual" | "provider" | "backfill";
  raw: Record<string, unknown>;
}

/** Publish policy handed to adapters — the draft-only gate for IG/TikTok. */
export interface SocialPublishPolicy {
  /** When false, IG/TikTok adapters refuse to publish (draft-only, §38). */
  allowIgTiktokPublish: boolean;
}

export class SocialServiceError extends Error {
  code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = "SocialServiceError";
    this.code = code;
  }
}
