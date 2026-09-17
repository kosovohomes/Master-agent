/**
 * Phase 11 — marketing brief pipeline (§468 "campaign briefs", §91 AUTO leg).
 *
 * Two legs, mirroring the social variant pipeline shape:
 *  1. DETERMINISTIC (always available): a conservative brief built ONLY from
 *     the BU profile and evidence rows (content titles, segment names).
 *     Nothing is invented — generic brand-safe objective, key messages
 *     drawn from actual evidence, channels limited to the evidence set.
 *     This is the degraded path AND the honesty floor.
 *  2. LLM (marketing agent, versioned v2 prompt from M_041,
 *     purpose="marketing"): produces the structured brief JSON. Output is
 *     sanitized: empty name / "insufficient evidence" notes → treated as an
 *     honest refusal (deterministic leg does NOT silently replace an honest
 *     refusal — the caller sees NO_BRIEF and gets the deterministic brief
 *     with a note, same evidence discipline as SEO/social).
 *
 * The LLM leg degrades cleanly: any gateway error (quota, budget, timeout)
 * falls back to deterministic — brief generation never blocks on the LLM.
 * Per §91, a brief is a DRAFT (AUTO): it lands in campaigns.status='draft'
 * and CANNOT reach 'active' without a human approver (service contract).
 */
import { query } from "../db";
import { completeJSON } from "../ai/structured";
import type { LLMClient } from "../ai/types";
import { currentVersion, getAgentBySlug, promptHash } from "../agents/registry";

export interface MarketingBrief {
  name: string;
  objective: string;
  audienceSummary: string;
  keyMessages: string[];
  channels: string[];
  startOffsetDays: number;
  durationDays: number;
  notes: string | null;
  degraded: boolean;
}

/* ------------------------------------------------------------------ */
/* Prompt loading (registry-first, code fallback — SEO/social pattern) */
/* ------------------------------------------------------------------ */

export const MARKETING_DEFAULT_PROMPT =
  `You are the Marketing Agent. You receive a business unit profile (name, industry, voice) ` +
  `and optional evidence (recent content item titles, known audience segment names, connected channels). ` +
  `Produce ONE campaign brief. Never invent metrics, customer counts, quotes or claims that are not in the evidence. ` +
  `Output strict JSON: {"name": string (short campaign name), "objective": string (one sentence), ` +
  `"audienceSummary": string, "keyMessages": string[] (3-5, each grounded in the evidence or generic brand-safe), ` +
  `"channels": string[] (subset of blog|email|linkedin|x|instagram|tiktok, prefer channels with evidence), ` +
  `"startOffsetDays": number (0-30), "durationDays": number (7-90), "notes": string (assumptions made)}. ` +
  `If the evidence is too thin to produce an honest brief, output {"name": "", "objective": "", ` +
  `"audienceSummary": "", "keyMessages": [], "channels": [], "startOffsetDays": 0, "durationDays": 0, "notes": "insufficient evidence"}.`;

export interface MarketingPrompt {
  version: number;
  systemPrompt: string;
}

export async function loadMarketingPrompt(): Promise<MarketingPrompt> {
  try {
    const agent = await getAgentBySlug("marketing");
    if (agent) {
      const v = await currentVersion(agent.id);
      if (v?.systemPrompt) return { version: v.version, systemPrompt: v.systemPrompt };
    }
  } catch {
    /* fall through to the code default */
  }
  return { version: 0, systemPrompt: MARKETING_DEFAULT_PROMPT };
}

export function fingerprint(prompt: MarketingPrompt): { promptVersion: number; promptHash: string } {
  return { promptVersion: prompt.version, promptHash: promptHash(prompt.systemPrompt) };
}

/* ------------------------------------------------------------------ */
/* Evidence gathering (read-only, per-BU)                              */
/* ------------------------------------------------------------------ */

export interface BriefEvidence {
  buName: string;
  brandVoice: string;
  persona: string;
  audience: string;
  contentTitles: string[];
  segmentNames: string[];
  connectedPlatforms: string[];
}

export interface BriefContext {
  evidence: BriefEvidence;
  /** True when the evidence set is materially empty (no titles, no segments). */
  thin: boolean;
}

/**
 * Read-only evidence sweep for one business unit. Every leg is independent:
 * a failure in a non-critical leg degrades that leg to empty rather than
 * failing brief generation (evidence is context, not a dependency).
 */
