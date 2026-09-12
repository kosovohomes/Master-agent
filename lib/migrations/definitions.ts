/**
 * Phase 1 migration ledger — one entry per version, strictly additive.
 *
 * Authority: PHASE-0.5-Final-Architecture-Reconciliation.md §12.3:
 *   001 schema_migrations · 002 audit_logs · 003 users, sessions ·
 *   004 roles/permissions (+seed) · 005 system_settings, feature_flags ·
 *   006 tenant_usage_daily · 007 business_units + websites (+1:1 backfill) ·
 *   008 website_integrations, website_capabilities (structure only) ·
 *   009 channels ADD target/metadata/display_name · 010 approvals ADD reviewer_user_id
 * Phase 2 (§11 P2 / §5.2):
 *   011 rate_limit_buckets (DB-backed limiter pull-forward) ·
 *   012 agents registry (agents/agent_versions/agent_tools/agent_permissions/
 *       business_unit_agents/agent_identities + registry seed + agents.manage) ·
 *   013 agent_runs run-attribution ALTERs + topic backfill (C-14) ·
 *   014 channels key-id envelope cutover point (SEC-L2) ·
 *   015 RLS scaffolding on BU/website tables (SEC-L1 v1)
 * Phase 3 (§11 P3):
 *   016 task engine (tasks/task_steps — durable queue, §140) ·
 *   017 workflows/workflow_runs + scheduled_publishing_sweep seed (Workflow #1) ·
 *   018 events/notifications (event bus + notifications v1) ·
 *   019 content_publications (idempotent publication ledger; outbox write-stop)
 *
 * 000 records the pre-existing AgentOS baseline (the 11 legacy tables) so the
 * ledger is complete even on a database provisioned from empty. On the live
 * deployment those tables already exist and 000 is a no-op.
 *
 * Rules (Phase 0.5 §5): additive-first, no renames, no destructive change,
 * every entry idempotent and safe to re-run.
 */
import { MIGRATION_DDL } from "../migrations-legacy";

export interface MigrationDef {
  version: string;
  name: string;
  /** Canonical migration text — the checksum basis recorded in the ledger. */
  source: string;
  /** Optional imperative implementation (defaults to running `source`). */
  up?: (q: (sql: string, params?: unknown[]) => Promise<any[]>) => Promise<void>;
}

const M_000_LEGACY_BASELINE = `
-- AgentOS legacy baseline (11 tables), recorded verbatim from the original
-- unversioned schema. IF NOT EXISTS everywhere: no-op where it already exists.
${MIGRATION_DDL}`;

const M_001_SCHEMA_MIGRATIONS = `
CREATE TABLE IF NOT EXISTS schema_migrations (
  version TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  checksum TEXT NOT NULL,
  applied_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  applied_by TEXT NOT NULL DEFAULT 'migration-runner'
);`;

const M_002_AUDIT_LOGS = `
CREATE TABLE IF NOT EXISTS audit_logs (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  actor_type TEXT NOT NULL CHECK (actor_type IN ('user','system','agent','anonymous')),
  actor_id BIGINT,
  actor_label TEXT,
  action TEXT NOT NULL,
  resource TEXT,
  resource_id TEXT,
  result TEXT NOT NULL DEFAULT 'success' CHECK (result IN ('success','failure','denied')),
  request_id TEXT,
  ip TEXT,
  metadata JSONB
);
CREATE INDEX IF NOT EXISTS audit_logs_created_idx ON audit_logs (created_at DESC);
CREATE INDEX IF NOT EXISTS audit_logs_actor_idx ON audit_logs (actor_id);
CREATE INDEX IF NOT EXISTS audit_logs_action_idx ON audit_logs (action);`;

const M_003_USERS_SESSIONS = `
CREATE TABLE IF NOT EXISTS users (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  email TEXT NOT NULL UNIQUE,
  display_name TEXT,
  password_hash TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','disabled')),
  failed_login_count INT NOT NULL DEFAULT 0,
  locked_until TIMESTAMPTZ,
  last_login_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS sessions (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash TEXT NOT NULL UNIQUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_seen_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at TIMESTAMPTZ NOT NULL,
  ip TEXT,
  user_agent TEXT
);
CREATE INDEX IF NOT EXISTS sessions_user_idx ON sessions (user_id);
CREATE INDEX IF NOT EXISTS sessions_expires_idx ON sessions (expires_at);`;

