/**
 * Phase 12 — sales workforce orchestration + task registration.
 *
 * processInquiry — THE §55 pipeline: classify → (auto-lead?) score →
 *   escalate-if-signals → events. Degrades honestly: the LLM leg is
 *   attempted only when `allowLlm` (the `sales` flag) and the gateway
 *   succeed; any failure falls to the deterministic floor. The inquiry is
 *   never left unlabeled when the deterministic leg runs — classified_by
 *   records WHICH leg labeled it.
 *
 * Escalation law (§55, acceptance: "inquiry → classified, scored lead with
 * human escalation"): urgency=high OR a hot lead → inquiry FSM → 'escalated'
 * + sales.escalated event which PAGES OPS (RULES in lib/tasks/events).
 *
 * Task machinery: `chat_answer` is registered so the async pathway exists
 * (the widget route calls handleChatAnswer synchronously; a supervisor-era
 * caller can enqueue the same work). It is deliberately NOT flag-gated —
 * chat is the widget's core, not a workforce leg.
 */
import { isFlagEnabled } from "../settings";
import { registerTaskHandler } from "../tasks/handlers";
import type { TaskHandler } from "../tasks/types";
import { emitEvent } from "../tasks/events";
import type { LLMClient } from "../ai/types";
import {
  deterministicClassification,
  deterministicScore,
  classifyInquiryWithLLM,
  scoreLeadWithLLM,
  loadAgentPrompt,
  INQUIRY_DEFAULT_PROMPT,
  LEAD_DEFAULT_PROMPT,
} from "./pipeline";
import {
  getInquiry,
  getLead,
  transitionInquiry,
  updateInquiryClassification,
  upsertLead,
  getMessages,
} from "./service";
import {
  requiresEscalation,
  SalesServiceError,
  type InquiryClassificationResult,
  type LeadScoreResult,
} from "./types";

export interface ProcessInquiryResult {
  inquiryId: number;
  classification: InquiryClassificationResult;
  score: LeadScoreResult | null;
  leadId: number | null;
  leadCreated: boolean;
  escalated: boolean;
}

export async function processInquiry(
  inquiryId: number,
  opts: { llm: LLMClient; allowLlm: boolean; createdByAgent?: string }
): Promise<ProcessInquiryResult> {
  const inquiry = await getInquiry(inquiryId);
  if (!inquiry) throw new SalesServiceError("NOT_FOUND", 404, `inquiry ${inquiryId} not found`);
  if (inquiry.status !== "new" && inquiry.status !== "classified") {
    throw new SalesServiceError("BAD_STATE", 409, `inquiry ${inquiryId} is ${inquiry.status}; classify requires new|classified`);
  }

  // --- classification leg (LLM → deterministic floor) ---
  const transcriptRows = inquiry.conversation_id ? await getMessages(inquiry.conversation_id, 20) : [];
  const transcript = transcriptRows.map((m) => ({ role: m.role, content: m.content }));
  const base = {
    inquiryId: inquiry.id,
    name: inquiry.name,
    email: inquiry.email,
    subject: inquiry.subject,
    body: inquiry.body,
    transcript,
  };

  let classification: InquiryClassificationResult = deterministicClassification(base);
  if (opts.allowLlm) {
    try {
      const prompt = await loadAgentPrompt("customer_inquiry", INQUIRY_DEFAULT_PROMPT);
      classification = await classifyInquiryWithLLM(opts.llm, prompt, base);
    } catch {
      /* degrade — quota/budget/timeout/garbage must never block intake */
    }
  }

  // --- apply classification to the FSM ---
  const metaPatch = {
    company: classification.company,
    extractedContact: classification.contactName ?? classification.contactEmail ?? null,
    classifiedAt: new Date().toISOString(),
    reclassified: inquiry.status === "classified",
  };
  const updated =
    inquiry.status === "new"
      ? await transitionInquiry(inquiry.id, "classified", {
          classification: classification.classification,
          urgency: classification.urgency,
          summary: classification.summary,
          classifiedBy: classification.degraded ? "deterministic" : "llm",
        })
      : await updateInquiryClassification(inquiry.id, {
          classification: classification.classification,
          urgency: classification.urgency,
          summary: classification.summary,
          classifiedBy: classification.degraded ? "deterministic" : "llm",
          metadata: metaPatch,
        });
  void updated;

  // --- lead leg: auto-lead ONLY with a dedupable email (§55 + ratchet) ---
  let score: LeadScoreResult | null = null;
  let leadId: number | null = null;
  let leadCreated = false;
  const email = classification.contactEmail ?? inquiry.email ?? null;
  if (classification.isLead && email) {
    const legInput = {
      company: classification.company,
      contactName: classification.contactName ?? inquiry.name,
      contactEmail: email,
      contactPhone: null as string | null,
      body: inquiry.body,
      conversationHighlights: transcript.slice(-6).map((m) => `${m.role}: ${m.content.slice(0, 300)}`),
    };
    score = deterministicScore(legInput);
    if (opts.allowLlm) {
      try {
        const prompt = await loadAgentPrompt("lead", LEAD_DEFAULT_PROMPT);
        score = await scoreLeadWithLLM(opts.llm, prompt, legInput);
      } catch {
        /* keep deterministic score */
      }
    }
    const { lead, created } = await upsertLead({
      businessUnitId: inquiry.business_unit_id,
      inquiryId: inquiry.id,
      company: classification.company,
      contactName: classification.contactName ?? inquiry.name,
      contactEmail: email,
      source: inquiry.source === "manual" ? "manual" : "widget",
      leadScore: score.leadScore,
      scoredBy: score.degraded ? "deterministic" : "llm",
      scoreRationale: score.rationale,
      nextAction: score.nextAction,
      createdByAgent: opts.createdByAgent ?? null,
      metadata: { inquiryId: inquiry.id, degraded: score.degraded },
    });
    leadId = lead.id;
    leadCreated = created;
    await emitEvent(inquiry.business_unit_id, "sales.lead_scored", {
      leadId: lead.id,
      inquiryId: inquiry.id,
      created,
      band: lead.score_band,
      score: lead.lead_score,
      degraded: score.degraded,
    });
  }

  // --- escalation law ---
  let escalated = false;
  if (requiresEscalation(classification, score)) {
    const current = await getInquiry(inquiryId);
    if (current && (current.status === "new" || current.status === "classified")) {
      await transitionInquiry(inquiry.id, "escalated", {});
      escalated = true;
      await emitEvent(inquiry.business_unit_id, "sales.escalated", {
        inquiryId: inquiry.id,
        leadId,
        urgency: classification.urgency,
        band: score?.band ?? null,
        reason: classification.urgency === "high" ? "high_urgency" : "hot_lead",
      });
    }
  }

  return { inquiryId: inquiry.id, classification, score, leadId, leadCreated, escalated };
}

