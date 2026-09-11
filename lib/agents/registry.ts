/**
 * Agent Registry (Phase 2 — Phase 0.5 §6.4 extensibility invariant).
 *
 * Agents are DATA. Adding an agent = one `agents` row + one `agent_versions`
 * row + tool/permission grants + optional executor binding — zero
 * core-platform edits. Two executor kinds exist:
 *   (a) `bound`   — TypeScript functions registered by slug (the pre-registry
 *                   five; behavior preserved exactly)
 *   (b) `llm`     — the generic executor: runs any registry agent from its
 *                   versioned prompt + tools + output schema
 *
 * Enablement is layered so flipping a flag changes behavior within one run,
 * with zero deploys:
 *   agents.status            global directory switch (active/disabled/archived)
 *   business_unit_agents     per-BU on/off (absent row = follow global status)
 *   feature_flags            emergency kill-switch `disable_agent:<slug>`
 *     (checked via lib/settings.isFlagEnabled — works even if the registry
 *      itself is misbehaving)
 */
import crypto from "node:crypto";
import { query } from "../db";
import { isFlagEnabled } from "../settings";

export type AgentStatus = "active" | "disabled" | "archived";
export type AgentKind = "worker" | "supervisor" | "service";
export type ExecutorKind = "bound" | "llm";

export interface RegistryAgent {
  id: number;
  slug: string;
  name: string;
  description: string;
  agentKind: AgentKind;
  executorKind: ExecutorKind;
  status: AgentStatus;
  metadata: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
}

export interface AgentVersionRow {
  id: number;
  agentId: number;
  version: number;
  systemPrompt: string;
  config: Record<string, unknown>;
  outputSchema: Record<string, unknown> | null;
  changelog: string | null;
  createdByUserId: number | null;
  createdAt: string;
}

interface AgentDbRow {
  id: number; slug: string; name: string; description: string;
  agent_kind: AgentKind; executor_kind: ExecutorKind; status: AgentStatus;
  metadata: Record<string, unknown>; created_at: string; updated_at: string;
}

function toAgent(r: AgentDbRow): RegistryAgent {
  return {
    id: r.id, slug: r.slug, name: r.name, description: r.description,
    agentKind: r.agent_kind, executorKind: r.executor_kind, status: r.status,
    metadata: r.metadata ?? {}, createdAt: r.created_at, updatedAt: r.updated_at,
  };
}

export async function listAgents(): Promise<RegistryAgent[]> {
  const rows = await query<AgentDbRow>("SELECT * FROM agents ORDER BY status ASC, slug ASC");
  return rows.map(toAgent);
}

export async function getAgentBySlug(slug: string): Promise<RegistryAgent | null> {
  const rows = await query<AgentDbRow>("SELECT * FROM agents WHERE slug = $1", [slug]);
  return rows[0] ? toAgent(rows[0]) : null;
}

export async function getAgentById(id: number): Promise<RegistryAgent | null> {
  const rows = await query<AgentDbRow>("SELECT * FROM agents WHERE id = $1", [id]);
  return rows[0] ? toAgent(rows[0]) : null;
}

export async function setAgentStatus(agentId: number, status: AgentStatus): Promise<RegistryAgent | null> {
  const rows = await query<AgentDbRow>(
    "UPDATE agents SET status = $2, updated_at = now() WHERE id = $1 RETURNING *",
    [agentId, status]
  );
  return rows[0] ? toAgent(rows[0]) : null;
}

// ---------- versions ----------

export async function currentVersion(agentId: number): Promise<AgentVersionRow | null> {
  const rows = await query<{
    id: number; agent_id: number; version: number; system_prompt: string;
    config: Record<string, unknown>; output_schema: Record<string, unknown> | null;
    changelog: string | null; created_by_user_id: number | null; created_at: string;
  }>(
    "SELECT * FROM agent_versions WHERE agent_id = $1 ORDER BY version DESC LIMIT 1",
    [agentId]
  );
  const r = rows[0];
  return r
    ? {
        id: r.id, agentId: r.agent_id, version: r.version, systemPrompt: r.system_prompt,
        config: r.config ?? {}, outputSchema: r.output_schema, changelog: r.changelog,
        createdByUserId: r.created_by_user_id, createdAt: r.created_at,
      }
    : null;
}

