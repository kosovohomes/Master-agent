import type { LLMClient } from "../llm";
import type { AgentId } from "./types";
import { createDraft } from "./approval";
import { query } from "../db";

export type GenAgent = Exclude<AgentId, "customer_service">;

const ROLES: Record<GenAgent, string> = {
  research: "Research agent: produce a concise intel brief with bullets and sources.",
  marketing: "Marketing agent: write platform-appropriate social copy that fits the channel's style and character limits.",
  sales: "Sales agent: write a professional, non-spammy outreach or partnership pitch email.",
  ambassador: "Ambassador agent: write warm awareness copy celebrating events, testimonials, or mentions.",
};

export function systemPromptFor(agent: GenAgent, config: {
  brandVoice: string; persona: string; audience: string;
}): string {
  return [
    `You are the ${ROLES[agent]}`,
    `Brand voice: ${config.brandVoice || "professional"}`,
    `Persona: ${config.persona || "helpful brand representative"}`,
    `Target audience: ${config.audience || "general"}`,
    `Rules: no invented facts; no legal claims not present in the input; never mention abilities you lack.`,
  ].join("\n");
}

function channelHint(channel: string): string {
  const hints: Record<string, string> = {
    x: "Max 280 characters, 1-2 hashtags max, no link shorteners.",
    linkedin: "Professional tone, 3-5 short paragraphs, end with a soft call to action.",
    instagram: "Visual-first caption of ~150 characters with 2-3 hashtags and emoji use kept minimal.",
    tiktok: "Short engaging hook line for a video caption, under 200 characters.",
    email: "Subject line + 2-3 short paragraphs + a clear next step. Personalize with the prospect name if provided.",
  };
  return hints[channel] ?? "Match the channel's native style.";
}

export async function generateDraft(ctx: { llm: LLMClient }, p: {
  tenantId: number;
  agent: GenAgent;
  channel: string;
  topic: string;
  config: { brandVoice: string; persona: string; audience: string };
  context?: string;
  prospect?: { company?: string; name?: string; contact: string }; // sales agent only — inserted as a lead
}): Promise<{ draftId: number; content: string }> {
  const messages = [
    { role: "system", content: systemPromptFor(p.agent, p.config) },
    { role: "user", content: `${channelHint(p.channel)}\n\nTopic: ${p.topic}${p.context ? `\nContext: ${p.context}` : ""}` },
  ] as const;
  const content = await ctx.llm.complete(messages as any, { temperature: 0.7 });
  const { draftId } = await createDraft({
    tenantId: p.tenantId,
    agent: p.agent,
    channel: p.channel,
    content,
  });
  if (p.agent === "sales" && p.prospect) {
    await query(
      `INSERT INTO leads (tenant_id, company, name, contact, channel, stage, source)
       VALUES ($1, $2, $3, $4, $5, 'new', 'agent')`,
      [p.tenantId, p.prospect.company ?? null, p.prospect.name ?? null, p.prospect.contact, p.channel]
    );
  }
  return { draftId, content };
}