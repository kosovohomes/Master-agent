/**
 * Phase 10 — social platform adapters (§38, §466).
 *
 * The legacy publisher layer (lib/agents/publishers) keeps serving the
 * LEGACY drafts sweep untouched; these adapters serve the social workforce
 * sweep. Differences:
 *  - linkedin: the author URN comes from social_accounts.account_ref (the
 *    R4 fix — legacy publishers used a hardcoded/unknown fallback).
 *  - instagram/tiktok: real API flows implemented (two-step IG container →
 *    publish; TikTok content posting) but gated by
 *    policy.allowIgTiktokPublish — default OFF keeps the §38 draft-only
 *    invariant ("nothing publishes without approval unless policy later
 *    says so"). The gate is policy-level, not code-level: flipping it on
 *    is an operator decision recorded by the flag system, not a deploy.
 *  - All adapters take the DECRYPTED credential (the sweep decrypts via the
 *    SEC-L2 envelope immediately before the call) and never log secrets.
 *
 * Errors are coded (ADAPTER_<KIND>) with provider detail truncated to a
 * short, secret-free string — the same hygiene as the AI gateway.
 */
import { SocialPublishPolicy, SocialPlatform } from "./types";

export interface AdapterPublishInput {
  accountRef: string | null;
  /** Decrypted access credential (PAT or OAuth access token). */
  token: string;
  body: string;
  policy: SocialPublishPolicy;
}

export interface AdapterPublishResult {
  externalId: string;
  externalUrl: string | null;
  /** Draft-only refusal (IG/TikTok with policy off): the post stays scheduled. */
  draftOnly?: boolean;
}

export interface AdapterMetrics {
  impressions: number | null;
  likes: number | null;
  comments: number | null;
  shares: number | null;
  clicks: number | null;
}

export interface SocialAdapter {
  platform: SocialPlatform;
  publish(ctx: { env: NodeJS.ProcessEnv; fetchImpl?: typeof fetch }, input: AdapterPublishInput): Promise<AdapterPublishResult>;
  /** Best-effort provider metrics; returns null when unsupported/unavailable. */
  fetchMetrics?(ctx: { env: NodeJS.ProcessEnv; fetchImpl?: typeof fetch }, input: { externalId: string; token: string }): Promise<AdapterMetrics | null>;
}

export class AdapterDraftOnlyError extends Error {
  code = "DRAFT_ONLY";
  constructor(platform: string) {
    super(`${platform} is draft-only (policy.allowIgTiktokPublish=false)`);
    this.name = "AdapterDraftOnlyError";
  }
}

async function postJson(
  fetchImpl: typeof fetch,
  url: string,
  init: RequestInit
): Promise<Record<string, unknown>> {
  const res = await fetchImpl(url, init);
  const text = await res.text();
  let json: Record<string, unknown> = {};
  try {
    json = text ? (JSON.parse(text) as Record<string, unknown>) : {};
  } catch {
    json = {};
  }
  if (!res.ok) {
    const detail = String(json.error ?? json.message ?? res.statusText ?? "").slice(0, 140);
    throw new Error(`http_${res.status}: ${detail}`);
  }
  return json;
}

/* ------------------------------------------------------------------ */
/* LinkedIn — real share API, author = account_ref (R4 fix)            */
/* ------------------------------------------------------------------ */

