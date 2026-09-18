/**
 * Phase 13 — analytics pipeline (§99 aggregate honesty + §102–§103 digests).
 *
 * Three LLM legs over ONE deterministic metric payload, mirroring the
 * sales/marketing pipeline shape:
 *
 *   1. DETERMINISTIC (always available, the honesty floor): rule-based
 *      insights (zero-activity, error-rate, spend-without-conversion,
 *      stalled-funnel) and rule-based recommendations WITH the aggregate
 *      evidence that justifies each. Nothing is invented — every rule cites
 *      the payload numbers it fired on.
 *   2. LLM (analytics / reporting / strategy agents, versioned v1 prompts
 *      from M_047, purposes "analytics" / "reporting" / "strategy"):
 *      structured JSON refined from the same payload. Output validated by
 *      completeJSON's schema subset + clamped; a leg failure (quota,
 *      budget, timeout, garbage) degrades THAT leg to deterministic —
 *      the report still lands ready, with provenance naming which legs
 *      ran where.
 *
 * The `analytics` feature flag gates ONLY the LLM legs (checked by the
 * caller): flag OFF → deterministic-only. Dashboard READS are never gated.
 */
import { createHash } from "node:crypto";
import { completeJSON } from "../ai/structured";
import type { LLMClient, ChatMessage } from "../ai/types";
import { currentVersion, getAgentBySlug, promptHash as registryPromptHash } from "../agents/registry";
import type {
  InsightDirection,
  InsightRecord,
  RecommendationDraft,
  RecommendationKind,
  RecommendationPriority,
  ReportNarrative,
  ReportPayload,
} from "./types";
import { INSIGHT_DIRECTIONS, RECOMMENDATION_KINDS, RECOMMENDATION_PRIORITIES } from "./types";

/* ------------------------------------------------------------------ */
/* Prompt loading (registry-first, code fallback — sales pattern)      */
/* ------------------------------------------------------------------ */

export const ANALYTICS_DEFAULT_PROMPT =
  "You are the Analytics Agent. You receive an AGGREGATE metrics payload (counts, sums and rates only). Identify performance patterns and anomalies. Never invent numbers: every observation must be derivable from the payload. Output strict JSON: {\"insights\": [{\"metric\": string, \"direction\": \"up\"|\"down\"|\"flat\"|\"anomaly\", \"observation\": string}]} with at most 6 insights.";

export const REPORTING_DEFAULT_PROMPT =
  "You are the Reporting Agent. You receive an AGGREGATE metrics payload and analytics insights for the period. Write the executive digest. Never invent numbers or events not present in the payload. Output strict JSON: {\"summary\": string (at most 3 sentences), \"highlights\": string[] (at most 5), \"risks\": string[] (at most 5)}.";

export const STRATEGY_DEFAULT_PROMPT =
  "You are the Strategy Agent. You receive an AGGREGATE metrics payload (plus optional insights). Propose at most 5 concrete, evidence-cited recommendations for the owner. Never invent data — every recommendation must cite the aggregate evidence it is based on. Output strict JSON: {\"recommendations\": [{\"kind\": \"growth\"|\"efficiency\"|\"risk\"|\"content\"|\"budget\", \"priority\": \"low\"|\"medium\"|\"high\", \"title\": string, \"detail\": string, \"evidence\": string[]}]}.";

export interface AnalyticsPrompt {
  version: number;
  systemPrompt: string;
}

export async function loadAgentPrompt(slug: string, fallback: string): Promise<AnalyticsPrompt> {
  try {
    const agent = await getAgentBySlug(slug);
    if (agent) {
      const v = await currentVersion(agent.id);
      if (v?.systemPrompt) return { version: v.version, systemPrompt: v.systemPrompt };
    }
  } catch {
    /* fall through to the code default */
  }
  return { version: 0, systemPrompt: fallback };
}

export function fingerprint(p: AnalyticsPrompt): { promptVersion: number; promptHash: string } {
  return { promptVersion: p.version, promptHash: registryPromptHash(p.systemPrompt) };
}

function stableHash(s: string): string {
  return createHash("sha256").update(s).digest("hex").slice(0, 16);
}

