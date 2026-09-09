import { query } from "../../db";
import { markPosted, markFailed } from "../approval";

export type ChannelKind = "linkedin" | "x" | "instagram" | "tiktok" | "email";

export interface PublishInput {
  channel: ChannelKind; content: string; token: string; target?: string;
}

export interface Publisher {
  kind: ChannelKind;
  publish(ctx: { fetchImpl?: typeof fetch; env: NodeJS.ProcessEnv }, p: PublishInput): Promise<{ externalId: string }>;
}

function makeHttpPublisher(kind: ChannelKind, endpoint: string, buildBody: (p: PublishInput) => unknown): Publisher {
  return {
    kind,
    async publish(ctx, p) {
      if (kind === "instagram" || kind === "tiktok") {
        throw new Error(`${kind} is draft-only in v1`);
      }
      const fetchImpl = ctx.fetchImpl ?? fetch;
      const res = await fetchImpl(endpoint, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${p.token}`,
        },
        body: JSON.stringify(buildBody(p)),
      });
      if (!res.ok) throw new Error(`${kind} publish ${res.status}: ${(await res.text()).slice(0, 200)}`);
      const json = (await res.json()) as { id?: string };
      return { externalId: json.id ?? `${kind}-${Date.now()}` };
    },
  };
}

const EMAIL_PUBLISHER: Publisher = {
  kind: "email",
  async publish(ctx, p) {
    const fetchImpl = ctx.fetchImpl ?? fetch;
    const key = ctx.env.RESEND_API_KEY ?? "";
    const subject = p.content.split("\n")[0]?.replace(/^Subject:\s*/i, "") ?? "Message";
    const text = p.content.replace(/^Subject:\s*.*\n/i, "");
    const res = await fetchImpl("https://api.resend.com/emails", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${key}` },
      body: JSON.stringify({ from: ctx.env.EMAIL_FROM ?? "agents@agentos.local", to: p.target ?? ctx.env.EMAIL_TARGET, subject, text }),
    });
    if (!res.ok) throw new Error(`email publish ${res.status}: ${(await res.text()).slice(0, 200)}`);
    const json = (await res.json()) as { id?: string };
    return { externalId: json.id ?? `email-${Date.now()}` };
  },
};

const PUBLISHERS: Record<ChannelKind, Publisher> = {
  linkedin: makeHttpPublisher("linkedin", "https://api.linkedin.com/v2/shares", (p) => ({
    author: p.target ?? "urn:li:person:unknown",
    lifecycleState: "PUBLISHED",
    specificContent: { "com.linkedin.ugc.ShareContent": { shareCommentary: { text: p.content }, shareMediaCategory: "NONE" } },
    visibility: { "com.linkedin.ugc.MemberNetworkVisibility": "PUBLIC" },
  })),
  x: makeHttpPublisher("x", "https://api.x.com/2/tweets", (p) => ({ text: p.content })),
  instagram: { kind: "instagram", publish: () => Promise.reject(new Error("instagram is draft-only in v1")) },
  tiktok: { kind: "tiktok", publish: () => Promise.reject(new Error("tiktok is draft-only in v1")) },
  email: EMAIL_PUBLISHER,
};

export function getPublisher(kind: ChannelKind): Publisher {
  const p = PUBLISHERS[kind];
  if (!p) throw new Error(`no publisher for ${kind}`);
  return p;
}

export async function sweepDue(ctx: {
  publish(p: PublishInput): Promise<{ externalId: string }>;
}): Promise<{ posted: number; failed: number }> {
  const due = await query<{ id: number; tenant_id: number; channel: ChannelKind; content: string }>(
    `SELECT id, tenant_id, channel, content FROM drafts WHERE status = 'scheduled'`
  );
  let posted = 0, failed = 0;
  for (const d of due) {
    if (d.channel === "instagram" || d.channel === "tiktok") continue; // draft-only channels never auto-post
    const row = await query<{ token_encrypted: string; target?: string | null; status: string }>(
      "SELECT token_encrypted, status FROM channels WHERE tenant_id = $1 AND kind = $2",
      [d.tenant_id, d.channel]
    );
    if (row.length === 0 || row[0].status === "unhealthy") {
      await markFailed(d.id, "channel missing or unhealthy");
      failed++;
      continue;
    }
    try {
      const { externalId } = await ctx.publish({ channel: d.channel, content: d.content, token: row[0].token_encrypted });
      await markPosted(d.id, externalId);
      posted++;
    } catch (e) {
      await markFailed(d.id, String(e));
      failed++;
      await query("UPDATE channels SET status = 'unhealthy' WHERE tenant_id = $1 AND kind = $2", [d.tenant_id, d.channel]);
    }
  }
  return { posted, failed };
}