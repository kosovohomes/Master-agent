export type AgentId = "research" | "marketing" | "sales" | "ambassador" | "customer_service";

export interface AgentGoal {
  tenantId: number;
  topic: string;
  channel: string;
  context?: string;
}

/**
 * Phase 3 (C-16): the router is promoted to an explicit classifier.
 * `fallback: true` means "no worker matched — this is the permissive
 * default route". Callers decide: the manual API runs it (legacy UX),
 * the task engine escalates (no silent wrong work).
 */
export interface PlanRoute { agent: AgentId; reason: string; fallback: boolean }