/* ------------------------------------------------------------------ */
/* Task registration                                                   */
/* ------------------------------------------------------------------ */

export function makeChatAnswerHandler(): TaskHandler {
  return async ({ task }) => {
    const payload = task.payload as {
      tenantId?: number;
      question?: string;
      businessUnitId?: number | null;
      websiteId?: number | null;
      conversationId?: number | null;
      visitorId?: string | null;
    };
    if (!Number.isInteger(payload.tenantId) || typeof payload.question !== "string" || !payload.question.trim()) {
      throw new SalesServiceError("INVALID_PAYLOAD", 400, "chat_answer requires tenantId + question");
    }
    // Async pathway wiring mirrors the public route: gateway-attributed LLM
    // (imported lazily to keep test imports DB-light), knowledge-v2 flag
    // picks the retriever.
    const { ai } = await import("../ai");
    const { hybridRetrieve } = await import("../knowledge/retrieve");
    const { retrieve } = await import("../rag/retrieve");
    const { buIdForLegacyTenant } = await import("../agents/registry");
    const buId = payload.businessUnitId ?? (await buIdForLegacyTenant(payload.tenantId as number).catch(() => null));
    const llm = ai.withAttribution({ businessUnitId: buId, purpose: "chat_answer" });
    const knowledgeV2 = await isFlagEnabled("knowledge_v2", false);
    const { handleChatAnswer } = await import("./chat-pipeline");
    return handleChatAnswer(
      {
        tenantId: payload.tenantId as number,
        question: payload.question,
        businessUnitId: buId,
        websiteId: payload.websiteId ?? null,
        conversationId: payload.conversationId ?? null,
        visitorId: payload.visitorId ?? null,
      },
      {
        llm,
        retrieve: knowledgeV2
          ? (p) => hybridRetrieve(llm, { scope: { businessUnitId: buId, agentSlug: "customer_support", publicOnly: true }, query: p.query, topK: p.topK })
          : (p) => retrieve({ embed: (texts) => llm.embed(texts) }, p),
      }
    ).then((r) => ({ conversationId: r.conversationId, messageId: r.messageId, created: r.created, sources: r.sources.length }));
  };
}

export function registerSalesHandlers(): void {
  registerTaskHandler("chat_answer", makeChatAnswerHandler());
}

// Re-export for the acceptance drill (lead verification without a second query path).
export { getLead };