/** Dedup hash for a strategy recommendation: scope + kind + normalized title. */
export function recommendationDedupHash(scopeKey: number, kind: string, title: string): string {
  return stableHash(`${scopeKey}:${kind}:${title.toLowerCase().replace(/\s+/g, " ").trim()}`);
}

/* ------------------------------------------------------------------ */
/* Deterministic legs (the honesty floor)                              */
/* ------------------------------------------------------------------ */

function n(v: unknown): number {
  return typeof v === "number" && Number.isFinite(v) ? v : 0;
}

/**
 * Rule-based insights. Each rule fires on an actual payload figure and its
 * observation quotes that figure — the §99 aggregate discipline applied to
 * prose. An unfunded platform still gets real insights, marked degraded.
 */
export function deterministicInsights(payload: ReportPayload): InsightRecord[] {
  const m = payload.metrics;
  const out: InsightRecord[] = [];

  if (m.leads.total > 0) {
    const hot = m.leads.hotOpen;
    out.push({
      metric: "leads.hotOpen",
      direction: hot > 0 ? "up" : "flat",
      observation: `${hot} of ${m.leads.total} leads in the window are hot and still open.`,
    });
  }
  if (m.inquiries.total > 0) {
    const rate = Math.round((m.inquiries.escalated / m.inquiries.total) * 100);
    out.push({
      metric: "inquiries.escalated",
      direction: rate >= 50 ? "anomaly" : "flat",
      observation: `${m.inquiries.escalated} of ${m.inquiries.total} inquiries escalated (${rate}%).`,
    });
  }
  if (m.llm.requests > 0) {
    const errRate = Math.round((m.llm.errors / m.llm.requests) * 100);
    out.push({
      metric: "llm.errors",
      direction: errRate >= 20 ? "anomaly" : errRate > 0 ? "down" : "flat",
      observation: `${m.llm.errors} of ${m.llm.requests} LLM requests failed (${errRate}%), costing $${m.llm.costUsd.toFixed(4)}.`,
    });
  }
  if (m.marketing.spendUsd > 0 && m.marketing.conversions === 0) {
    out.push({
      metric: "marketing.conversions",
      direction: "anomaly",
      observation: `$${m.marketing.spendUsd.toFixed(2)} spent across ${m.campaigns.active} active campaign(s) with zero recorded conversions.`,
    });
  }
  if (m.social.posts > 0 && m.social.failed > 0) {
    out.push({
      metric: "social.failed",
      direction: "anomaly",
      observation: `${m.social.failed} of ${m.social.posts} social posts failed in the window.`,
    });
  }
  if (m.tasks.failed > 0) {
    out.push({
      metric: "tasks.failed",
      direction: "anomaly",
      observation: `${m.tasks.failed} background task(s) failed permanently in the window.`,
    });
  }
  if (m.content.items > 0 && m.content.published === 0) {
    out.push({
      metric: "content.published",
      direction: "flat",
      observation: `${m.content.items} content item(s) created, none reached PUBLISHED (${m.content.inReview} in review).`,
    });
  }
  return out.slice(0, 6);
}

/**
 * Rule-based recommendations with evidence. Deterministic twins of what the
 * strategy agent refines — so the recommendations store is never empty and
 * every LLM failure still leaves actionable, evidence-cited advice.
 */