const M_004_RBAC = `
CREATE TABLE IF NOT EXISTS roles (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  key TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  is_active BOOLEAN NOT NULL DEFAULT false
);
CREATE TABLE IF NOT EXISTS permissions (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  key TEXT NOT NULL UNIQUE
);
CREATE TABLE IF NOT EXISTS role_permissions (
  role_id BIGINT NOT NULL REFERENCES roles(id) ON DELETE CASCADE,
  permission_id BIGINT NOT NULL REFERENCES permissions(id) ON DELETE CASCADE,
  PRIMARY KEY (role_id, permission_id)
);
CREATE TABLE IF NOT EXISTS user_roles (
  user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role_id BIGINT NOT NULL REFERENCES roles(id) ON DELETE CASCADE,
  PRIMARY KEY (user_id, role_id)
);

INSERT INTO roles (key, name, is_active) VALUES
  ('owner',         'Owner',         true),
  ('administrator', 'Administrator', true),
  ('operator',      'Operator',      true),
  ('reviewer',      'Reviewer',      true),
  ('analyst',       'Analyst',       false),
  ('developer',     'Developer',     false),
  ('agent',         'Agent',         false)
ON CONFLICT (key) DO NOTHING;

INSERT INTO permissions (key) VALUES
  ('bu.manage'),
  ('website.manage'),
  ('drafts.read'),
  ('drafts.approve'),
  ('drafts.schedule'),
  ('agents.run'),
  ('users.manage'),
  ('settings.manage'),
  ('audit.read'),
  ('ops.run')
ON CONFLICT (key) DO NOTHING;

-- owner: everything. administrator: all day-to-day except users.manage.
-- operator: scheduling + execution. reviewer: read + approve.
INSERT INTO role_permissions (role_id, permission_id)
SELECT r.id, p.id FROM roles r JOIN permissions p ON p.key = ANY(ARRAY[
  'bu.manage','website.manage','drafts.read','drafts.approve','drafts.schedule',
  'agents.run','users.manage','settings.manage','audit.read','ops.run'
]::text[])
WHERE r.key = 'owner'
ON CONFLICT DO NOTHING;

INSERT INTO role_permissions (role_id, permission_id)
SELECT r.id, p.id FROM roles r JOIN permissions p ON p.key = ANY(ARRAY[
  'bu.manage','website.manage','drafts.read','drafts.approve','drafts.schedule',
  'agents.run','settings.manage','audit.read'
]::text[])
WHERE r.key = 'administrator'
ON CONFLICT DO NOTHING;

INSERT INTO role_permissions (role_id, permission_id)
SELECT r.id, p.id FROM roles r JOIN permissions p ON p.key = ANY(ARRAY[
  'drafts.read','drafts.schedule','agents.run'
]::text[])
WHERE r.key = 'operator'
ON CONFLICT DO NOTHING;

INSERT INTO role_permissions (role_id, permission_id)
SELECT r.id, p.id FROM roles r JOIN permissions p ON p.key = ANY(ARRAY[
  'drafts.read','drafts.approve'
]::text[])
WHERE r.key = 'reviewer'
ON CONFLICT DO NOTHING;`;

const M_005_SETTINGS_FLAGS = `
CREATE TABLE IF NOT EXISTS system_settings (
  key TEXT PRIMARY KEY,
  value JSONB NOT NULL,
  description TEXT,
  updated_by_user_id BIGINT,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS feature_flags (
  key TEXT PRIMARY KEY,
  enabled BOOLEAN NOT NULL DEFAULT false,
  emergency BOOLEAN NOT NULL DEFAULT false,
  description TEXT,
  updated_by_user_id BIGINT,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
-- Seed state: emergency stops off; legacy bearer auth ON during the Phase 1
-- transition window (session-or-legacy-bearer on guarded endpoints).
INSERT INTO feature_flags (key, enabled, emergency, description) VALUES
  ('stop_all_agents',    false, true,  'Emergency stop: blocks all agent LLM execution (agents/run, public chat)'),
  ('disable_publishing', false, true,  'Emergency stop: blocks the scheduled publishing sweep'),
  ('legacy_bearer_auth', true,  false, 'Transition: legacy ADMIN_PASSWORD/OPS_TOKEN bearer accepted on guarded admin endpoints alongside sessions')
ON CONFLICT (key) DO NOTHING;`;

const M_006_TENANT_USAGE_DAILY = `
CREATE TABLE IF NOT EXISTS tenant_usage_daily (
  day DATE NOT NULL,
  tenant_id BIGINT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  llm_calls INT NOT NULL DEFAULT 0,
  prompt_tokens BIGINT NOT NULL DEFAULT 0,
  completion_tokens BIGINT NOT NULL DEFAULT 0,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (day, tenant_id)
);`;

