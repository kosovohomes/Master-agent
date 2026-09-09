import type { AgentId } from "./types";

export interface AgentDef { id: AgentId; name: string; description: string }

export const AGENT_CATALOG: AgentDef[] = [
  { id: "research", name: "Research Agent", description: "Gathers industry/news intel and produces briefs." },
  { id: "marketing", name: "Marketing Agent", description: "Turns briefs into per-channel copy drafts." },
  { id: "sales", name: "Sales Agent", description: "Builds prospect lists and drafts outreach/partnership emails, records leads." },
  { id: "ambassador", name: "Ambassador Agent", description: "Awareness content: events, testimonials, mentions, replies." },
  { id: "customer_service", name: "Customer Service Agent", description: "Live chat answers grounded only in tenant RAG content." },
];

export function getAgent(id: AgentId): AgentDef {
  const def = AGENT_CATALOG.find((a) => a.id === id);
  if (!def) throw new Error(`unknown agent: ${id}`);
  return def;
}