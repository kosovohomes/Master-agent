/**
 * Phase 12 — classification + scoring pipeline (§55 contract, §909).
 *
 * Two legs, mirroring the marketing/social pipeline shape:
 *  1. DETERMINISTIC (always available, the honesty floor): keyword routing
 *     for classification (sales vs support vs spam vs general) and signal
 *     arithmetic for scoring (email/company/phone/commercial-intent
 *     signals → 0-100). Nothing is invented — the summary is a truncation
 *     of the actual inquiry, the rationale names the actual signals.
 *  2. LLM (customer_inquiry / lead agents, versioned v1 prompts from
 *     M_044, purpose="sales"): structured JSON refined from the same
 *     evidence. Output sanitized + clamped; an LLM failure (quota,
 *     budget, timeout, garbage) degrades to deterministic — inquiry
 *     intake NEVER blocks on the LLM.
 *
 * The `sales` feature flag gates ONLY the LLM legs (checked by the caller):
 * flag OFF → deterministic-only, inquiries stay 'new' until a human or a
 * later flag-on classify run touches them. Widget chat and persistence are
 * NOT gated by this flag.
 */
import { completeJSON } from "../ai/structured";
import type { LLMClient } from "../ai/types";
import { currentVersion, getAgentBySlug, promptHash } from "../agents/registry";
import {
  bandFor,
  clampScore,
  type InquiryClassification,
  type InquiryClassificationResult,
  type InquiryUrgency,
  type LeadScoreResult,
  type ScoreBand,
} from "./types";

/* ------------------------------------------------------------------ */
/* Prompt loading (registry-first, code fallback — marketing pattern)  */
/* ------------------------------------------------------------------ */

export const INQUIRY_DEFAULT_PROMPT =
  `You are the Customer Inquiry Agent. You receive a customer inquiry (name, email, subject, body) and the ` +
  `recent conversation transcript. Classify it. Never invent facts. Output strict JSON: ` +
  `{"classification": "sales"|"support"|"spam"|"general", "urgency": "low"|"medium"|"high", ` +
  `"summary": string (one sentence), "isLead": boolean (true only when the inquiry expresses commercial ` +
  `interest in the brand's products/services), "company": string|null, "contactName": string|null, ` +
  `"contactEmail": string|null, "notes": string (evidence actually present in the inquiry)}.`;

export const LEAD_DEFAULT_PROMPT =
  `You are the Lead Agent. You receive a lead record (company, contact name/email/phone, inquiry body, ` +
  `conversation highlights). Score the lead 0-100 for commercial readiness. Never invent facts — score ` +
  `ONLY what the record shows. Output strict JSON: {"leadScore": number 0-100, "band": "cold"|"warm"|"hot" ` +
  `(cold 0-39, warm 40-69, hot 70-100), "nextAction": string (one concrete next step for the sales team), ` +
  `"rationale": string (which record fields drove the score)}.`;

export interface SalesPrompt {
  version: number;
  systemPrompt: string;
}