const M_007_BUSINESS_UNITS_WEBSITES = `
CREATE TABLE IF NOT EXISTS business_units (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  slug TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','suspended')),
  brand_voice TEXT NOT NULL DEFAULT '',
  persona TEXT NOT NULL DEFAULT '',
  audience TEXT NOT NULL DEFAULT '',
  contact_email TEXT,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  -- Legacy mapping: one BU per pre-existing tenants row. UNIQUE + nullable:
  -- legacy tenants map exactly once; NEW business units (no legacy tenant) are
  -- supported by design ("arbitrary future businesses" — Phase 0.5 §5.3).
  legacy_tenant_id BIGINT UNIQUE REFERENCES tenants(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS websites (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  business_unit_id BIGINT NOT NULL REFERENCES business_units(id) ON DELETE CASCADE,
  slug TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  domain TEXT,
  environment TEXT NOT NULL DEFAULT 'production' CHECK (environment IN ('production','staging','development')),
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','inactive','pending')),
  default_locale TEXT NOT NULL DEFAULT 'en',
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS websites_bu_idx ON websites (business_unit_id);

-- BU-scoped role assignments (added here because user_roles exists since 004).
ALTER TABLE user_roles ADD COLUMN IF NOT EXISTS business_unit_id BIGINT REFERENCES business_units(id);

-- 1:1 legacy backfill, inside this migration's transaction:
-- one business unit per existing tenant (brand fields copied from tenant_config),
-- then one default production website per business unit.
INSERT INTO business_units (slug, name, brand_voice, persona, audience, legacy_tenant_id)
SELECT t.slug, t.name,
       COALESCE(tc.brand_voice, ''), COALESCE(tc.persona, ''), COALESCE(tc.audience, ''),
       t.id
FROM tenants t
LEFT JOIN tenant_config tc ON tc.tenant_id = t.id
ON CONFLICT (legacy_tenant_id) DO NOTHING;

INSERT INTO websites (business_unit_id, slug, name, environment, status)
SELECT bu.id, bu.slug, bu.name || ' primary site', 'production', 'active'
FROM business_units bu
WHERE NOT EXISTS (SELECT 1 FROM websites w WHERE w.business_unit_id = bu.id);`;

const M_008_WEBSITE_INTEGRATIONS_CAPABILITIES = `
CREATE TABLE IF NOT EXISTS website_integrations (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  website_id BIGINT NOT NULL REFERENCES websites(id) ON DELETE CASCADE,
  integration_type TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','disabled','error')),
  config JSONB NOT NULL DEFAULT '{}'::jsonb,
  credentials_encrypted TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (website_id, integration_type)
);
CREATE TABLE IF NOT EXISTS website_capabilities (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  website_id BIGINT NOT NULL REFERENCES websites(id) ON DELETE CASCADE,
  capability TEXT NOT NULL,
  enabled BOOLEAN NOT NULL DEFAULT false,
  config JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (website_id, capability)
);
CREATE INDEX IF NOT EXISTS website_integrations_website_idx ON website_integrations (website_id);
CREATE INDEX IF NOT EXISTS website_capabilities_website_idx ON website_capabilities (website_id);`;

const M_009_CHANNELS_ADD_COLUMNS = `
ALTER TABLE channels ADD COLUMN IF NOT EXISTS target TEXT;
ALTER TABLE channels ADD COLUMN IF NOT EXISTS metadata JSONB NOT NULL DEFAULT '{}'::jsonb;
ALTER TABLE channels ADD COLUMN IF NOT EXISTS display_name TEXT;`;

const M_010_APPROVALS_REVIEWER = `
ALTER TABLE approvals ADD COLUMN IF NOT EXISTS reviewer_user_id BIGINT REFERENCES users(id) ON DELETE SET NULL;`;

/**
 * Phase 2 pull-forward (tech-lead decision, documented in the Phase 2 report):
 * the Phase 1 in-memory rate-limit buckets are per serverless instance, which
 * gives no global guarantee for brute-force-sensitive endpoints (login). A
 * single-row atomic upsert fixed-window bucket is cheap and correct; the
 * Phase 3 job engine may evolve it into the shared limiter with sliding
 * windows if needed.
 */
const M_011_RATE_LIMIT_BUCKETS = `
CREATE TABLE IF NOT EXISTS rate_limit_buckets (
  key TEXT PRIMARY KEY,
  count INT NOT NULL DEFAULT 0,
  window_start TIMESTAMPTZ NOT NULL DEFAULT now()
);`;

/**
 * Phase 2 (Phase 0.5 §5.2 P2 / §6): agents become data.
 *  - agents: registry directory (slug, kind, executor binding, status)
 *  - agent_versions: immutable versioned prompts/config (UNIQUE(agent_id, version))
 *  - agent_tools: tool grants — REGISTRY ROWS ONLY in P2 (no side-effect execution)
 *  - agent_permissions: what an agent may do (joined to permissions from 004)
 *  - business_unit_agents: per-BU enablement without deploys (§135 P2)
 *  - agent_identities: machine identities for future agent callers (§75)
 * Seeded: the four surviving current agents active/bound; the remaining
 * Phase 0.5 §6.2 registry seeded disabled with placeholders (registry-first);
 * ambassador intentionally NOT a registry row (folded — executor retained as
 * a prompt variant of the content path per §6.1).
 * Also seeds the agents.manage permission (owner + administrator).
 */
