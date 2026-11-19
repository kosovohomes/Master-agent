/**
 * Lightweight, deterministic draft-quality signals.
 *
 * These never rewrite model output — the reviewer stays in control — but they
 * surface obvious problems (empty copy, channel overflow, raw JSON) in the
 * draft's review_notes so a human can catch them before approval/publishing.
 */

/** Soft guidance limits. Instagram/TikTok allow long captions; X is hard. */
export const CHANNEL_CHAR_LIMITS: Record<string, number> = {
  x: 280,
  instagram: 2200,
  tiktok: 2200,
  linkedin: 3000,
  email: 10000,
};

export function draftQualityWarnings(content: string, channel: string): string[] {
  const warnings: string[] = [];
  const text = (content ?? "").trim();

  if (text === "") {
    warnings.push("AI returned empty content — regenerate before approving.");
  }
  const limit = CHANNEL_CHAR_LIMITS[channel.toLowerCase()];
  if (limit && content.length > limit) {
    warnings.push(`Content is ${content.length} characters; ${channel} guidance is ${limit}. Consider trimming.`);
  }
  if (/^\s*[{[]/.test(text) && /\s["']?[\w-]+["']?\s*:/.test(text)) {
    warnings.push("Content looks like raw JSON rather than finished copy.");
  }
  return warnings;
}

export function qualityNote(warnings: string[]): string | null {
  return warnings.length > 0 ? `AUTO-QUALITY: ${warnings.join(" ")}` : null;
}
