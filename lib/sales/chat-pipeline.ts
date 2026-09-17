/**
 * Phase 12 — chat answer pipeline (the widget core, now with persistence).
 *
 * `handleChatAnswer` is the ONE implementation of "answer a widget chat
 * turn": conversation create/verify → persist visitor message → RAG-grounded
 * answer (answerChat, UNCHANGED since Phase 5) → persist assistant message
 * with citations. The public route is a thin façade over this function, and
 * the `chat_answer` task handler (lib/sales/tasks.ts) runs the SAME function
 * asynchronously — the chat route has become the façade the roadmap asks
 * for while the widget keeps its synchronous UX.
 *
 * Security invariants:
 *  - Conversation verification: a presented conversationId MUST belong to
 *    the tenant's BU (and to the same website when the site is registered)
 *    — visitors cannot read or append to another site's conversation
 *    (§101 customer isolation).
 *  - visitor_id is a client-generated random UUID (never a fingerprint).
 *  - Only visitor/assistant roles are persisted — the system prompt and
 *    retrieval internals never touch the messages table (§65).
 */
import { answerChat, type ChatCitation } from "../agents/chat";
import { getTenantConfig } from "../agents/dispatch";
import {
  appendMessage,
  createConversation,
  getConversation,
  getMessages,
} from "./service";
import { SalesServiceError } from "./types";

export interface ChatAnswerResult {
  answer: string;
  sources: ChatCitation[];
  conversationId: number;
  messageId: number | null;
  created: boolean;
}

export interface HandleChatAnswerInput {
  tenantId: number;
  question: string;
  businessUnitId: number | null;
  websiteId?: number | null;
  conversationId?: number | null;
  visitorId?: string | null;
}

export interface HandleChatAnswerDeps {
  llm: Parameters<typeof answerChat>[0]["llm"];
  retrieve: Parameters<typeof answerChat>[0]["retrieve"];
}

const MAX_VISITOR_ID = 64;
const MAX_STORED_CONTENT = 8000;

export async function handleChatAnswer(
  input: HandleChatAnswerInput,
  deps: HandleChatAnswerDeps
): Promise<ChatAnswerResult> {
  const config = await getTenantConfig(input.tenantId);
  const question = input.question.trim().slice(0, MAX_STORED_CONTENT);

  // --- conversation resolve-or-create (verified) ---
  let conversationId = input.conversationId ?? null;
  let created = false;
  if (conversationId != null) {
    const conv = await getConversation(conversationId);
    if (!conv) throw new SalesServiceError("CONVERSATION_NOT_FOUND", 404, `conversation ${conversationId} not found`);
    if (conv.business_unit_id !== input.businessUnitId) {
      // Tenant mismatch — never leak cross-tenant existence or content.
      throw new SalesServiceError("CONVERSATION_FORBIDDEN", 403, "conversation does not belong to this site");
    }
    if (
      input.websiteId != null &&
      conv.website_id != null &&
      conv.website_id !== input.websiteId
    ) {
      throw new SalesServiceError("CONVERSATION_FORBIDDEN", 403, "conversation does not belong to this website");
    }
    if (conv.status !== "active") {
      // Closed/escalated conversations keep their history but refuse appends —
      // the widget starts a fresh conversation instead of failing the UX.
      conversationId = null;
    }
  }
  if (conversationId == null) {
    const visitorId = (input.visitorId ?? "").slice(0, MAX_VISITOR_ID) || null;
    const conv = await createConversation({
      businessUnitId: input.businessUnitId ?? (await requireBuId(input.tenantId)),
      websiteId: input.websiteId ?? null,
      visitorId,
      channel: "widget",
    });
    conversationId = conv.id;
    created = true;
  }

  // --- persist visitor turn BEFORE answering (crash-safe history) ---
  const visitorMsg = await appendMessage({
    conversationId,
    role: "visitor",
    content: question,
  });

  // --- answer (answerChat: RAG-grounded, refuses fabrication) ---
  const result = await answerChat(
    { llm: deps.llm, retrieve: deps.retrieve },
    { tenantId: input.tenantId, question, config }
  );

  const assistantMsg = await appendMessage({
    conversationId,
    role: "assistant",
    content: result.answer.slice(0, MAX_STORED_CONTENT),
    citations: result.sources,
    metadata: { source: "answerChat" },
  });

  return {
    answer: result.answer,
    sources: result.sources,
    conversationId,
    messageId: assistantMsg.id,
    created,
  };
}

async function requireBuId(tenantId: number): Promise<number> {
  const { buIdForLegacyTenant } = await import("../agents/registry");
  const buId = await buIdForLegacyTenant(tenantId).catch(() => null);
  if (buId == null) {
    throw new SalesServiceError("NO_BUSINESS_UNIT", 500, `tenant ${tenantId} has no business unit mapping`);
  }
  return buId;
}

/** Transcript for the classification leg — plain visitor/assistant rows. */
export async function transcriptFor(conversationId: number | null | undefined) {
  if (conversationId == null) return [];
  const rows = await getMessages(conversationId, 20);
  return rows.map((m) => ({ role: m.role, content: m.content }));
}