const M_012_AGENTS_REGISTRY = `
CREATE TABLE IF NOT EXISTS agents (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  slug TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  agent_kind TEXT NOT NULL DEFAULT 'worker' CHECK (agent_kind IN ('worker','supervisor','service')),
  executor_kind TEXT NOT NULL DEFAULT 'bound' CHECK (executor_kind IN ('bound','llm')),
  status TEXT NOT NULL DEFAULT 'disabled' CHECK (status IN ('active','disabled','archived')),
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS agent_versions (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  agent_id BIGINT NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  version INT NOT NULL,
  system_prompt TEXT NOT NULL DEFAULT '',
  config JSONB NOT NULL DEFAULT '{}'::jsonb,
  output_schema JSONB,
  changelog TEXT,
  created_by_user_id BIGINT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (agent_id, version)
);
CREATE TABLE IF NOT EXISTS agent_tools (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  agent_id BIGINT NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  tool_key TEXT NOT NULL,
  config JSONB NOT NULL DEFAULT '{}'::jsonb,
  enabled BOOLEAN NOT NULL DEFAULT true,
  UNIQUE (agent_id, tool_key)
);
CREATE TABLE IF NOT EXISTS agent_permissions (
  agent_id BIGINT NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  permission_id BIGINT NOT NULL REFERENCES permissions(id) ON DELETE CASCADE,
  PRIMARY KEY (agent_id, permission_id)
);
CREATE TABLE IF NOT EXISTS business_unit_agents (
  business_unit_id BIGINT NOT NULL REFERENCES business_units(id) ON DELETE CASCADE,
  agent_id BIGINT NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  enabled BOOLEAN NOT NULL DEFAULT true,
  config JSONB NOT NULL DEFAULT '{}'::jsonb,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (business_unit_id, agent_id)
);
CREATE TABLE IF NOT EXISTS agent_identities (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  agent_id BIGINT NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  key_id TEXT NOT NULL UNIQUE,
  display_name TEXT,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','revoked')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_used_at TIMESTAMPTZ
);

-- Survivors: active, bound to the existing executors, behavior unchanged.
INSERT INTO agents (slug, name, description, agent_kind, executor_kind, status) VALUES
  ('research',         'Research Agent',         'Gathers industry/news intel and produces briefs.', 'worker', 'bound', 'active'),
  ('marketing',        'Marketing Agent',        'Turns briefs into per-channel copy drafts.', 'worker', 'bound', 'active'),
  ('sales',            'Sales Agent',            'Builds prospect lists and drafts outreach/partnership emails, records leads.', 'worker', 'bound', 'active'),
  ('customer_service', 'Customer Service Agent', 'Live chat answers grounded only in tenant RAG content.', 'worker', 'bound', 'active')
ON CONFLICT (slug) DO NOTHING;

-- Registry-first placeholders for the future workforce (Phase 0.5 §6.2),
-- each enabled by its own later phase. Disabled; executor_kind 'llm' so the
-- generic executor can run them the moment they are enabled and versioned.
INSERT INTO agents (slug, name, description, agent_kind, executor_kind, status) VALUES
  ('supervisor',         'Supervisor',              'Plans, decomposes and escalates across the workforce.', 'supervisor', 'llm', 'disabled'),
  ('intelligence',       'Intelligence Agent',      'Market/competitor intelligence synthesis.', 'worker', 'llm', 'disabled'),
  ('legal_intelligence', 'Legal Intelligence',      'Legal-domain research and monitoring for legal-class BUs.', 'worker', 'llm', 'disabled'),
  ('competitor',         'Competitor Agent',        'Competitor tracking and diffing.', 'worker', 'llm', 'disabled'),
  ('content_strategy',   'Content Strategy',        'Editorial strategy, calendars, theme planning.', 'worker', 'llm', 'disabled'),
  ('content',            'Content Agent',           'Long-form content production.', 'worker', 'llm', 'disabled'),
  ('fact_check',         'Fact Check Agent',        'Claim verification against knowledge sources.', 'worker', 'llm', 'disabled'),
  ('seo',                'SEO Agent',               'Search optimization analysis and recommendations.', 'worker', 'llm', 'disabled'),
  ('social_media',       'Social Media Agent',      'Channel-native social content production.', 'worker', 'llm', 'disabled'),
  ('lead',               'Lead Agent',              'Inbound inquiry capture and qualification.', 'worker', 'llm', 'disabled'),
  ('customer_inquiry',   'Customer Inquiry Agent',  'Pre-sale question answering (P11 split).', 'worker', 'llm', 'disabled'),
  ('customer_support',   'Customer Support Agent',  'Post-sale support conversations (P11 split).', 'worker', 'llm', 'disabled'),
  ('analytics',          'Analytics Agent',         'Performance analysis and anomaly detection.', 'worker', 'llm', 'disabled'),
  ('strategy',           'Strategy Agent',          'Cross-domain strategic recommendations.', 'worker', 'llm', 'disabled'),
  ('reporting',          'Reporting Agent',         'Scheduled reporting and digests.', 'worker', 'llm', 'disabled')
ON CONFLICT (slug) DO NOTHING;

-- Version 1 for the active agents: system prompts are the exact role lines
-- the bound executors have always used (golden-prompt preservation).
INSERT INTO agent_versions (agent_id, version, system_prompt, config, changelog)
SELECT a.id, 1, v.system_prompt, '{}'::jsonb, 'Phase 2 registry import of the legacy prompt'
FROM agents a
JOIN (VALUES
  ('research',         'Research agent: produce a concise intel brief with bullets and sources.'),
  ('marketing',        'Marketing agent: write platform-appropriate social copy that fits the channel''s style and character limits.'),
  ('sales',            'Sales agent: write a professional, non-spammy outreach or partnership pitch email.'),
  ('customer_service', 'Customer service agent: answer only from retrieved knowledge sources.')
) AS v(slug, system_prompt) ON v.slug = a.slug
WHERE NOT EXISTS (SELECT 1 FROM agent_versions av WHERE av.agent_id = a.id AND av.version = 1);

-- agents.manage permission: mutations on the registry (owner + administrator).
INSERT INTO permissions (key) VALUES ('agents.manage') ON CONFLICT (key) DO NOTHING;
INSERT INTO role_permissions (role_id, permission_id)
SELECT r.id, p.id FROM roles r JOIN permissions p ON p.key = 'agents.manage'
WHERE r.key IN ('owner','administrator')
ON CONFLICT DO NOTHING;`;