export async function listVersions(agentId: number): Promise<AgentVersionRow[]> {
  const rows = await query<{
    id: number; agent_id: number; version: number; system_prompt: string;
    config: Record<string, unknown>; output_schema: Record<string, unknown> | null;
    changelog: string | null; created_by_user_id: number | null; created_at: string;
  }>(
    "SELECT * FROM agent_versions WHERE agent_id = $1 ORDER BY version DESC",
    [agentId]
  );
  return rows.map((r) => ({
    id: r.id, agentId: r.agent_id, version: r.version, systemPrompt: r.system_prompt,
    config: r.config ?? {}, outputSchema: r.output_schema, changelog: r.changelog,
    createdByUserId: r.created_by_user_id, createdAt: r.created_at,
  }));
}

export async function createAgentVersion(p: {
  agentId: number;
  systemPrompt: string;
  config?: Record<string, unknown>;
  outputSchema?: Record<string, unknown> | null;
  changelog?: string;
  createdByUserId?: number | null;
}): Promise<AgentVersionRow> {
  const [maxRow] = await query<{ v: number | null }>(
    "SELECT max(version) AS v FROM agent_versions WHERE agent_id = $1",
    [p.agentId]
  );
  const version = (maxRow?.v ?? 0) + 1;
  const rows = await query<{ id: number }>(
    `INSERT INTO agent_versions (agent_id, version, system_prompt, config, output_schema, changelog, created_by_user_id)
     VALUES ($1, $2, $3, $4::jsonb, $5::jsonb, $6, $7) RETURNING id`,
    [
      p.agentId,
      version,
      p.systemPrompt,
      JSON.stringify(p.config ?? {}),
      p.outputSchema ? JSON.stringify(p.outputSchema) : null,
      p.changelog ?? null,
      p.createdByUserId ?? null,
    ]
  );
  const created = await query<AgentVersionRow & { agent_id: number; system_prompt: string; output_schema: Record<string, unknown> | null; changelog: string | null; created_by_user_id: number | null; created_at: string; config: Record<string, unknown> }>(
    "SELECT * FROM agent_versions WHERE id = $1",
    [rows[0].id]
  );
  const r = created[0];
  return {
    id: r.id, agentId: r.agent_id, version: r.version, systemPrompt: r.system_prompt,
    config: r.config ?? {}, outputSchema: r.output_schema, changelog: r.changelog,
    createdByUserId: r.created_by_user_id, createdAt: r.created_at,
  };
}

// ---------- per-BU enablement ----------

export interface BuAgentLink {
  businessUnitId: number;
  agentId: number;
  enabled: boolean;
  config: Record<string, unknown>;
}

export async function listBuAgents(businessUnitId: number): Promise<BuAgentLink[]> {
  const rows = await query<{ business_unit_id: number; agent_id: number; enabled: boolean; config: Record<string, unknown> }>(
    "SELECT business_unit_id, agent_id, enabled, config FROM business_unit_agents WHERE business_unit_id = $1 ORDER BY agent_id",
    [businessUnitId]
  );
  return rows.map((r) => ({ businessUnitId: r.business_unit_id, agentId: r.agent_id, enabled: r.enabled, config: r.config ?? {} }));
}

export async function setBuAgent(businessUnitId: number, agentId: number, enabled: boolean, config?: Record<string, unknown>): Promise<BuAgentLink> {
  const rows = await query<{ business_unit_id: number; agent_id: number; enabled: boolean; config: Record<string, unknown> }>(
    `INSERT INTO business_unit_agents (business_unit_id, agent_id, enabled, config)
     VALUES ($1, $2, $3, $4::jsonb)
     ON CONFLICT (business_unit_id, agent_id) DO UPDATE
       SET enabled = EXCLUDED.enabled,
           config = EXCLUDED.config,
           updated_at = now()
     RETURNING business_unit_id, agent_id, enabled, config`,
    [businessUnitId, agentId, enabled, JSON.stringify(config ?? {})]
  );
  const r = rows[0];
  return { businessUnitId: r.business_unit_id, agentId: r.agent_id, enabled: r.enabled, config: r.config ?? {} };
}

