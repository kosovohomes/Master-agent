/**
 * Phase 11 — marketing workforce types (§11 P10, §220 row 10, §468).
 *
 * The marketing-level campaign FSM is a strict contract enforced in
 * service code (row-locked transactions, same contract as the content FSM
 * §60 and the social_posts FSM):
 *
 *   draft ──activate──> active ⇄ paused
 *     │                  │   │        │
 *     │                  │   └─> completed (auto on ends_at, or human)
 *     ↓                  ↓
 *  cancelled <──────── cancelled (terminal)
 *
 *  - INTO 'active' REQUIRES a human approver identity (§91: campaigns are
 *    APPROVAL-level autonomy — brief DRAFTS are AUTO, launch is not). The
 *    FIRST approver identity is immutable (§10 discipline); a paused→active
 *    relaunch re-stamps activated_at but preserves the original approver.
 *  - `completed` is reachable from active/paused: by a human, or by the
 *    marketing_sweep when ends_at has passed (time semantics, no approver
 *    needed — expiry is not a launch decision).
 *  - `cancelled` and `completed` are terminal.
 */

export type CampaignStatus = "draft" | "active" | "paused" | "completed" | "cancelled";

export const CAMPAIGN_FLOW: Record<CampaignStatus, CampaignStatus[]> = {
  draft: ["active", "cancelled"],
  active: ["paused", "completed", "cancelled"],
  paused: ["active", "completed", "cancelled"],
  completed: [],
  cancelled: [],
};

/** States that represent a LAUNCH (approval-required, §91). */
export const LAUNCH_STATES: CampaignStatus[] = ["active"];

export function canTransitionCampaign(from: CampaignStatus, to: CampaignStatus): boolean {
  return CAMPAIGN_FLOW[from]?.includes(to) ?? false;
}

export type SegmentSource = "manual" | "derived";
export type MetricSource = "manual" | "provider" | "derived";

export interface AudienceSegment {
  id: number;
  businessUnitId: number;
  name: string;
  description: string | null;
  criteria: Record<string, unknown>;
  estimatedSize: number | null;
  source: SegmentSource;
  createdByUserId: number | null;
  createdAt: string;
  updatedAt: string;
}

export interface Campaign {
  id: number;
  businessUnitId: number;
  websiteId: number | null;
  audienceSegmentId: number | null;
  name: string;
  objective: string | null;
  status: CampaignStatus;
  startsAt: string | null;
  endsAt: string | null;
  approvedByUserId: number | null;
  approvedAt: string | null;
  activatedAt: string | null;
  completedAt: string | null;
  createdByUserId: number | null;
  createdByAgent: string | null;
  metadata: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
}

export interface CampaignMetric {
  id: number;
  campaignId: number;
  capturedAt: string;
  impressions: number | null;
  clicks: number | null;
  conversions: number | null;
  spendUsd: number | null;
  source: MetricSource;
  raw: Record<string, unknown>;
}

export interface CampaignRollup {
  campaignId: number;
  impressions: number;
  clicks: number;
  conversions: number;
  spendUsd: number;
  snapshots: number;
  latest: CampaignMetric | null;
}

export class MarketingServiceError extends Error {
  code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = "MarketingServiceError";
    this.code = code;
  }
}