/**
 * Phase 2 run attribution (Phase 0.5 §5.1 agent_runs row / §71 / C-14).
 * Fully additive: new nullable columns + legacy prompt_hash content copied to
 * a dedicated topic column. prompt_hash keeps its name; NEW rows carry a real
 * sha-256 prompt hash, legacy rows keep the raw topic they always stored and
 * now also have it in topic. Existing rows untouched otherwise.
 */
const M_013_AGENT_RUNS_ATTRIBUTES = `
ALTER TABLE agent_runs ADD COLUMN IF NOT EXISTS agent_id BIGINT REFERENCES agents(id);
ALTER TABLE agent_runs ADD COLUMN IF NOT EXISTS business_unit_id BIGINT REFERENCES business_units(id);
ALTER TABLE agent_runs ADD COLUMN IF NOT EXISTS task_id BIGINT;
ALTER TABLE agent_runs ADD COLUMN IF NOT EXISTS workflow_run_id BIGINT;
ALTER TABLE agent_runs ADD COLUMN IF NOT EXISTS model TEXT;
ALTER TABLE agent_runs ADD COLUMN IF NOT EXISTS prompt_version_id BIGINT REFERENCES agent_versions(id);
ALTER TABLE agent_runs ADD COLUMN IF NOT EXISTS topic TEXT;
ALTER TABLE agent_runs ADD COLUMN IF NOT EXISTS started_at TIMESTAMPTZ;
ALTER TABLE agent_runs ADD COLUMN IF NOT EXISTS completed_at TIMESTAMPTZ;
ALTER TABLE agent_runs ADD COLUMN IF NOT EXISTS duration_ms INT;
ALTER TABLE agent_runs ADD COLUMN IF NOT EXISTS input_tokens INT;
ALTER TABLE agent_runs ADD COLUMN IF NOT EXISTS output_tokens INT;
ALTER TABLE agent_runs ADD COLUMN IF NOT EXISTS estimated_cost NUMERIC(12,6);
ALTER TABLE agent_runs ADD COLUMN IF NOT EXISTS error TEXT;
ALTER TABLE agent_runs ADD COLUMN IF NOT EXISTS error_class TEXT;
UPDATE agent_runs SET topic = prompt_hash WHERE topic IS NULL;
CREATE INDEX IF NOT EXISTS agent_runs_agent_idx ON agent_runs (agent_id);
CREATE INDEX IF NOT EXISTS agent_runs_bu_idx ON agent_runs (business_unit_id);`;

/**
 * Phase 2 SEC-L2: key-id envelope encryption for channel tokens. The columns
 * stay as-is (ciphertexts are self-describing); this migration only records
 * nothing — the envelope format lives in lib/channels.ts and supports both
 * the legacy iv:tag:data payloads and v2:<key_id>:iv:tag:data. Kept as a
 * numbered (no-op) version so the ledger documents the SEC-L2 cutover point.
 */
const M_014_CHANNELS_KEY_ID = `
SELECT 1;`;

/**
 * Phase 2 SEC-L1 v1: RLS enablement scaffolding on the multi-BU target
 * tables. Policies are written for the FUTURE per-audience DB roles and use
 * current_setting('agentos.bu_id') so the cutover is policy work, not schema
 * work. The application connects as the table owner, which bypasses RLS
 * unless FORCE is set — FORCE is deliberately NOT set here (the app-level
 * BU scoping from Phase 1 remains the enforced layer; the DB backstop
 * activates with the dedicated DB role, Phase 3/4 cutover). No behavior
 * change for the current deployment.
 */