// ---------- runnability (the ≤1-run propagation contract) ----------

export type RunnableCheck = { ok: true } | { ok: false; code: "AGENT_NOT_FOUND" | "AGENT_DISABLED" | "AGENT_ARCHIVED" | "AGENT_BU_DISABLED" | "AGENT_KILL_SWITCH" };

/**
 * Whether an agent may run right now for a business unit. Absence of a
 * business_units row (legacy tenants created before the registry) means the
 * per-BU layer is skipped and the global status governs.
 */
export async function checkRunnable(slug: string, businessUnitId: number | null): Promise<RunnableCheck> {
  if (await isFlagEnabled(`disable_agent:${slug}`, false)) {
    return { ok: false, code: "AGENT_KILL_SWITCH" };
  }
  const agent = await getAgentBySlug(slug);
  if (!agent) return { ok: false, code: "AGENT_NOT_FOUND" };
  if (agent.status === "disabled") return { ok: false, code: "AGENT_DISABLED" };
  if (agent.status === "archived") return { ok: false, code: "AGENT_ARCHIVED" };
  if (businessUnitId != null) {
    const rows = await query<{ enabled: boolean }>(
      "SELECT enabled FROM business_unit_agents WHERE business_unit_id = $1 AND agent_id = $2",
      [businessUnitId, agent.id]
    );
    if (rows.length > 0 && !rows[0].enabled) return { ok: false, code: "AGENT_BU_DISABLED" };
  }
  return { ok: true };
}

/** Legacy-tenant → BU mapping (registry + attribution need the BU id). */
export async function buIdForLegacyTenant(tenantId: number): Promise<number | null> {
  const rows = await query<{ id: number }>(
    "SELECT id FROM business_units WHERE legacy_tenant_id = $1",
    [tenantId]
  );
  return rows[0]?.id ?? null;
}

// ---------- machine identities (§75) ----------

export interface AgentIdentity {
  id: number;
  agentId: number;
  keyId: string;
  displayName: string | null;
  status: "active" | "revoked";
  createdAt: string;
  lastUsedAt: string | null;
}

export async function listAgentIdentities(agentId: number): Promise<AgentIdentity[]> {
  const rows = await query<{
    id: number; agent_id: number; key_id: string; display_name: string | null;
    status: "active" | "revoked"; created_at: string; last_used_at: string | null;
  }>(
    "SELECT * FROM agent_identities WHERE agent_id = $1 ORDER BY created_at DESC",
    [agentId]
  );
  return rows.map((r) => ({
    id: r.id, agentId: r.agent_id, keyId: r.key_id, displayName: r.display_name,
    status: r.status, createdAt: r.created_at, lastUsedAt: r.last_used_at,
  }));
}

export async function createAgentIdentity(agentId: number, keyId: string, displayName?: string): Promise<AgentIdentity> {
  await query(
    "INSERT INTO agent_identities (agent_id, key_id, display_name) VALUES ($1, $2, $3)",
    [agentId, keyId, displayName ?? null]
  );
  const rows = await query<{ id: number; agent_id: number; key_id: string; display_name: string | null; status: "active" | "revoked"; created_at: string; last_used_at: string | null }>(
    "SELECT * FROM agent_identities WHERE agent_id = $1 AND key_id = $2",
    [agentId, keyId]
  );
  const r = rows[0];
  return { id: r.id, agentId: r.agent_id, keyId: r.key_id, displayName: r.display_name, status: r.status, createdAt: r.created_at, lastUsedAt: r.last_used_at };
}

export async function revokeAgentIdentity(identityId: number): Promise<boolean> {
  const rows = await query<{ id: number }>(
    "UPDATE agent_identities SET status = 'revoked' WHERE id = $1 RETURNING id",
    [identityId]
  );
  return rows.length > 0;
}

/** Real prompt hash for run attribution (C-14): sha-256 of the system prompt. */
export function promptHash(systemPrompt: string): string {
  return crypto.createHash("sha256").update(systemPrompt).digest("hex");
}