export async function gatherBriefContext(businessUnitId: number): Promise<BriefContext> {
  const evidence: BriefEvidence = {
    buName: "", brandVoice: "", persona: "", audience: "",
    contentTitles: [], segmentNames: [], connectedPlatforms: [],
  };

  try {
    const bu = await query<{ name: string; brand_voice: string; persona: string; audience: string }>(
      `SELECT name, brand_voice, persona, audience FROM business_units WHERE id = $1`,
      [businessUnitId]
    );
    if (bu.length) {
      evidence.buName = bu[0].name;
      evidence.brandVoice = bu[0].brand_voice ?? "";
      evidence.persona = bu[0].persona ?? "";
      evidence.audience = bu[0].audience ?? "";
    }
  } catch { /* degraded leg */ }

  try {
    const titles = await query<{ title: string }>(
      `SELECT title FROM content_items
       WHERE business_unit_id = $1 AND title IS NOT NULL AND lifecycle NOT IN ('ARCHIVED')
       ORDER BY updated_at DESC LIMIT 8`,
      [businessUnitId]
    );
    evidence.contentTitles = titles.map((r) => r.title);
  } catch { /* degraded leg */ }

  try {
    const segs = await query<{ name: string }>(
      `SELECT name FROM audience_segments WHERE business_unit_id = $1 ORDER BY created_at DESC LIMIT 10`,
      [businessUnitId]
    );
    evidence.segmentNames = segs.map((r) => r.name);
  } catch { /* degraded leg */ }

  try {
    const accs = await query<{ platform: string }>(
      `SELECT DISTINCT platform FROM social_accounts WHERE business_unit_id = $1 AND health = 'healthy'`,
      [businessUnitId]
    );
    evidence.connectedPlatforms = accs.map((r) => r.platform);
  } catch { /* degraded leg */ }

  const thin = evidence.contentTitles.length === 0 && evidence.segmentNames.length === 0;
  return { evidence, thin };
}

/* ------------------------------------------------------------------ */
/* Deterministic leg                                                   */
/* ------------------------------------------------------------------ */

const ALL_CHANNELS = ["blog", "email", "linkedin", "x", "instagram", "tiktok"];

/**
 * Deterministic brief: grounded in evidence only. Channels = evidence
 * platforms mapped into the channel vocabulary; key messages quote the
 * actual evidence (titles/segments); objective is brand-safe and generic.
 * startOffset 0 / duration 14 — the conservative default window.
 */
export function deterministicBrief(ctx: BriefContext): MarketingBrief {
  const { evidence, thin } = ctx;
  const channels = ALL_CHANNELS.filter((c) => evidence.connectedPlatforms.includes(c));
  if (channels.length === 0) channels.push("blog"); // brand-safe minimum, not evidence-fabricated

  const titleLead = evidence.contentTitles[0];
  const name = titleLead
    ? `Content push — ${titleLead}`.slice(0, 200)
    : `${evidence.buName || "Brand"} awareness — ${new Date().toISOString().slice(0, 10)}`;

  const keyMessages: string[] = [];
  for (const t of evidence.contentTitles.slice(0, 3)) keyMessages.push(`Feature: ${t}`);
  if (evidence.segmentNames.length) keyMessages.push(`Speak directly to segment: ${evidence.segmentNames[0]}`);
  if (keyMessages.length === 0) keyMessages.push("Introduce the brand and its current work (no invented claims)");

  const audienceSummary = evidence.audience?.trim()
    ? evidence.audience.trim().slice(0, 300)
    : evidence.segmentNames.length
      ? `Known segments: ${evidence.segmentNames.slice(0, 3).join(", ")}`
      : "General audience (no segment evidence on file)";

  return {
    name,
    objective: `Run a focused content push for ${evidence.buName || "the brand"} across ${channels.join(", ")}.`,
    audienceSummary,
    keyMessages,
    channels,
    startOffsetDays: 0,
    durationDays: 14,
    notes: thin
      ? "deterministic brief (LLM unavailable or evidence thin) — thin evidence: review before launch"
      : "deterministic brief (LLM unavailable or skipped)",
    degraded: true,
  };
}

/* ------------------------------------------------------------------ */
/* LLM leg                                                             */
/* ------------------------------------------------------------------ */