export async function loadAgentPrompt(slug: string, fallback: string): Promise<SalesPrompt> {
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

export function fingerprint(p: SalesPrompt): { promptVersion: number; promptHash: string } {
  return { promptVersion: p.version, promptHash: promptHash(p.systemPrompt) };
}

/* ------------------------------------------------------------------ */
/* Deterministic legs (the honesty floor)                              */
/* ------------------------------------------------------------------ */

const SALES_TERMS = [
  "outreach", "pitch", "lead", "partnership", "prospect", "sell", "sales",
  "pricing", "quote", "demo", "purchase", "buy", "contract", "budget", "proposal",
];
const SUPPORT_TERMS = [
  "bug", "error", "broken", "help", "issue", "problem", "not working",
  "crash", "support", "refund", "cancel", "complaint", "fix", "how do i",
];
const SPAM_SIGNALS = ["http://", "https://", "seo service", "crypto", "casino", "backlinks", "guest post"];

function classifyText(text: string): InquiryClassification {
  const t = text.toLowerCase();
  const links = (t.match(/https?:\/\//g) ?? []).length;
  const spamHits = SPAM_SIGNALS.filter((s) => t.includes(s)).length;
  // Link-stuffed + short = spam heuristic (evidence-based, conservative).
  if (links >= 3 || (spamHits >= 1 && links >= 1 && t.length < 400)) return "spam";
  const salesHits = SALES_TERMS.filter((s) => t.includes(s)).length;
  const supportHits = SUPPORT_TERMS.filter((s) => t.includes(s)).length;
  if (salesHits > supportHits) return "sales";
  if (supportHits > salesHits) return "support";
  return "general";
}

/** Urgency heuristic: explicit pain words on a support path escalate fast. */
function urgencyFor(text: string, classification: InquiryClassification): InquiryUrgency {
  const t = text.toLowerCase();
  const severe = ["urgent", "asap", "immediately", "down", "outage", "legal", "lawsuit", "deadline"];
  if (severe.some((s) => t.includes(s))) return "high";
  if (classification === "support" && severe.length > 0 && (t.includes("production") || t.includes("customer"))) {
    return "medium";
  }
  return "low";
}

export function deterministicClassification(p: {
  body: string;
  name?: string | null;
  email?: string | null;
  subject?: string | null;
}): InquiryClassificationResult {
  const text = [p.subject, p.body].filter(Boolean).join("\n");
  const classification = classifyText(text);
  const truncated = p.body.replace(/\s+/g, " ").trim();
  return {
    classification,
    urgency: urgencyFor(text, classification),
    summary: truncated.length > 140 ? truncated.slice(0, 137) + "..." : truncated || "(empty body)",
    isLead: classification === "sales",
    company: null, // deterministic leg invents nothing — extraction is the LLM's job
    contactName: p.name ?? null,
    contactEmail: p.email ?? null,
    notes: "deterministic classification (keyword evidence)",
    degraded: true,
  };
}

const SCORE_SIGNALS: Array<{ re: RegExp; points: number; label: string }> = [
  { re: /@/, points: 25, label: "contact email present" },
  { re: /\b(ltd|llc|inc|gmbh|company|agency|studio|group|homes|real estate|estate)\b/i, points: 20, label: "company affiliation stated" },
  { re: /\b(phone|call|mobile|whatsapp|\+[0-9]{6,})\b/i, points: 15, label: "phone contact offered" },
  { re: /\b(pricing|quote|budget|demo|purchase|buy|contract)\b/i, points: 15, label: "commercial intent stated" },
  { re: /\b(timeline|deadline|this (week|month)|urgent|asap|q[1-4])\b/i, points: 10, label: "timeline pressure" },
  { re: /\b(recommend|proposal|scope|project)\b/i, points: 10, label: "project language" },
];

export function deterministicScore(p: {
  body: string;
  company?: string | null;
  contactName?: string | null;
  contactEmail?: string | null;
  contactPhone?: string | null;
}): LeadScoreResult {
  const text = p.body;
  let score = 0;
  const fired: string[] = [];
  if (p.contactEmail) {
    score += 25;
    fired.push("contact email present");
  }
  if (p.company) {
    score += 20;
    fired.push("company field present");
  }
  if (p.contactPhone) {
    score += 15;
    fired.push("phone contact offered");
  }
  for (const sig of SCORE_SIGNALS) {
    if (sig.re.test(text) && !fired.includes(sig.label)) {
      score += sig.points;
      fired.push(sig.label);
    }
  }
  score = clampScore(score);
  const band: ScoreBand = bandFor(score);
  return {
    leadScore: score,
    band,
    nextAction: score >= 70 ? "Reach out today — hot lead" : score >= 40 ? "Qualify on a call this week" : "Nurture: monitor for follow-up signals",
    rationale: fired.length > 0 ? fired.join("; ") : "no commercial signals present in the record",
    degraded: true,
  };
}

/* ------------------------------------------------------------------ */
/* LLM legs                                                            */
/* ------------------------------------------------------------------ */

const CLASSIFICATION_ALLOW: InquiryClassification[] = ["sales", "support", "spam", "general"];
const URGENCY_ALLOW: InquiryUrgency[] = ["low", "medium", "high"];

export interface InquiryLegInput {
  inquiryId: number;
  name: string | null;
  email: string | null;
  subject: string | null;
  body: string;
  transcript: Array<{ role: string; content: string }>;
}

export async function classifyInquiryWithLLM(
  llm: LLMClient,
  prompt: SalesPrompt,
  p: InquiryLegInput
): Promise<InquiryClassificationResult> {
  const transcript = p.transcript
    .slice(-10)
    .map((m) => `${m.role === "visitor" ? "Visitor" : "Assistant"}: ${m.content}`)
    .join("\n");
  const out = await completeJSON<Record<string, unknown>>(
    llm,
    [
      { role: "system", content: prompt.systemPrompt },
      {
        role: "user",
        content: [
          `Name: ${p.name ?? "(not given)"}`,
          `Email: ${p.email ?? "(not given)"}`,
          `Subject: ${p.subject ?? "(none)"}`,
          `Body: ${p.body}`,
          transcript ? `Recent conversation:\n${transcript}` : "",
        ].filter(Boolean).join("\n"),
      },
    ],
    {
      type: "object",
      properties: {
        classification: { type: "string", enum: CLASSIFICATION_ALLOW },
        urgency: { type: "string", enum: URGENCY_ALLOW },
        summary: { type: "string" },
        isLead: { type: "boolean" },
        company: { type: ["string", "null"] },
        contactName: { type: ["string", "null"] },
        contactEmail: { type: ["string", "null"] },
        notes: { type: "string" },
      },
      required: ["classification", "urgency", "summary"],
    } as never,
    { temperature: 0 }
  );
  const v = out.value ?? {};
  const classification = CLASSIFICATION_ALLOW.includes(v.classification as InquiryClassification)
    ? (v.classification as InquiryClassification)
    : "general";
  const urgency = URGENCY_ALLOW.includes(v.urgency as InquiryUrgency)
    ? (v.urgency as InquiryUrgency)
    : "low";
  const email = typeof v.contactEmail === "string" && v.contactEmail.includes("@") ? v.contactEmail.trim().slice(0, 320) : p.email ?? null;
  const summary = String(v.summary ?? "").trim().slice(0, 300) || deterministicClassification(p).summary;
  return {
    classification,
    urgency,
    summary,
    isLead: classification === "sales" || v.isLead === true,
    company: typeof v.company === "string" && v.company.trim() ? v.company.trim().slice(0, 200) : null,
    contactName: typeof v.contactName === "string" && v.contactName.trim() ? v.contactName.trim().slice(0, 200) : p.name ?? null,
    contactEmail: email,
    notes: typeof v.notes === "string" && v.notes.trim() ? v.notes.trim().slice(0, 500) : null,
    degraded: false,
  };
}

export interface LeadLegInput {
  company?: string | null;
  contactName?: string | null;
  contactEmail?: string | null;
  contactPhone?: string | null;
  body: string;
  conversationHighlights?: string[];
}

export async function scoreLeadWithLLM(
  llm: LLMClient,
  prompt: SalesPrompt,
  p: LeadLegInput
): Promise<LeadScoreResult> {
  const out = await completeJSON<Record<string, unknown>>(
    llm,
    [
      { role: "system", content: prompt.systemPrompt },
      {
        role: "user",
        content: [
          `Company: ${p.company ?? "(not given)"}`,
          `Contact: ${p.contactName ?? "(not given)"} <${p.contactEmail ?? "(no email)"}> ${p.contactPhone ?? ""}`,
          `Inquiry body: ${p.body}`,
          p.conversationHighlights?.length
            ? `Conversation highlights:\n${p.conversationHighlights.slice(-6).join("\n")}`
            : "",
        ].filter(Boolean).join("\n"),
      },
    ],
    {
      type: "object",
      properties: {
        leadScore: { type: "number" },
        band: { type: "string", enum: ["cold", "warm", "hot"] },
        nextAction: { type: "string" },
        rationale: { type: "string" },
      },
      required: ["leadScore", "band", "nextAction"],
    } as never,
    { temperature: 0 }
  );
  const v = out.value ?? {};
  const score = clampScore(v.leadScore);
  // The band is DERIVED from the clamped score — an LLM claiming "hot" with
  // score 12 cannot manufacture a band mismatch.
  const band: ScoreBand = bandFor(score);
  return {
    leadScore: score,
    band,
    nextAction: String(v.nextAction ?? "").trim().slice(0, 300) || "Review the inquiry",
    rationale: typeof v.rationale === "string" && v.rationale.trim() ? v.rationale.trim().slice(0, 500) : null,
    degraded: false,
  };
}
