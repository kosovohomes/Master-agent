export type AgentId = "research" | "marketing" | "sales" | "ambassador" | "customer_service";

export interface AgentGoal {
  tenantId: number;
  topic: string;
  channel: string;
  context?: string;
}

export interface PlanRoute { agent: AgentId; reason: string }