export function deterministicRecommendations(
  payload: ReportPayload,
  insights: InsightRecord[]
): RecommendationDraft[] {
  const m = payload.metrics;
  const out: RecommendationDraft[] = [];

  if (m.marketing.spendUsd > 0 && m.marketing.conversions === 0) {
    out.push({
      kind: "budget",
      priority: "high",
      title: "Review campaign spend: budget consumed with zero conversions",
      detail: `Campaign metrics recorded $${m.marketing.spendUsd.toFixed(2)} of spend and ${m.marketing.clicks} clicks but no conversions in the window. Audit targeting and landing experience before adding budget.`,
      evidence: [`spendUsd=${m.marketing.spendUsd.toFixed(2)}`, `clicks=${m.marketing.clicks}`, `conversions=${m.marketing.conversions}`],
    });
  }
  if (m.leads.hotOpen > 0) {
    out.push({
      kind: "growth",
      priority: "high",
      title: `Work the ${m.leads.hotOpen} hot lead(s) awaiting follow-up`,
      detail: `${m.leads.hotOpen} lead(s) scored hot remain open in the window. Hot leads decay fastest — assign owners and next actions on the Sales pipeline today.`,
      evidence: [`leads.hotOpen=${m.leads.hotOpen}`, `leads.total=${m.leads.total}`],
    });
  }
  if (m.inquiries.escalated > 0) {
    out.push({
      kind: "efficiency",
      priority: "medium",
      title: `Resolve ${m.inquiries.escalated} escalated inquiry/inquiries`,
      detail: `Escalations page ops by design; each open escalation is a waiting human conversation. Clear the queue and check whether the escalation triggers repeat (then fix the trigger, not the queue).`,
      evidence: [`inquiries.escalated=${m.inquiries.escalated}`, `inquiries.total=${m.inquiries.total}`],
    });
  }
  if (m.llm.requests > 0 && m.llm.errors / m.llm.requests >= 0.2) {
    out.push({
      kind: "risk",
      priority: "high",
      title: "LLM error rate above 20% — check gateway/provider health",
      detail: `${m.llm.errors} of ${m.llm.requests} LLM requests failed in the window. Inspect the AI Gateway ledger for the dominant error code; a provider outage or budget stop degrades every workforce leg at once.`,
      evidence: [`llm.errors=${m.llm.errors}`, `llm.requests=${m.llm.requests}`],
    });
  }
  if (m.content.items > 0 && m.content.published === 0 && m.content.inReview > 0) {
    out.push({
      kind: "content",
      priority: "medium",
      title: `${m.content.inReview} content item(s) stuck in review`,
      detail: "Content is produced but not reaching PUBLISHED. Schedule review capacity — the approval gate is intentionally human, so the queue length is a staffing signal, not a bug.",
      evidence: [`content.inReview=${m.content.inReview}`, `content.published=0`],
    });
  }
  if (m.research.escalated > 0) {
    out.push({
      kind: "risk",
      priority: "medium",
      title: `${m.research.escalated} research item(s) escalated for human review`,
      detail: "Escalated research findings are ambiguous or low-confidence by the §109 gate. Review them to keep the intelligence pipeline trustworthy.",
      evidence: [`research.escalated=${m.research.escalated}`],
    });
  }
  if (out.length === 0 && insights.length === 0) {
    out.push({
      kind: "growth",
      priority: "low",
      title: "Quiet period — use it to seed the next campaign",
      detail: "The window shows little workforce activity (no pressing signals). Batch new research topics, refresh knowledge sources, or plan the next campaign while the queue is empty.",
      evidence: [`window=${payload.window.key}`, `leads.total=${m.leads.total}`, `content.items=${m.content.items}`],
    });
  }
  return out.slice(0, 5);
}

/* ------------------------------------------------------------------ */
/* LLM legs (each degrades independently)                              */
/* ------------------------------------------------------------------ */

function clampText(s: unknown, max: number): string {
  return typeof s === "string" ? s.trim().slice(0, max) : "";
}

function clampLines(v: unknown, maxItems: number, maxLen: number): string[] {
  if (!Array.isArray(v)) return [];
  return v
    .filter((x): x is string => typeof x === "string" && x.trim() !== "")
    .map((x) => x.trim().slice(0, maxLen))
    .slice(0, maxItems);
}

function payloadDigest(payload: ReportPayload): string {
  return JSON.stringify({
    window: payload.window,
    scope: payload.scope,
    metrics: payload.metrics,
    breakdown: payload.breakdown,
  });
}

/** Analytics agent leg → insights. Throws on garbage (caller degrades). */
export async function insightsWithLLM(
  llm: LLMClient,
  prompt: AnalyticsPrompt,
  payload: ReportPayload
): Promise<InsightRecord[]> {
  const out = await completeJSON<Record<string, unknown>>(
    llm,
    [
      { role: "system", content: prompt.systemPrompt },
      { role: "user", content: `Metrics payload for the window:\n${payloadDigest(payload)}` },
    ] as ChatMessage[],
    {
      type: "object",
      properties: {
        insights: {
          type: "array",
          items: {
            type: "object",
            properties: {
              metric: { type: "string" },
              direction: { type: "string", enum: [...INSIGHT_DIRECTIONS] },
              observation: { type: "string" },
            },
            required: ["metric", "direction", "observation"],
          },
        },
      },
      required: ["insights"],
    } as never,
    { temperature: 0 }
  );
  const raw = Array.isArray(out.value?.insights) ? out.value.insights : [];
  const insights: InsightRecord[] = [];
  for (const item of raw.slice(0, 6)) {
    const o = (item ?? {}) as Record<string, unknown>;
    const direction = INSIGHT_DIRECTIONS.includes(o.direction as InsightDirection)
      ? (o.direction as InsightDirection)
      : "flat";
    const metric = clampText(o.metric, 80);
    const observation = clampText(o.observation, 400);
    if (metric === "" || observation === "") continue;
    insights.push({ metric, direction, observation });
  }
  return insights;
}