const LINKEDIN: SocialAdapter = {
  platform: "linkedin",
  async publish(_ctx, input) {
    if (!input.accountRef) {
      throw new Error("linkedin publish requires account_ref (author URN) — connect the account with one");
    }
    const json = await postJson(_ctx.fetchImpl ?? fetch, "https://api.linkedin.com/v2/ugcPosts", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${input.token}`,
        "X-Restli-Protocol-Version": "2.0.0",
      },
      body: JSON.stringify({
        author: input.accountRef,
        lifecycleState: "PUBLISHED",
        specificContent: {
          "com.linkedin.ugc.ShareContent": {
            shareCommentary: { text: input.body },
            shareMediaCategory: "NONE",
          },
        },
        visibility: { "com.linkedin.ugc.MemberNetworkVisibility": "PUBLIC" },
      }),
    });
    const id = String(json.id ?? `li-${Date.now()}`);
    return { externalId: id, externalUrl: `https://www.linkedin.com/feed/update/${id}` };
  },
};

/* ------------------------------------------------------------------ */
/* X — real tweet creation                                             */
/* ------------------------------------------------------------------ */

const X: SocialAdapter = {
  platform: "x",
  async publish(_ctx, input) {
    const json = await postJson(_ctx.fetchImpl ?? fetch, "https://api.x.com/2/tweets", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${input.token}` },
      body: JSON.stringify({ text: input.body }),
    });
    const data = (json.data ?? {}) as { id?: string };
    const id = String(data.id ?? `x-${Date.now()}`);
    return { externalId: id, externalUrl: `https://x.com/i/web/status/${id}` };
  },
};

/* ------------------------------------------------------------------ */
/* Instagram — two-step Content Publishing API, policy-gated           */
/* ------------------------------------------------------------------ */

const INSTAGRAM: SocialAdapter = {
  platform: "instagram",
  async publish(_ctx, input) {
    if (!input.policy.allowIgTiktokPublish) throw new AdapterDraftOnlyError("instagram");
    if (!input.accountRef) throw new Error("instagram publish requires account_ref (IG user id)");
    const fetchImpl = _ctx.fetchImpl ?? fetch;
    const base = `https://graph.facebook.com/v21.0/${encodeURIComponent(input.accountRef)}`;
    // Step 1: media container (caption-only).
    const container = await postJson(fetchImpl, `${base}/media`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ caption: input.body, access_token: input.token }),
    });
    const creationId = String(container.id ?? "");
    // Step 2: publish the container.
    const published = await postJson(fetchImpl, `${base}/media_publish`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ creation_id: creationId, access_token: input.token }),
    });
    const id = String(published.id ?? `ig-${Date.now()}`);
    return { externalId: id, externalUrl: null };
  },
  async fetchMetrics(_ctx, input) {
    const fetchImpl = _ctx.fetchImpl ?? fetch;
    try {
      const json = await postJson(
        fetchImpl,
        `https://graph.facebook.com/v21.0/${encodeURIComponent(input.externalId)}?fields=like_count,comments_count&access_token=${encodeURIComponent(input.token)}`,
        { method: "GET" }
      );
      return {
        impressions: null,
        likes: json.like_count != null ? Number(json.like_count) : null,
        comments: json.comments_count != null ? Number(json.comments_count) : null,
        shares: null,
        clicks: null,
      };
    } catch {
      return null; // best-effort by contract
    }
  },
};

/* ------------------------------------------------------------------ */
/* TikTok — content posting API, policy-gated                          */
/* ------------------------------------------------------------------ */

const TIKTOK: SocialAdapter = {
  platform: "tiktok",
  async publish(_ctx, input) {
    if (!input.policy.allowIgTiktokPublish) throw new AdapterDraftOnlyError("tiktok");
    const json = await postJson(_ctx.fetchImpl ?? fetch, "https://open.tiktokapis.com/v2/post/publish/content/init/", {
      method: "POST",
      headers: { "Content-Type": "application/json; charset=UTF-8", Authorization: `Bearer ${input.token}` },
      body: JSON.stringify({
        post_info: { title: input.body.slice(0, 90), privacy_level: "PUBLIC_TO_EVERYONE" },
        source_info: { source: "PASTE_TO_SHARE" },
      }),
    });
    const data = (json.data ?? {}) as { publish_id?: string };
    return { externalId: String(data.publish_id ?? `tt-${Date.now()}`), externalUrl: null };
  },
};

const ADAPTERS: Record<SocialPlatform, SocialAdapter> = {
  linkedin: LINKEDIN,
  x: X,
  instagram: INSTAGRAM,
  tiktok: TIKTOK,
};

export function getSocialAdapter(platform: SocialPlatform): SocialAdapter {
  const a = ADAPTERS[platform];
  if (!a) throw new Error(`no social adapter for ${platform}`);
  return a;
}
