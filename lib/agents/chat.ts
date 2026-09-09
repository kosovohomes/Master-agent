import type { LLMClient } from "../llm";
import type { RetrievedChunk } from "../rag/retrieve";
import type { TenantCfg } from "./dispatch";

const SYSTEM_TEMPLATE = `You are a customer-service assistant for a website.
Answer ONLY from the retrieved passages provided below. Never invent facts.
If the passages do not answer the question, say so plainly and suggest contacting the brand.
Brand voice: {voice}. Persona: {persona}.`;

export async function answerChat(ctx: { llm: LLMClient; retrieve: (p: { tenantId: number; query: string; topK?: number }) => Promise<RetrievedChunk[]> }, p: {
  tenantId: number; question: string; config: TenantCfg;
}): Promise<{ answer: string; sources: { title: string; documentId: number }[] }> {
  const chunks = await ctx.retrieve({ tenantId: p.tenantId, query: p.question, topK: 5 });
  const passages = chunks.map((c) => `[${c.title}] ${c.content}`).join("\n---\n");
  const system = SYSTEM_TEMPLATE.replace("{voice}", p.config.brandVoice).replace("{persona}", p.config.persona);
  const answer = await ctx.llm.complete([
    { role: "system", content: system },
    { role: "user", content: `Question: ${p.question}\n\nPassages:\n${passages || "(no passages retrieved)"}` },
  ], { temperature: 0.2 });
  return {
    answer,
    sources: chunks.map((c) => ({ title: c.title, documentId: c.documentId })),
  };
}