const M_015_RLS_SCAFFOLDING = `
ALTER TABLE business_units ENABLE ROW LEVEL SECURITY;
ALTER TABLE websites ENABLE ROW LEVEL SECURITY;
DO $rls$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename = 'business_units' AND policyname = 'bu_self_or_assigned') THEN
    CREATE POLICY bu_self_or_assigned ON business_units
      USING (id::text = COALESCE(NULLIF(current_setting('agentos.bu_id', true), ''), id::text));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename = 'websites' AND policyname = 'website_bu_or_assigned') THEN
    CREATE POLICY website_bu_or_assigned ON websites
      USING (business_unit_id::text = COALESCE(NULLIF(current_setting('agentos.bu_id', true), ''), business_unit_id::text));
  END IF;
END
$rls$;`;

/**
 * Phase 3 (§11 P3) — task engine core. A durable job queue: tasks are rows,
 * never memory. Status machine includes the approval-gated states the later
 * content workforce phases rely on (waiting_approval, escalated). Claims use
 * FOR UPDATE SKIP LOCKED so concurrent workers never double-claim; attempts/
 * backoff/visibility-timeout recovery guarantee "jobs must not disappear"
 * (§140). idempotency_key (unique per BU) is the spawn-level duplicate guard.
 */
const M_016_TASK_ENGINE = `
CREATE TABLE IF NOT EXISTS tasks (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  business_unit_id BIGINT,
  tenant_id BIGINT,
  kind TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'queued' CHECK (status IN
    ('queued','claimed','running','succeeded','failed','cancelled','waiting_approval','escalated')),
  priority INT NOT NULL DEFAULT 100,
  payload JSONB NOT NULL DEFAULT '{}'::jsonb,
  result JSONB,
  error TEXT,
  error_class TEXT,
  run_id BIGINT,
  workflow_run_id BIGINT,
  attempts INT NOT NULL DEFAULT 0,
  max_attempts INT NOT NULL DEFAULT 3,
  next_run_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  claimed_at TIMESTAMPTZ,
  claimed_by TEXT,
  heartbeat_at TIMESTAMPTZ,
  started_at TIMESTAMPTZ,
  finished_at TIMESTAMPTZ,
  cancel_requested BOOLEAN NOT NULL DEFAULT false,
  created_by TEXT NOT NULL DEFAULT 'system',
  idempotency_key TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS tasks_idem_key
  ON tasks (COALESCE(business_unit_id, 0), idempotency_key)
  WHERE idempotency_key IS NOT NULL;
CREATE INDEX IF NOT EXISTS tasks_due_idx
  ON tasks (priority, next_run_at)
  WHERE status = 'queued';
CREATE INDEX IF NOT EXISTS tasks_inflight_idx
  ON tasks (status, heartbeat_at)
  WHERE status IN ('claimed','running');

CREATE TABLE IF NOT EXISTS task_steps (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  task_id BIGINT NOT NULL REFERENCES tasks(id),
  seq INT NOT NULL,
  name TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','running','done','failed','skipped')),
  output JSONB,
  error TEXT,
  started_at TIMESTAMPTZ,
  finished_at TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS task_steps_task_idx ON task_steps (task_id, seq);`;

/**
 * Phase 3 — workflow definitions and runs. A workflow is a named trigger
 * (schedule | event | manual; webhook + goal are reserved for later phases)
 * bound to a task template: when triggered, the engine spawns a task row.
 * The seeded scheduled_publishing_sweep makes the legacy cron sweep Workflow
 * #1 (roadmap §126) while the GET alias + secret gate remain on the cron
 * route until the engine soaks.
 */
const M_017_WORKFLOWS = `
CREATE TABLE IF NOT EXISTS workflows (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  business_unit_id BIGINT,
  slug TEXT NOT NULL,
  name TEXT NOT NULL,
  trigger_kind TEXT NOT NULL CHECK (trigger_kind IN ('schedule','event','manual')),
  trigger_config JSONB NOT NULL DEFAULT '{}'::jsonb,
  task_kind TEXT NOT NULL,
  task_payload JSONB NOT NULL DEFAULT '{}'::jsonb,
  enabled BOOLEAN NOT NULL DEFAULT true,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
-- expression unique index (table-level UNIQUE cannot take expressions)
CREATE UNIQUE INDEX IF NOT EXISTS workflows_slug_key
  ON workflows (COALESCE(business_unit_id, 0), slug);

CREATE TABLE IF NOT EXISTS workflow_runs (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  workflow_id BIGINT NOT NULL REFERENCES workflows(id),
  business_unit_id BIGINT,
  trigger_kind TEXT NOT NULL,
  trigger_ref TEXT,
  status TEXT NOT NULL DEFAULT 'running' CHECK (status IN ('running','succeeded','failed','cancelled')),
  task_id BIGINT,
  stats JSONB,
  started_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  finished_at TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS workflow_runs_wf_idx ON workflow_runs (workflow_id, started_at DESC);

INSERT INTO workflows (business_unit_id, slug, name, trigger_kind, trigger_config, task_kind, task_payload)
SELECT NULL, 'scheduled_publishing_sweep', 'Scheduled publishing sweep', 'schedule',
       '{"schedule": "daily 03:30 UTC"}'::jsonb, 'publishing_sweep', '{}'::jsonb
WHERE NOT EXISTS (SELECT 1 FROM workflows WHERE slug = 'scheduled_publishing_sweep' AND business_unit_id IS NULL);`;

