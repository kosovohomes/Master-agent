import type { LLMClient } from "../ai/types";
import type { TenantCfg } from "./dispatch";

const SYSTEM_TEMPLATE = `You are a customer-service assistant for a website.
Answer ONLY from the retrieved passages provided below. Never invent facts.
If the passages do not answer the question, say so plainly and suggest contacting the brand.
Brand voice: {voice}. Persona: {persona}.`;

/**
 * Phase 5: chunks retrieved through the knowledge v2 hybrid engine carry
 * authority tier + provenance; the legacy tenant-only retriever returns plain
 * RetrievedChunk (all extension fields undefined). Both shapes flow through
 * here unchanged — citations are additive to the chat response.
 */
export type ChatChunk = {
  chunkId: number;
  documentId: number;
  title: string;
  content: string;
  /** Legacy retriever always sets tenantId; hybrid citations may omit it. */
  tenantId?: number;
  authorityTier?: number;
  sourceUrl?: string | null;
  documentUrl?: string | null;
  jurisdiction?: string | null;
  verificationStatus?: string;
  provenance?: Record<string, unknown> | null;
};

export interface ChatCitation {
  title: string;
  documentId: number;
  authorityTier: number | null;
  sourceUrl: string | null;
  documentUrl: string | null;
  jurisdiction: string | null;
  verificationStatus: string | null;
  provenance: Record<string, unknown> | null;
}

export async function answerChat(ctx: { llm: LLMClient; retrieve: (p: { tenantId: number; query: string; topK?: number }) => Promise<ChatChunk[]> }, p: {
  tenantId: number; question: string; config: TenantCfg;
}): Promise<{ answer: string; sources: ChatCitation[] }> {
  const chunks = await ctx.retrieve({ tenantId: p.tenantId, query: p.question, topK: 5 });
  const passages = chunks
    .map((c) =>
      c.authorityTier != null
        ? `[${c.title} — authority tier T${c.authorityTier}] ${c.content}`
        : `[${c.title}] ${c.content}`
    )
    .join("\n---\n");
  const system = SYSTEM_TEMPLATE.replace("{voice}", p.config.brandVoice).replace("{persona}", p.config.persona);
  const answer = await ctx.llm.complete([
    { role: "system", content: system },
    { role: "user", content: `Question: ${p.question}\n\nPassages:\n${passages || "(no passages retrieved)"}` },
  ], { temperature: 0.2 });
  return {
    answer,
    sources: chunks.map((c) => ({
      title: c.title,
      documentId: c.documentId,
      authorityTier: c.authorityTier ?? null,
      sourceUrl: c.sourceUrl ?? null,
      documentUrl: c.documentUrl ?? null,
      jurisdiction: c.jurisdiction ?? null,
      verificationStatus: c.verificationStatus ?? null,
      provenance: c.provenance ?? null,
    })),
  };
}