const BRIEF_SCHEMA = {
  type: "object" as const,
  properties: {
    name: { type: "string" as const },
    objective: { type: "string" as const },
    audienceSummary: { type: "string" as const },
    keyMessages: { type: "array" as const, items: { type: "string" as const } },
    channels: { type: "array" as const, items: { type: "string" as const } },
    startOffsetDays: { type: "number" as const },
    durationDays: { type: "number" as const },
    notes: { type: "string" as const },
  },
  required: ["name", "objective", "audienceSummary", "keyMessages", "channels", "startOffsetDays", "durationDays", "notes"] as const,
  additionalProperties: false,
};

const CHANNEL_ALLOW = new Set(ALL_CHANNELS);

function buildUserPrompt(ctx: BriefContext): string {
  const e = ctx.evidence;
  const lines = [
    `Business unit: ${e.buName || "(unnamed)"}`,
    e.brandVoice ? `Brand voice: ${e.brandVoice.slice(0, 300)}` : null,
    e.persona ? `Persona: ${e.persona.slice(0, 300)}` : null,
    e.audience ? `Audience: ${e.audience.slice(0, 300)}` : null,
    e.contentTitles.length ? `Recent content titles (evidence):\n${e.contentTitles.map((t) => `- ${t.slice(0, 120)}`).join("\n")}` : null,
    e.segmentNames.length ? `Known audience segments (evidence): ${e.segmentNames.join(", ")}` : null,
    e.connectedPlatforms.length ? `Connected channels (evidence): ${e.connectedPlatforms.join(", ")}` : null,
    ctx.thin ? "NOTE: evidence is thin. If an honest brief is not possible, return the insufficient-evidence shape." : null,
    `Return strict JSON per the schema.`,
  ];
  return lines.filter(Boolean).join("\n\n");
}

/**
 * The LLM leg. Returns null when the agent honestly refuses (empty name /
 * insufficient evidence). Throws propagate to the caller, which degrades to
 * deterministic — brief generation never blocks on the LLM.
 */
export async function runBriefGeneration(
  ctx: BriefContext,
  llm: LLMClient,
  prompt: MarketingPrompt
): Promise<MarketingBrief | null> {
  const out = await completeJSON<Record<string, unknown>>(
    llm,
    [
      { role: "system", content: prompt.systemPrompt },
      { role: "user", content: buildUserPrompt(ctx) },
    ],
    BRIEF_SCHEMA,
    { temperature: 0 }
  );
  const v = out.value ?? {};
  const name = String(v.name ?? "").trim();
  if (!name) return null; // honest refusal — not an error

  const channels = Array.isArray(v.channels)
    ? v.channels.map((c) => String(c).toLowerCase().trim()).filter((c) => CHANNEL_ALLOW.has(c))
    : [];
  const keyMessages = Array.isArray(v.keyMessages)
    ? v.keyMessages.map((m) => String(m).trim()).filter(Boolean).slice(0, 5)
    : [];
  const clamp = (n: unknown, lo: number, hi: number, dflt: number) => {
    const x = Math.round(Number(n));
    return Number.isFinite(x) ? Math.min(hi, Math.max(lo, x)) : dflt;
  };

  return {
    name: name.slice(0, 200),
    objective: String(v.objective ?? "").trim().slice(0, 500) || "Campaign brief generated by the marketing agent.",
    audienceSummary: String(v.audienceSummary ?? "").trim().slice(0, 500),
    keyMessages,
    channels,
    startOffsetDays: clamp(v.startOffsetDays, 0, 30, 0),
    durationDays: clamp(v.durationDays, 7, 90, 14),
    notes: String(v.notes ?? "").trim() || null,
    degraded: false,
  };
}

/**
 * Entry point: LLM first, deterministic fallback on ANY LLM failure or
 * honest refusal. Never returns an empty brief.
 */
export async function generateBrief(
  ctx: BriefContext,
  llm: LLMClient,
  prompt: MarketingPrompt
): Promise<MarketingBrief> {
  try {
    const llmBrief = await runBriefGeneration(ctx, llm, prompt);
    if (llmBrief) return llmBrief;
  } catch {
    /* degrade below — quota/budget/timeout must not block brief creation */
  }
  return deterministicBrief(ctx);
}
