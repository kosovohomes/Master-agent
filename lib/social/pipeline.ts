/**
 * Phase 10 — social variant pipeline (§466 "platform variants").
 *
 * Two legs, mirroring the SEO pipeline shape:
 *  1. DETERMINISTIC (always available): platform-native adaptation of the
 *     approved item's version body — hook = title, excerpt within the
 *     platform character budget, no fabricated facts/hashtags. This is the
 *     degraded path AND the shape/length authority.
 *  2. LLM (social_media agent, versioned prompt, purpose="social"):
 *     rewrites the item into one platform-native variant. Output is
 *     sanitized: empty body / "incompatible" notes → skipped (deterministic
 *     leg does NOT silently replace an honest refusal — the caller sees
 *     NO_BODY and drops that platform, same evidence discipline as SEO).
 *
 * The LLM leg degrades cleanly: any gateway error (quota, budget, timeout)
 * falls back to deterministic — scheduling never blocks on the LLM.
 */
import { completeJSON } from "../ai/structured";
import type { LLMClient } from "../ai/types";
import { currentVersion, getAgentBySlug, promptHash } from "../agents/registry";
import { PLATFORM_CHAR_BUDGET } from "./types";

export interface SocialVariant {
  body: string;
  degraded: boolean;
  notes: string | null;
}

/* ------------------------------------------------------------------ */
/* Prompt loading (registry-first, code fallback — SEO pattern)        */
/* ------------------------------------------------------------------ */

export const SOCIAL_DEFAULT_PROMPT =
  `You are the Social Media Agent. Produce ONE platform-native variant of the given approved content item. ` +
  `Respect the platform character budget, open with the strongest hook, keep the BU voice. ` +
  `Never invent facts, quotes, numbers or links that are not in the item. ` +
  `Output strict JSON {"body": string, "notes": string}. If the item cannot honestly be adapted, set body="" and explain in notes.`;

export interface SocialPrompt {
  version: number;
  systemPrompt: string;
}

export async function loadSocialPrompt(): Promise<SocialPrompt> {
  try {
    const agent = await getAgentBySlug("social_media");
    if (agent) {
      const v = await currentVersion(agent.id);
      if (v?.systemPrompt) return { version: v.version, systemPrompt: v.systemPrompt };
    }
  } catch {
    /* fall through to the code default */
  }
  return { version: 0, systemPrompt: SOCIAL_DEFAULT_PROMPT };
}

export function fingerprint(prompt: SocialPrompt): { promptVersion: number; promptHash: string } {
  return { promptVersion: prompt.version, promptHash: promptHash(prompt.systemPrompt) };
}

/* ------------------------------------------------------------------ */
/* Deterministic leg                                                   */
/* ------------------------------------------------------------------ */

function firstSentence(text: string): string {
  const m = text.match(/^([\s\S]{10,220}?[.!?])(\s|$)/);
  return (m ? m[1] : text.slice(0, 200)).trim();
}

/**
 * Deterministic platform-native variant: hook (title or first sentence)
 * plus the version body excerpt within the platform budget. Never fabricates.
 */
export function deterministicVariant(
  platform: SocialPlatformLite,
  item: { title: string | null; body: string }
): SocialVariant {
  const budget = PLATFORM_CHAR_BUDGET[platform];
  const hook = (item.title ?? firstSentence(item.body)).trim();
  const room = budget - hook.length - 2; // "\n\n" separator
  const excerpt = room > 40 ? item.body.trim().slice(0, room).trimEnd() : "";
  let body = excerpt ? `${hook}\n\n${excerpt}` : hook;
  if (body.length > budget) body = body.slice(0, budget - 1).trimEnd() + "…";
  return { body, degraded: true, notes: "deterministic variant (LLM unavailable or skipped)" };
}

type SocialPlatformLite = keyof typeof PLATFORM_CHAR_BUDGET;

/* ------------------------------------------------------------------ */
/* LLM leg                                                             */
/* ------------------------------------------------------------------ */

const VARIANT_SCHEMA = {
  type: "object" as const,
  properties: {
    body: { type: "string" as const },
    notes: { type: "string" as const },
  },
  required: ["body", "notes"] as const,
  additionalProperties: false,
};

export interface VariantItemInput {
  id: number;
  title: string | null;
  body: string;
  metadata: Record<string, unknown>;
}

function buildUserPrompt(platform: string, item: VariantItemInput): string {
  const budget = PLATFORM_CHAR_BUDGET[platform as SocialPlatformLite];
  const meta = Object.entries(item.metadata ?? {})
    .filter(([, v]) => v != null && typeof v !== "object")
    .slice(0, 6)
    .map(([k, v]) => `- ${k}: ${String(v).slice(0, 120)}`)
    .join("\n");
  return [
    `Target platform: ${platform} (character budget ~${budget}).`,
    `Approved content item #${item.id}:`,
    item.title ? `Title: ${item.title}` : null,
    `Body:\n${item.body.slice(0, 6000)}`,
    meta ? `Item metadata:\n${meta}` : null,
    `Return strict JSON {"body": "...", "notes": "..."}.`,
  ]
    .filter(Boolean)
    .join("\n\n");
}

/**
 * The LLM leg. Returns null when the agent honestly refuses (empty body /
 * incompatible). Throws propagate to the caller, which degrades to
 * deterministic — scheduling never blocks on the LLM.
 */
export async function runVariantGeneration(
  item: VariantItemInput,
  platform: SocialPlatformLite,
  llm: LLMClient,
  prompt: SocialPrompt
): Promise<SocialVariant | null> {
  const out = await completeJSON<{ body: string; notes: string }>(
    llm,
    [
      { role: "system", content: prompt.systemPrompt },
      { role: "user", content: buildUserPrompt(platform, item) },
    ],
    VARIANT_SCHEMA,
    { temperature: 0 }
  );
  const body = (out.value?.body ?? "").trim();
  if (!body) return null; // honest refusal ("incompatible") — not an error
  return { body, degraded: false, notes: out.value?.notes ?? null };
}

/**
 * Entry point injected into createPosts as `generateBody`: LLM first,
 * deterministic fallback on ANY LLM failure. Never returns an empty body.
 */
export function makeVariantGenerator(llm: LLMClient, prompt: SocialPrompt) {
  return async (
    platform: SocialPlatformLite,
    item: { id?: number; title: string | null; body: string; metadata?: Record<string, unknown> }
  ): Promise<string> => {
    const input: VariantItemInput = {
      id: item.id ?? 0,
      title: item.title,
      body: item.body,
      metadata: item.metadata ?? {},
    };
    try {
      const llmVariant = await runVariantGeneration(input, platform, llm, prompt);
      if (llmVariant) return llmVariant.body;
    } catch {
      /* degrade below — quota/budget/timeout must not block scheduling */
    }
    return deterministicVariant(platform, { title: item.title, body: item.body }).body;
  };
}