/**
 * Phase 3 — event bus + notifications v1. Events are append-only domain
 * occurrences; the notification fanout (emitEvent) materializes one
 * notifications row per rule match (terminal task/publish failures by
 * default). Delivery rides the queue itself as send_notification tasks;
 * suppressed when no target is configured — notifications never block work.
 */
const M_018_EVENTS_NOTIFICATIONS = `
CREATE TABLE IF NOT EXISTS events (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  business_unit_id BIGINT,
  name TEXT NOT NULL,
  payload JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS events_name_idx ON events (name, created_at DESC);

CREATE TABLE IF NOT EXISTS notifications (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  business_unit_id BIGINT,
  event_id BIGINT REFERENCES events(id),
  channel TEXT NOT NULL DEFAULT 'email',
  target TEXT,
  subject TEXT,
  body TEXT,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','sent','failed','suppressed')),
  task_id BIGINT,
  attempts INT NOT NULL DEFAULT 0,
  last_error TEXT,
  sent_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS notifications_status_idx ON notifications (status, created_at DESC);`;

/**
 * Phase 3 — content_publications replaces the outbox as the publication
 * ledger (roadmap §205). idempotency_key is UNIQUE: one draft → at most one
 * successful publication row, enforced by the database even under concurrent
 * sweeps (§88). The outbox table is NOT dropped or written from here on —
 * rows stay as archive; drop is a Phase 4 cleanup.
 */
const M_019_CONTENT_PUBLICATIONS = `
CREATE TABLE IF NOT EXISTS content_publications (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  draft_id BIGINT NOT NULL,
  business_unit_id BIGINT,
  tenant_id BIGINT,
  channel TEXT NOT NULL,
  external_id TEXT,
  idempotency_key TEXT NOT NULL UNIQUE,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','published','failed')),
  published_at TIMESTAMPTZ,
  attempted_at TIMESTAMPTZ,
  error TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS content_publications_draft_idx ON content_publications (draft_id);
CREATE INDEX IF NOT EXISTS content_publications_status_idx ON content_publications (status);`;

/**
 * Phase 4 — AI Gateway ledger (§8, §24): one row per gateway attempt
 * (ok | error | budget_blocked | rate_limited) with tokens, cost, latency
 * and full attribution (BU / agent / run / task / purpose). model_prices is
 * the operator-editable cost source of truth. agent_run_id/task_id are
 * plain BIGINT (no FK): run rows are recorded AFTER execution and the
 * gateway back-links in the same request; ledger must never be blocked by
 * run-row lifecycle.
 */
const M_020_AI_GATEWAY_LEDGER = `
CREATE TABLE IF NOT EXISTS llm_requests (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  business_unit_id BIGINT,
  agent_id BIGINT,
  agent_slug TEXT,
  agent_run_id BIGINT,
  task_id BIGINT,
  provider TEXT NOT NULL DEFAULT 'openai',
  kind TEXT NOT NULL CHECK (kind IN ('chat','embed')),
  model TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('ok','error','budget_blocked','rate_limited')),
  error_code TEXT,
  prompt_tokens INTEGER,
  completion_tokens INTEGER,
  total_tokens INTEGER,
  cost_usd NUMERIC(14,8) NOT NULL DEFAULT 0,
  latency_ms INTEGER,
  attempt_no INTEGER NOT NULL DEFAULT 1,
  purpose TEXT,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS llm_requests_bu_time_idx ON llm_requests (business_unit_id, created_at);
CREATE INDEX IF NOT EXISTS llm_requests_agent_time_idx ON llm_requests (agent_id, created_at);
CREATE INDEX IF NOT EXISTS llm_requests_run_idx ON llm_requests (agent_run_id) WHERE agent_run_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS llm_requests_task_idx ON llm_requests (task_id) WHERE task_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS model_prices (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  provider TEXT NOT NULL,
  model TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('chat','embed')),
  input_per_1k_usd NUMERIC(12,8) NOT NULL CHECK (input_per_1k_usd >= 0),
  output_per_1k_usd NUMERIC(12,8) CHECK (output_per_1k_usd IS NULL OR output_per_1k_usd >= 0),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (provider, model, kind)
);
INSERT INTO model_prices (provider, model, kind, input_per_1k_usd, output_per_1k_usd) VALUES
  ('openai', 'gpt-4o-mini', 'chat', 0.00015000, 0.00060000),
  ('openai', 'gpt-4o', 'chat', 0.00250000, 0.01000000),
  ('openai', 'text-embedding-3-small', 'embed', 0.00002000, NULL),
  ('openai', 'text-embedding-3-large', 'embed', 0.00013000, NULL)
ON CONFLICT (provider, model, kind) DO NOTHING;`;