/** Reporting agent leg → executive digest. Throws on garbage. */
export async function narrativeWithLLM(
  llm: LLMClient,
  prompt: AnalyticsPrompt,
  payload: ReportPayload
): Promise<ReportNarrative> {
  const out = await completeJSON<Record<string, unknown>>(
    llm,
    [
      { role: "system", content: prompt.systemPrompt },
      {
        role: "user",
        content: [
          `Metrics payload for the window:\n${payloadDigest(payload)}`,
          payload.insights.length > 0
            ? `\nAnalytics insights:\n${payload.insights.map((i) => `- [${i.direction}] ${i.metric}: ${i.observation}`).join("\n")}`
            : "",
        ].filter(Boolean).join("\n"),
      },
    ] as ChatMessage[],
    {
      type: "object",
      properties: {
        summary: { type: "string" },
        highlights: { type: "array", items: { type: "string" } },
        risks: { type: "array", items: { type: "string" } },
      },
      required: ["summary", "highlights", "risks"],
    } as never,
    { temperature: 0 }
  );
  const v = out.value ?? {};
  const summary = clampText(v.summary, 1200);
  if (summary === "") throw new Error("digest: empty summary");
  return {
    summary,
    highlights: clampLines(v.highlights, 5, 300),
    risks: clampLines(v.risks, 5, 300),
  };
}

/** Strategy agent leg → recommendations. Throws on garbage. */
export async function recommendationsWithLLM(
  llm: LLMClient,
  prompt: AnalyticsPrompt,
  payload: ReportPayload
): Promise<RecommendationDraft[]> {
  const out = await completeJSON<Record<string, unknown>>(
    llm,
    [
      { role: "system", content: prompt.systemPrompt },
      {
        role: "user",
        content: [
          `Metrics payload for the window:\n${payloadDigest(payload)}`,
          payload.insights.length > 0
            ? `\nAnalytics insights:\n${payload.insights.map((i) => `- [${i.direction}] ${i.metric}: ${i.observation}`).join("\n")}`
            : "",
        ].filter(Boolean).join("\n"),
      },
    ] as ChatMessage[],
    {
      type: "object",
      properties: {
        recommendations: {
          type: "array",
          items: {
            type: "object",
            properties: {
              kind: { type: "string", enum: [...RECOMMENDATION_KINDS] },
              priority: { type: "string", enum: [...RECOMMENDATION_PRIORITIES] },
              title: { type: "string" },
              detail: { type: "string" },
              evidence: { type: "array", items: { type: "string" } },
            },
            required: ["kind", "priority", "title", "detail", "evidence"],
          },
        },
      },
      required: ["recommendations"],
    } as never,
    { temperature: 0 }
  );
  const raw = Array.isArray(out.value?.recommendations) ? out.value.recommendations : [];
  const recs: RecommendationDraft[] = [];
  for (const item of raw.slice(0, 5)) {
    const o = (item ?? {}) as Record<string, unknown>;
    const title = clampText(o.title, 200);
    const detail = clampText(o.detail, 1500);
    if (title === "" || detail === "") continue;
    recs.push({
      kind: RECOMMENDATION_KINDS.includes(o.kind as RecommendationKind)
        ? (o.kind as RecommendationKind)
        : "growth",
      priority: RECOMMENDATION_PRIORITIES.includes(o.priority as RecommendationPriority)
        ? (o.priority as RecommendationPriority)
        : "medium",
      title,
      detail,
      evidence: clampLines(o.evidence, 6, 200),
    });
  }
  return recs;
}