/**
 * Phase 4 — budgets as first-class objects (SEC-L9, §26). Spend ceilings
 * per business_unit | agent per daily | monthly period, evaluated by the
 * gateway pre-call (hard-stop) and post-call (ops paging). Per-task
 * ceilings ride tasks.budget_usd (set at spawn).
 */
const M_021_BUDGETS = `
CREATE TABLE IF NOT EXISTS budgets (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  scope_type TEXT NOT NULL CHECK (scope_type IN ('business_unit','agent')),
  scope_id BIGINT NOT NULL,
  period TEXT NOT NULL CHECK (period IN ('daily','monthly')),
  limit_usd NUMERIC(14,6) NOT NULL CHECK (limit_usd >= 0),
  enabled BOOLEAN NOT NULL DEFAULT TRUE,
  created_by_user_id BIGINT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (scope_type, scope_id, period)
);
CREATE INDEX IF NOT EXISTS budgets_scope_idx ON budgets (scope_type, scope_id);
ALTER TABLE tasks ADD COLUMN IF NOT EXISTS budget_usd NUMERIC(14,6);`;

/**
 * Phase 4 — gateway feature flag (rollback path: OFF = raw provider
 * passthrough, zero deploys) + Gateway screen permissions.
 */
const M_022_GATEWAY_FLAG_PERMISSIONS = `
INSERT INTO feature_flags (key, enabled, emergency, description)
VALUES ('ai_gateway', TRUE, TRUE,
        'AI Gateway: budgets, usage ledger, rate limits, fallback (OFF = raw provider passthrough)')
ON CONFLICT (key) DO NOTHING;

INSERT INTO permissions (key) VALUES ('llm.view'), ('budgets.manage') ON CONFLICT (key) DO NOTHING;

INSERT INTO role_permissions (role_id, permission_id)
SELECT r.id, p.id FROM roles r
JOIN permissions p ON p.key IN ('llm.view','budgets.manage')
WHERE r.key IN ('owner','administrator')
ON CONFLICT DO NOTHING;`;

export const MIGRATIONS: MigrationDef[] = [
  { version: "000", name: "agentos_legacy_baseline", source: M_000_LEGACY_BASELINE },
  { version: "001", name: "schema_migrations", source: M_001_SCHEMA_MIGRATIONS },
  { version: "002", name: "audit_logs", source: M_002_AUDIT_LOGS },
  { version: "003", name: "users_sessions", source: M_003_USERS_SESSIONS },
  { version: "004", name: "rbac_seed", source: M_004_RBAC },
  { version: "005", name: "settings_flags_seed", source: M_005_SETTINGS_FLAGS },
  { version: "006", name: "tenant_usage_daily", source: M_006_TENANT_USAGE_DAILY },
  { version: "007", name: "business_units_websites_backfill", source: M_007_BUSINESS_UNITS_WEBSITES },
  { version: "008", name: "website_integrations_capabilities", source: M_008_WEBSITE_INTEGRATIONS_CAPABILITIES },
  { version: "009", name: "channels_add_columns", source: M_009_CHANNELS_ADD_COLUMNS },
  { version: "010", name: "approvals_reviewer_user", source: M_010_APPROVALS_REVIEWER },
  { version: "011", name: "rate_limit_buckets", source: M_011_RATE_LIMIT_BUCKETS },
  { version: "012", name: "agents_registry", source: M_012_AGENTS_REGISTRY },
  { version: "013", name: "agent_runs_attributes", source: M_013_AGENT_RUNS_ATTRIBUTES },
  { version: "014", name: "channels_key_id_envelope", source: M_014_CHANNELS_KEY_ID },
  { version: "015", name: "rls_scaffolding", source: M_015_RLS_SCAFFOLDING },
  { version: "016", name: "task_engine", source: M_016_TASK_ENGINE },
  { version: "017", name: "workflows_runs", source: M_017_WORKFLOWS },
  { version: "018", name: "events_notifications", source: M_018_EVENTS_NOTIFICATIONS },
  { version: "019", name: "content_publications", source: M_019_CONTENT_PUBLICATIONS },
  { version: "020", name: "ai_gateway_ledger", source: M_020_AI_GATEWAY_LEDGER },
  { version: "021", name: "budgets", source: M_021_BUDGETS },
  { version: "022", name: "gateway_flag_permissions", source: M_022_GATEWAY_FLAG_PERMISSIONS },
];
