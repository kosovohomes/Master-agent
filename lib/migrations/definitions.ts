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
 * Phase 5 (§11 P5, knowledge system v2 — scopes §9.1, metadata §9.2):
 *   023 knowledge_sources (source registry + content_sources backfill) ·
 *   024 documents scoping (GLOBAL/BU/WEBSITE/JURISDICTION/AGENT + legal/
 *       authority/language/lifecycle metadata + agent_runs.citations) ·
 *   025 chunks hybrid retrieval (tsvector leg + chunk_no + GIN) ·
 *   026 knowledge_v2 flag + knowledge.manage permission
 * Phase 4 (§11 P4, AI gateway — llm_requests ledger, budgets, cost control):
 *   020 llm_requests + model_prices · 021 budgets + tasks.budget_usd ·
 *   022 ai_gateway flag + llm.view/budgets.manage permissions
 * Phase 6 (§11 P13 pulled forward — website connectors, §12/§77/§411, SEC-L4):
 *   027 website_integrations connector columns (signing/rotation/last_event/
 *       display_name) + connector_deliveries (signed-webhook receipt log
 *       + replay cache, UNIQUE (website_id, delivery_id)) ·
 *   028 connectors flag + connectors.manage permission
 * Phase 8 (§11 P7 — content workforce, §60-§61 lifecycle, §5.1 state map,
 * §72 approval immutability, audit §901):
 *   032 content_items + content_versions (never-overwrite) + approval_actions
 *       + drafts→content lineage backfill (§5.1 state map) + approvals v2
 *       columns (content_item_id WITHOUT cascade, risk_level, requested_action,
 *       decision_reason, task_id) ·
 *   033 content workforce agents activation + versioned v1 prompts
 *       (content_strategy / content / fact_check) ·
 *   034 content flag + content.manage permission
 * Phase 9 (§11 P8 — SEO workforce, §80/§218/§464: keyword intelligence, gap
 * analysis, recommendations with approval flags):
 *   035 seo_keywords (BU-scoped keyword store, normalized UNIQUE per BU) +
 *       seo_recommendations (status FSM open→approved/dismissed/done with
 *       immutable review columns, evidence JSONB, dedup UNIQUE per BU) +
 *       seo agent activation + versioned v1 prompt ·
 *   036 seo flag + seo.manage permission
 * Phase 10 (§11 P9 — social workforce, §38/§197/§219/§466 + SEC-L5 OAuth
 * lifecycle; acceptance: one approved item → per-platform scheduled posts,
 * nothing publishes without approval):
 *   037 social_campaigns + social_accounts (absorbs social-kind channels per
 *       §197 with BU resolution via legacy_tenant_id; LinkedIn account-ref
 *       fix = account_ref column) + social_posts (linked to content_items,
 *       per-platform rows, time-semantics scheduling, FSM, partial UNIQUE
 *       one-active-post per (item, platform)) + social_post_metrics +
 *       content_publications.social_post_id (additive; draft_id nullable) +
 *       scheduled_social_sweep workflow seed ·
 *   038 social_media agent activation + versioned v1 prompt ·
 *   039 social flag + social.manage permission
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

/**
 * Phase 5 — knowledge_sources registry (§17–§18 via §9.2): the platform-facing
 * source of knowledge ingestion. Scope: business_unit_id NULL = global,
 * website_id NULL = BU-wide. Legal/authority/language/lifecycle metadata live
 * here and are stamped onto every ingested document. Legacy content_sources
 * stays untouched (rename/view swap deferred to the cleanup phase, same
 * decision as Phase 4's tenants/outbox deferral); existing rows backfill via
 * the 1:1 tenant→BU map — mapped rows only, unmapped legacy sources stay out
 * of the scoped registry rather than silently becoming global.
 */
const M_023_KNOWLEDGE_SOURCES = `
CREATE TABLE IF NOT EXISTS knowledge_sources (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  business_unit_id BIGINT REFERENCES business_units(id) ON DELETE CASCADE,
  website_id BIGINT REFERENCES websites(id) ON DELETE SET NULL,
  kind TEXT NOT NULL CHECK (kind IN ('sitemap','upload','api','rss','url','github','db')),
  ref TEXT NOT NULL,
  title TEXT NOT NULL DEFAULT '',
  description TEXT NOT NULL DEFAULT '',
  authority_level INT NOT NULL DEFAULT 3 CHECK (authority_level BETWEEN 1 AND 5),
  jurisdiction TEXT,
  state_province TEXT,
  country TEXT,
  language TEXT,
  document_type TEXT,
  access_level TEXT NOT NULL DEFAULT 'internal' CHECK (access_level IN ('public','internal','confidential')),
  refresh_frequency TEXT NOT NULL DEFAULT 'manual' CHECK (refresh_frequency IN ('manual','hourly','daily','weekly')),
  max_documents INT NOT NULL DEFAULT 10 CHECK (max_documents BETWEEN 1 AND 200),
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','disabled','error')),
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  last_checked TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS knowledge_sources_bu_idx ON knowledge_sources (business_unit_id);

INSERT INTO knowledge_sources
  (business_unit_id, kind, ref, title, status, last_checked, metadata)
SELECT bu.id, cs.kind, cs.ref, cs.ref, 'active', cs.last_synced_at,
       jsonb_build_object(
         'backfilledFrom', 'content_sources',
         'legacySourceId', cs.id::text,
         'legacyTenantId', cs.tenant_id::text
       )
FROM content_sources cs
JOIN business_units bu ON bu.legacy_tenant_id = cs.tenant_id
WHERE NOT EXISTS (
  SELECT 1 FROM knowledge_sources ks
  WHERE ks.metadata->>'legacySourceId' = cs.id::text
);`;

/**
 * Phase 5 — documents scope + metadata (§9.1–§9.2). The five scopes:
 * GLOBAL (business_unit_id NULL) → BUSINESS (business_unit_id) → WEBSITE
 * (website_id NULL = BU-wide) → JURISDICTION (jurisdiction NULL = unscoped)
 * → AGENT (agent_scopes '[]' = unrestricted). Legal contract columns serve
 * §50–§51 (law from one jurisdiction never assumed elsewhere); authority
 * tiers 1–5 feed research citations; provenance stamps fetch origin.
 *
 * Additive posture: tenant_id/source_id become OPTIONAL (v2 ingests write
 * knowledge_source_id instead) — no data touched, legacy ingest keeps both.
 * Backfill maps existing documents onto their BU and stamps access_level
 * 'public' (the legacy widget chat was public-by-design, so behavior is
 * preserved when the knowledge_v2 flag flips ON).
 */
const M_024_DOCUMENTS_SCOPING = `
ALTER TABLE documents ADD COLUMN IF NOT EXISTS business_unit_id BIGINT REFERENCES business_units(id);
ALTER TABLE documents ADD COLUMN IF NOT EXISTS website_id BIGINT REFERENCES websites(id);
ALTER TABLE documents ADD COLUMN IF NOT EXISTS knowledge_source_id BIGINT REFERENCES knowledge_sources(id) ON DELETE SET NULL;
ALTER TABLE documents ADD COLUMN IF NOT EXISTS jurisdiction TEXT;
ALTER TABLE documents ADD COLUMN IF NOT EXISTS country TEXT;
ALTER TABLE documents ADD COLUMN IF NOT EXISTS state_province TEXT;
ALTER TABLE documents ADD COLUMN IF NOT EXISTS court_system TEXT;
ALTER TABLE documents ADD COLUMN IF NOT EXISTS language TEXT;
ALTER TABLE documents ADD COLUMN IF NOT EXISTS document_type TEXT;
ALTER TABLE documents ADD COLUMN IF NOT EXISTS access_level TEXT NOT NULL DEFAULT 'internal' CHECK (access_level IN ('public','internal','confidential'));
ALTER TABLE documents ADD COLUMN IF NOT EXISTS authority_tier INT NOT NULL DEFAULT 3 CHECK (authority_tier BETWEEN 1 AND 5);
ALTER TABLE documents ADD COLUMN IF NOT EXISTS effective_date DATE;
ALTER TABLE documents ADD COLUMN IF NOT EXISTS source_date DATE;
ALTER TABLE documents ADD COLUMN IF NOT EXISTS source_url TEXT;
ALTER TABLE documents ADD COLUMN IF NOT EXISTS provenance JSONB NOT NULL DEFAULT '{}'::jsonb;
ALTER TABLE documents ADD COLUMN IF NOT EXISTS verification_status TEXT NOT NULL DEFAULT 'unverified' CHECK (verification_status IN ('unverified','verified','stale','contradicted'));
ALTER TABLE documents ADD COLUMN IF NOT EXISTS agent_scopes JSONB NOT NULL DEFAULT '[]'::jsonb;

ALTER TABLE documents ALTER COLUMN source_id DROP NOT NULL;
ALTER TABLE documents ALTER COLUMN tenant_id DROP NOT NULL;
ALTER TABLE chunks ALTER COLUMN tenant_id DROP NOT NULL;

UPDATE documents d
SET business_unit_id = bu.id, access_level = 'public'
FROM business_units bu
WHERE bu.legacy_tenant_id = d.tenant_id
  AND d.business_unit_id IS NULL;

CREATE INDEX IF NOT EXISTS documents_bu_idx ON documents (business_unit_id);
CREATE INDEX IF NOT EXISTS documents_website_idx ON documents (website_id) WHERE website_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS documents_jurisdiction_idx ON documents (jurisdiction) WHERE jurisdiction IS NOT NULL;
CREATE INDEX IF NOT EXISTS documents_checksum_idx ON documents (checksum);

-- Research citations at the run level (tier + provenance, P5 acceptance).
ALTER TABLE agent_runs ADD COLUMN IF NOT EXISTS citations JSONB;`;

/**
 * Phase 5 — hybrid retrieval leg 1 (keyword): tsvector on chunks backfilled
 * and GIN-indexed; chunk_no preserves document order for structure-aware
 * re-chunking. Vector leg (ivfflat) is unchanged — retrieval merges both
 * legs by reciprocal-rank fusion. to_tsvector('english', content) is
 * computed in SQL on both write and backfill so the two can never drift.
 */
const M_025_CHUNKS_HYBRID = `
ALTER TABLE chunks ADD COLUMN IF NOT EXISTS tsv tsvector;
ALTER TABLE chunks ADD COLUMN IF NOT EXISTS chunk_no INT NOT NULL DEFAULT 0;

UPDATE chunks SET tsv = to_tsvector('english', content) WHERE tsv IS NULL;

CREATE INDEX IF NOT EXISTS chunks_tsv_idx ON chunks USING gin (tsv);
CREATE INDEX IF NOT EXISTS chunks_doc_no_idx ON chunks (document_id, chunk_no);`;

/**
 * Phase 5 — rollback seam + admin permission. knowledge_v2 OFF = every
 * consumer (widget chat, research grounding) uses the legacy tenant-only
 * retrieval, zero code change. knowledge.manage gates the Knowledge screen
 * and admin APIs (owner + administrator).
 */
const M_026_KNOWLEDGE_FLAG_PERMS = `
INSERT INTO feature_flags (key, enabled, emergency, description)
VALUES ('knowledge_v2', TRUE, FALSE,
        'Knowledge v2: scoped hybrid retrieval, fetchers, research grounding (OFF = legacy tenant-only retrieval)')
ON CONFLICT (key) DO NOTHING;

INSERT INTO permissions (key) VALUES ('knowledge.manage') ON CONFLICT (key) DO NOTHING;

INSERT INTO role_permissions (role_id, permission_id)
SELECT r.id, p.id FROM roles r
JOIN permissions p ON p.key = 'knowledge.manage'
WHERE r.key IN ('owner','administrator')
ON CONFLICT DO NOTHING;`;

/**
 * Phase 6 (website connectors, Phase 0.5 §12/§77/§411, SEC-L4 — pulled
 * forward from roadmap P13 per the Phase 5 report §18):
 *  - website_integrations gains the connector contract columns: the HMAC
 *    signing algorithm marker, the previous signing secret (kept for a
 *    bounded rotation window so rotation is zero-downtime, §77), the
 *    rotation timestamp, last inbound event stamp, and a display name.
 *    Signing secrets reuse credentials_encrypted (AES-256-GCM envelope,
 *    lib/channels.ts).
 *  - connector_deliveries is the signed-webhook receipt log and replay
 *    cache: UNIQUE (website_id, delivery_id) rejects duplicate deliveries;
 *    a FAILED row may be re-recorded so sender retries with the same
 *    delivery id are processed (only successfully accepted deliveries
 *    replay-block). Every inbound attempt is logged with its verdict —
 *    including rejected ones — without ever storing the secret.
 */
const M_027_WEBSITE_CONNECTORS = `
ALTER TABLE website_integrations
  ADD COLUMN IF NOT EXISTS signing_algo TEXT NOT NULL DEFAULT 'hmac-sha256',
  ADD COLUMN IF NOT EXISTS previous_credentials_encrypted TEXT,
  ADD COLUMN IF NOT EXISTS rotated_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS last_event_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS display_name TEXT;

CREATE TABLE IF NOT EXISTS connector_deliveries (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  website_id BIGINT NOT NULL REFERENCES websites(id) ON DELETE CASCADE,
  integration_id BIGINT REFERENCES website_integrations(id) ON DELETE SET NULL,
  delivery_id TEXT NOT NULL,
  event_type TEXT NOT NULL,
  signature_valid BOOLEAN NOT NULL DEFAULT false,
  status TEXT NOT NULL DEFAULT 'received'
    CHECK (status IN ('received','accepted','rejected','failed')),
  rejection_reason TEXT,
  payload JSONB,
  task_id BIGINT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (website_id, delivery_id)
);
CREATE INDEX IF NOT EXISTS connector_deliveries_website_idx
  ON connector_deliveries (website_id, created_at DESC);
CREATE INDEX IF NOT EXISTS connector_deliveries_integration_idx
  ON connector_deliveries (integration_id);`;

/**
 * Phase 6 flag + permission (same pattern as 022/026): the connectors
 * feature flag gates the entire inbound-webhook surface (OFF = the
 * integration endpoint 404s, zero deploys rollback); connectors.manage
 * guards the admin API + Command Center screen (owner + administrator).
 */
const M_028_CONNECTORS_FLAG_PERMS = `
INSERT INTO feature_flags (key, enabled, emergency, description)
VALUES ('connectors', TRUE, FALSE,
        'Website connectors: signed inbound webhooks, capability grants, site content sync (OFF = integration endpoint disabled)')
ON CONFLICT (key) DO NOTHING;

INSERT INTO permissions (key) VALUES ('connectors.manage') ON CONFLICT (key) DO NOTHING;

INSERT INTO role_permissions (role_id, permission_id)
SELECT r.id, p.id FROM roles r
JOIN permissions p ON p.key = 'connectors.manage'
WHERE r.key IN ('owner','administrator')
ON CONFLICT DO NOTHING;`;

/**
 * Phase 7 (research workforce, Phase 0.5 §6.2 P6 / §52–§53 / §59 / §137 —
 * pulled forward from roadmap P6 per the Phase 6 report §18). MVP use case
 * #1: daily AI/legal-AI intelligence without a human trigger.
 *
 *  - research_schedules: the scheduled research workflow configuration —
 *    which BU, which workforce agent, which topic ({{date}}-templated) and
 *    extra queries, at which cadence, with a per-run findings cap. One row
 *    per (BU, name); the durable per-run execution is a research_run task.
 *  - research_items: findings storage with the §109-shaped lifecycle —
 *    'unprocessed' (material collected, LLM unavailable → degraded mode),
 *    'finding' (cited + scored), 'escalated' (ambiguous / low confidence →
 *    human attention), then human review 'verified' / 'rejected' /
 *    'archived'. Sources carry full citation provenance; material keeps the
 *    fetched excerpts so an unprocessed item can be re-analyzed later.
 *    UNIQUE (business_unit_id, dedup_hash) is THE content dedup gate.
 *  - competitors + competitor_events (§59): competitor registry per BU and
 *    the detected-events log with snapshot; events link back to the finding
 *    that produced them.
 *
 *  Additive only — no existing table is touched.
 */
const M_029_RESEARCH_WORKFORCE = `
CREATE TABLE IF NOT EXISTS research_schedules (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  business_unit_id BIGINT NOT NULL REFERENCES business_units(id) ON DELETE CASCADE,
  agent_slug TEXT NOT NULL DEFAULT 'research'
    CHECK (agent_slug IN ('research','intelligence','legal_intelligence','competitor')),
  name TEXT NOT NULL,
  topic TEXT NOT NULL,
  queries JSONB NOT NULL DEFAULT '[]'::jsonb,
  cadence TEXT NOT NULL DEFAULT 'daily' CHECK (cadence IN ('hourly','daily','weekly')),
  max_items INT NOT NULL DEFAULT 5 CHECK (max_items BETWEEN 1 AND 20),
  enabled BOOLEAN NOT NULL DEFAULT true,
  last_run_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (business_unit_id, name)
);

CREATE TABLE IF NOT EXISTS research_items (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  business_unit_id BIGINT NOT NULL REFERENCES business_units(id) ON DELETE CASCADE,
  schedule_id BIGINT REFERENCES research_schedules(id) ON DELETE SET NULL,
  agent_slug TEXT NOT NULL,
  topic TEXT NOT NULL,
  query TEXT,
  status TEXT NOT NULL DEFAULT 'unprocessed'
    CHECK (status IN ('unprocessed','finding','escalated','verified','rejected','archived')),
  title TEXT,
  summary TEXT,
  analysis JSONB,
  score INT CHECK (score BETWEEN 0 AND 100),
  confidence NUMERIC(4,3) CHECK (confidence BETWEEN 0 AND 1),
  sources JSONB NOT NULL DEFAULT '[]'::jsonb,
  material TEXT,
  dedup_hash TEXT NOT NULL,
  prompt_version INT,
  prompt_hash TEXT,
  task_id BIGINT REFERENCES tasks(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  reviewed_at TIMESTAMPTZ,
  reviewed_by TEXT,
  UNIQUE (business_unit_id, dedup_hash)
);

CREATE INDEX IF NOT EXISTS idx_research_items_bu_status
  ON research_items (business_unit_id, status, created_at DESC);

CREATE TABLE IF NOT EXISTS competitors (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  business_unit_id BIGINT NOT NULL REFERENCES business_units(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  url TEXT,
  notes TEXT,
  enabled BOOLEAN NOT NULL DEFAULT true,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (business_unit_id, name)
);

CREATE TABLE IF NOT EXISTS competitor_events (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  business_unit_id BIGINT NOT NULL REFERENCES business_units(id) ON DELETE CASCADE,
  competitor_id BIGINT NOT NULL REFERENCES competitors(id) ON DELETE CASCADE,
  kind TEXT NOT NULL DEFAULT 'other'
    CHECK (kind IN ('pricing','product','announcement','content','other')),
  title TEXT NOT NULL,
  url TEXT,
  snapshot JSONB,
  research_item_id BIGINT REFERENCES research_items(id) ON DELETE SET NULL,
  detected_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_competitor_events_competitor
  ON competitor_events (competitor_id, detected_at DESC);

-- Workforce activation (Phase 0.5 §6.2: these rows were seeded disabled at
-- P2; their phase flips them on). 'research' stays bound/active — the legacy
-- bound executor keeps serving legacy dispatch; the pipeline reads its
-- VERSIONED prompt below.
UPDATE agents SET status = 'active', updated_at = now()
WHERE slug IN ('intelligence','legal_intelligence','competitor') AND status = 'disabled';

-- Versioned prompts (§6.4 invariant: agents are data; prompts are versioned
-- rows, never inline code). COALESCE(max(version),0)+1 per agent.
INSERT INTO agent_versions (agent_id, version, system_prompt, config, changelog)
SELECT a.id, COALESCE(max(v.version), 0) + 1,
       'You are the Research Agent for a business unit. Given a topic and a set of SOURCE excerpts, judge relevance and produce a concise intelligence finding. Cite sources by their [n] index. Score relevance 0-100. If the sources do not support a defensible finding, set ambiguous=true instead of guessing. Never fabricate facts not present in the sources.',
       '{"outputSchema":"research_finding_v1"}'::jsonb,
       'Phase 7 (P6): research workforce v1 prompt'
FROM agents a LEFT JOIN agent_versions v ON v.agent_id = a.id
WHERE a.slug = 'research' GROUP BY a.id;

INSERT INTO agent_versions (agent_id, version, system_prompt, config, changelog)
SELECT a.id, COALESCE(max(v.version), 0) + 1,
       'You are the Intelligence Agent. Given a topic and SOURCE excerpts, synthesize market/competitor intelligence: implications, opportunities, risks, and recommended actions. Cite sources by [n] index, score overall materiality 0-100, set ambiguous=true when sources are insufficient. Never fabricate facts not present in the sources.',
       '{"outputSchema":"intelligence_analysis_v1"}'::jsonb,
       'Phase 7 (P6): research workforce v1 prompt'
FROM agents a LEFT JOIN agent_versions v ON v.agent_id = a.id
WHERE a.slug = 'intelligence' GROUP BY a.id;

INSERT INTO agent_versions (agent_id, version, system_prompt, config, changelog)
SELECT a.id, COALESCE(max(v.version), 0) + 1,
       'You are the Legal Intelligence Agent for a legal-domain business unit. Given a legal/regulatory topic and SOURCE excerpts, produce a monitoring finding: what happened, jurisdiction, practical implications, compliance risks, recommended actions. Cite sources by [n] index, score materiality 0-100, set ambiguous=true when sources are insufficient. Never fabricate facts not present in the sources.',
       '{"outputSchema":"intelligence_analysis_v1"}'::jsonb,
       'Phase 7 (P6): research workforce v1 prompt'
FROM agents a LEFT JOIN agent_versions v ON v.agent_id = a.id
WHERE a.slug = 'legal_intelligence' GROUP BY a.id;

INSERT INTO agent_versions (agent_id, version, system_prompt, config, changelog)
SELECT a.id, COALESCE(max(v.version), 0) + 1,
       'You are the Competitor Agent. Given tracked competitor names and SOURCE excerpts, detect concrete competitor events (pricing changes, product launches, announcements, notable content) and attribute each to the right competitor and event kind. Cite sources by [n] index, score significance 0-100, set ambiguous=true when attribution is not defensible. Never fabricate facts not present in the sources.',
       '{"outputSchema":"research_finding_v1"}'::jsonb,
       'Phase 7 (P6): research workforce v1 prompt'
FROM agents a LEFT JOIN agent_versions v ON v.agent_id = a.id
WHERE a.slug = 'competitor' GROUP BY a.id;`;

/**
 * Phase 7 flag + permission (same pattern as 022/026/028): the `research`
 * flag is the platform-level kill switch for the research workforce (routes
 * fail closed 404 and the cron sweep stops spawning when OFF); the
 * `research.manage` permission gates the /research surface for owner and
 * administrator roles.
 */
const M_030_RESEARCH_FLAG_PERMS = `
INSERT INTO feature_flags (key, enabled, emergency, description)
VALUES ('research', TRUE, FALSE,
        'Research workforce: scheduled research/intelligence runs, findings, competitor events (OFF = no research execution)')
ON CONFLICT (key) DO NOTHING;

INSERT INTO permissions (key) VALUES ('research.manage') ON CONFLICT (key) DO NOTHING;

INSERT INTO role_permissions (role_id, permission_id)
SELECT r.id, p.id FROM roles r
JOIN permissions p ON p.key = 'research.manage'
WHERE r.key IN ('owner','administrator')
ON CONFLICT DO NOTHING;`;

/**
 * Phase 7 (live-acceptance learning): public search engines block Vercel
 * datacenter egress, so `web_search` cannot be the production backbone of
 * scheduled research. Schedules therefore carry MONITORED SOURCES —
 * RSS feeds, sitemaps and pages fetched with the Phase 5 machinery — as
 * the deterministic acquisition layer; web_search stays as the optional
 * amplification leg (Brave key via env, no deploy). Purely additive.
 */
const M_031_RESEARCH_SCHEDULE_SOURCES = `
ALTER TABLE research_schedules
  ADD COLUMN IF NOT EXISTS sources JSONB NOT NULL DEFAULT '[]'::jsonb;`;

/**
 * Phase 8 — content workforce storage (§60-§61, §5.1, §72; audit §901).
 *
 * content_items carries the §60 nine-state lifecycle; content_versions are
 * IMMUTABLE copies (never-overwrite, §61) — every edit appends a new version
 * row and moves content_items.current_version_id inside one transaction.
 *
 * Drafts lineage (§5.1, non-destructive restructure): each legacy draft whose
 * tenant has a business_units mapping is copied to one content_item + version
 * 1 with the documented state map (pending→DRAFT, approved→APPROVED,
 * scheduled→SCHEDULED, posted→PUBLISHED, failed→PUBLISHED with the failure
 * traceable in content_publications + brief.legacy_status, rejected→REVIEW).
 * Unmapped tenants stay OUT (never silently global — same rule as the
 * knowledge backfill). `drafts` itself is untouched: the legacy marketing →
 * FSM → publishing sweep keeps running unchanged until a later cutover phase.
 *
 * approvals v2 (§72): new decision rows may reference content_items — the FK
 * deliberately has NO ON DELETE CASCADE so approval audit rows survive the
 * (future) removal of a content item. approval_actions is the edit-before-
 * approve trail (§5.1 bundle 7). Legacy rows/columns are untouched.
 */
const M_032_CONTENT_WORKFORCE = `
CREATE TABLE IF NOT EXISTS content_items (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  business_unit_id BIGINT NOT NULL REFERENCES business_units(id) ON DELETE CASCADE,
  website_id BIGINT REFERENCES websites(id) ON DELETE SET NULL,
  research_item_id BIGINT REFERENCES research_items(id) ON DELETE SET NULL,
  type TEXT NOT NULL DEFAULT 'article'
    CHECK (type IN ('article','social_post','email','page_copy','other')),
  title TEXT,
  lifecycle TEXT NOT NULL DEFAULT 'IDEA'
    CHECK (lifecycle IN ('IDEA','RESEARCHING','DRAFT','FACT_CHECK','REVIEW','APPROVED','SCHEDULED','PUBLISHED','ARCHIVED')),
  brief JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_by_agent TEXT,
  current_version_id BIGINT,
  unprocessed_reason TEXT,
  task_id BIGINT REFERENCES tasks(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  reviewed_at TIMESTAMPTZ,
  reviewed_by TEXT
);

CREATE INDEX IF NOT EXISTS idx_content_items_bu_lifecycle
  ON content_items (business_unit_id, lifecycle, updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_content_items_research
  ON content_items (research_item_id) WHERE research_item_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS content_versions (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  content_item_id BIGINT NOT NULL REFERENCES content_items(id) ON DELETE CASCADE,
  version INT NOT NULL,
  title TEXT,
  body TEXT NOT NULL,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_by_agent TEXT,
  prompt_version INT,
  prompt_hash TEXT,
  change_note TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (content_item_id, version)
);

ALTER TABLE content_items
  ADD CONSTRAINT fk_content_items_current_version
  FOREIGN KEY (current_version_id) REFERENCES content_versions(id) ON DELETE SET NULL;

-- approvals v2 columns (§72): content_item_id has NO cascade on purpose.
-- draft_id drops NOT NULL (a pure relaxation — legacy rows untouched): v2
-- decision rows reference content_items instead of drafts.
ALTER TABLE approvals ALTER COLUMN draft_id DROP NOT NULL;
ALTER TABLE approvals ADD COLUMN IF NOT EXISTS content_item_id BIGINT REFERENCES content_items(id);
ALTER TABLE approvals ADD COLUMN IF NOT EXISTS risk_level TEXT CHECK (risk_level IN ('low','medium','high'));
ALTER TABLE approvals ADD COLUMN IF NOT EXISTS requested_action TEXT;
ALTER TABLE approvals ADD COLUMN IF NOT EXISTS decision_reason TEXT;
ALTER TABLE approvals ADD COLUMN IF NOT EXISTS task_id BIGINT REFERENCES tasks(id) ON DELETE SET NULL;
CREATE INDEX IF NOT EXISTS idx_approvals_content_item ON approvals (content_item_id);

CREATE TABLE IF NOT EXISTS approval_actions (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  business_unit_id BIGINT NOT NULL REFERENCES business_units(id) ON DELETE CASCADE,
  content_item_id BIGINT REFERENCES content_items(id) ON DELETE SET NULL,
  approval_id BIGINT REFERENCES approvals(id) ON DELETE SET NULL,
  version_id BIGINT REFERENCES content_versions(id) ON DELETE SET NULL,
  actor_user_id BIGINT REFERENCES users(id) ON DELETE SET NULL,
  actor_label TEXT,
  action TEXT NOT NULL CHECK (action IN ('submit','approve','reject','request_changes','edit','assign','escalate')),
  diff JSONB,
  note TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_approval_actions_item
  ON approval_actions (content_item_id, created_at DESC);

-- Drafts → content lineage backfill (§5.1 state map). Idempotent: the brief
-- records legacy_draft_id and the WHERE re-guard makes re-runs no-ops.
INSERT INTO content_items (business_unit_id, type, title, lifecycle, brief, created_by_agent, created_at, updated_at)
SELECT b.id,
       'social_post',
       left(d.content, 80),
       CASE d.status
         WHEN 'pending'   THEN 'DRAFT'
         WHEN 'approved'  THEN 'APPROVED'
         WHEN 'scheduled' THEN 'SCHEDULED'
         WHEN 'posted'    THEN 'PUBLISHED'
         WHEN 'failed'    THEN 'PUBLISHED'
         WHEN 'rejected'  THEN 'REVIEW'
       END,
       jsonb_build_object(
         'source', 'drafts',
         'legacy_draft_id', d.id,
         'legacy_status', d.status,
         'channel', d.channel,
         'review_notes', d.review_notes
       ),
       d.agent,
       d.created_at,
       d.created_at
FROM drafts d
JOIN business_units b ON b.legacy_tenant_id = d.tenant_id
WHERE NOT EXISTS (
  SELECT 1 FROM content_items ci
  WHERE ci.brief->>'source' = 'drafts'
    AND (ci.brief->>'legacy_draft_id')::bigint = d.id
);

INSERT INTO content_versions (content_item_id, version, title, body, metadata, created_by_agent, change_note)
SELECT ci.id, 1, ci.title, d.content,
       jsonb_build_object('source', 'drafts', 'legacy_status', d.status),
       d.agent,
       'Phase 8: legacy drafts lineage (version 1)'
FROM drafts d
JOIN business_units b ON b.legacy_tenant_id = d.tenant_id
JOIN content_items ci ON ci.brief->>'source' = 'drafts'
                     AND (ci.brief->>'legacy_draft_id')::bigint = d.id
WHERE NOT EXISTS (
  SELECT 1 FROM content_versions v WHERE v.content_item_id = ci.id AND v.version = 1
);

UPDATE content_items ci
SET current_version_id = v.id
FROM content_versions v
WHERE v.content_item_id = ci.id AND v.version = 1
  AND ci.current_version_id IS NULL
  AND ci.brief->>'source' = 'drafts';`;

/**
 * Phase 8 — content workforce agents (§262): content_strategy / content /
 * fact_check were seeded disabled at P2; their phase flips them on and gives
 * each a versioned v1 prompt (agents are data, §6.4 — prompts live in
 * agent_versions, never inline).
 */
const M_033_CONTENT_AGENTS = `
UPDATE agents SET status = 'active', updated_at = now()
WHERE slug IN ('content_strategy','content','fact_check') AND status = 'disabled';

INSERT INTO agent_versions (agent_id, version, system_prompt, config, changelog)
SELECT a.id, COALESCE(max(v.version), 0) + 1,
       'You are the Content Strategy Agent. Given research material (findings with cited sources) and a brief, produce an editorial plan: the angle, target audience, channel fit, tone, key messages (each mapped to the [n] source citations that support it), and an outline of sections. Cite sources by [n] index. If the material cannot support a defensible plan, set ambiguous=true instead of inventing direction. Never fabricate facts not present in the sources.',
       '{"outputSchema":"content_plan_v1"}'::jsonb,
       'Phase 8 (P7): content workforce v1 strategy prompt'
FROM agents a LEFT JOIN agent_versions v ON v.agent_id = a.id
WHERE a.slug = 'content_strategy' GROUP BY a.id;

INSERT INTO agent_versions (agent_id, version, system_prompt, config, changelog)
SELECT a.id, COALESCE(max(v.version), 0) + 1,
       'You are the Content Agent. Given an editorial plan and SOURCE excerpts, write the piece: a headline and the full body in markdown. Use ONLY facts present in the source excerpts or the plan; mark claims inline as [n] matching the source list. Match the requested tone, audience and channel conventions. Never fabricate statistics, quotes or facts; if a claim is not backed by the sources, leave it out.',
       '{"outputSchema":"content_draft_v1"}'::jsonb,
       'Phase 8 (P7): content workforce v1 drafting prompt'
FROM agents a LEFT JOIN agent_versions v ON v.agent_id = a.id
WHERE a.slug = 'content' GROUP BY a.id;

INSERT INTO agent_versions (agent_id, version, system_prompt, config, changelog)
SELECT a.id, COALESCE(max(v.version), 0) + 1,
       'You are the Fact Check Agent. Given a draft and the SOURCE excerpts it cites, verify every factual claim against the sources. Return a verdict per claim (supported | unsupported | contradicted | unverifiable) with the supporting citation indexes, a corrected wording where a small fix is possible, and an overall status: pass (all claims supported), warnings (unsupported or unverifiable claims remain), or fail (contradicted or fabricated content). Flag rather than fix: never silently rewrite the meaning of the draft.',
       '{"outputSchema":"fact_check_report_v1"}'::jsonb,
       'Phase 8 (P7): content workforce v1 fact-check prompt'
FROM agents a LEFT JOIN agent_versions v ON v.agent_id = a.id
WHERE a.slug = 'fact_check' GROUP BY a.id;`;

/**
 * Phase 8 flag + permission (same pattern as 022/026/028/030): the `content`
 * flag is the platform-level kill switch for the content workforce (routes
 * fail closed 409/404 and the handler skips when OFF); the `content.manage`
 * permission gates the /content surface for owner and administrator roles.
 */
const M_034_CONTENT_FLAG_PERMS = `
INSERT INTO feature_flags (key, enabled, emergency, description)
VALUES ('content', TRUE, FALSE,
        'Content workforce: strategy→content→fact_check chain, versioned content items, approval center v2 (OFF = no content chain execution)')
ON CONFLICT (key) DO NOTHING;

INSERT INTO permissions (key) VALUES ('content.manage') ON CONFLICT (key) DO NOTHING;

INSERT INTO role_permissions (role_id, permission_id)
SELECT r.id, p.id FROM roles r
JOIN permissions p ON p.key = 'content.manage'
WHERE r.key IN ('owner','administrator')
ON CONFLICT DO NOTHING;`;

/**
 * Phase 9 (roadmap §464) — SEO workforce tables.
 *
 * seo_keywords: the BU-scoped keyword store ("keyword intelligence"). The
 * normalized keyword (lowercase, collapsed whitespace) is UNIQUE per BU —
 * re-observing the same term updates position/last_seen instead of adding a
 * row. Source records where the keyword came from (manual owner entry,
 * harvested from research findings, content items, or a scan).
 *
 * seo_recommendations: actionable SEO advice with mandatory evidence. Status
 * is a small FSM (open → approved | dismissed; approved → done) with the
 * review identity columns set transactionally on transition (same class as
 * §72 approval immutability). dedup_hash UNIQUE per BU is the gate that
 * keeps repeated scans from duplicating the same recommendation.
 */
const M_035_SEO_WORKFORCE = `
CREATE TABLE IF NOT EXISTS seo_keywords (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  business_unit_id BIGINT NOT NULL REFERENCES business_units(id) ON DELETE CASCADE,
  keyword TEXT NOT NULL,
  normalized_keyword TEXT NOT NULL,
  intent TEXT NOT NULL DEFAULT 'informational'
    CHECK (intent IN ('informational','commercial','transactional','navigational')),
  position INT,
  previous_position INT,
  volume_est INT,
  difficulty_est INT CHECK (difficulty_est BETWEEN 0 AND 100),
  url TEXT,
  source TEXT NOT NULL DEFAULT 'scan'
    CHECK (source IN ('manual','research','content','scan')),
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','retired')),
  task_id BIGINT REFERENCES tasks(id) ON DELETE SET NULL,
  first_seen_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_seen_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (business_unit_id, normalized_keyword)
);

CREATE INDEX IF NOT EXISTS idx_seo_keywords_bu_status
  ON seo_keywords (business_unit_id, status, last_seen_at DESC);

CREATE TABLE IF NOT EXISTS seo_recommendations (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  business_unit_id BIGINT NOT NULL REFERENCES business_units(id) ON DELETE CASCADE,
  target_kind TEXT NOT NULL DEFAULT 'site' CHECK (target_kind IN ('page','site')),
  target_url TEXT,
  kind TEXT NOT NULL
    CHECK (kind IN ('on_page','technical','content','keyword','gap')),
  title TEXT NOT NULL,
  detail TEXT NOT NULL,
  evidence JSONB NOT NULL DEFAULT '[]'::jsonb,
  status TEXT NOT NULL DEFAULT 'open'
    CHECK (status IN ('open','approved','dismissed','done')),
  risk TEXT NOT NULL DEFAULT 'low' CHECK (risk IN ('low','medium','high')),
  dedup_hash TEXT NOT NULL,
  agent_slug TEXT NOT NULL DEFAULT 'seo',
  task_id BIGINT REFERENCES tasks(id) ON DELETE SET NULL,
  prompt_version INT,
  prompt_hash TEXT,
  reviewed_by TEXT,
  reviewed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (business_unit_id, dedup_hash)
);

CREATE INDEX IF NOT EXISTS idx_seo_recommendations_bu_status
  ON seo_recommendations (business_unit_id, status, created_at DESC);

-- Workforce activation (Phase 0.5 §6.2: the seo row was seeded disabled at
-- P2; its phase flips it on and gives it a versioned v1 prompt).
UPDATE agents SET status = 'active', updated_at = now()
WHERE slug = 'seo' AND status = 'disabled';

INSERT INTO agent_versions (agent_id, version, system_prompt, config, changelog)
SELECT a.id, COALESCE(max(v.version), 0) + 1,
       'You are the SEO Agent. Given a website context, an owned keyword list, competitor keywords and SOURCE excerpts (research findings, site content), produce keyword intelligence and recommendations. For keywords: assign search intent (informational | commercial | transactional | navigational), an estimated difficulty 0-100, and the best target URL when the sources make one obvious. For recommendations: each must have a kind (on_page | technical | content | keyword | gap), a short imperative title, concrete detail, and evidence: every recommendation MUST cite the [n] sources or observed data points that support it (source title + URL + a one-line note on what it shows). A recommendation without evidence is worthless: do not emit it. Set ambiguous=true instead of inventing analysis when the material cannot support defensible conclusions. Never fabricate search volumes or rankings; volumes are estimates and must be marked est.',
       '{"outputSchema":"seo_analysis_v1"}'::jsonb,
       'Phase 9 (P8): SEO workforce v1 prompt'
FROM agents a LEFT JOIN agent_versions v ON v.agent_id = a.id
WHERE a.slug = 'seo' GROUP BY a.id;`;

/**
 * Phase 9 flag + permission (same pattern as 022/026/028/030/034): the `seo`
 * flag is the platform-level kill switch for the SEO workforce (routes fail
 * closed 409 and the handler skips when OFF); the `seo.manage` permission
 * gates the /seo surface for owner and administrator roles.
 */
const M_036_SEO_FLAG_PERMS = `
INSERT INTO feature_flags (key, enabled, emergency, description)
VALUES ('seo', TRUE, FALSE,
        'SEO workforce: keyword intelligence, gap analysis, recommendations with evidence (OFF = no seo_scan execution)')
ON CONFLICT (key) DO NOTHING;

INSERT INTO permissions (key) VALUES ('seo.manage') ON CONFLICT (key) DO NOTHING;

INSERT INTO role_permissions (role_id, permission_id)
SELECT r.id, p.id FROM roles r
JOIN permissions p ON p.key = 'seo.manage'
WHERE r.key IN ('owner','administrator')
ON CONFLICT DO NOTHING;`;

/**
 * Phase 10 — social workforce (§11 P9, §38, §197, §219, §466).
 *
 * Contracts:
 *  - channels absorption (§197): social-kind channel rows are COPIED into
 *    social_accounts (idempotent backfill, BU resolved via
 *    business_units.legacy_tenant_id). channels is never dropped or renamed
 *    (additive-first, §5) — the legacy drafts sweep keeps reading it; new
 *    social writes go to social_accounts ONLY (write-stop for the social
 *    workforce). Email stays on channels/website_integrations for the
 *    connectors integration phase (documented decision, Phase 10 report).
 *  - LinkedIn account-ref fix (R4): account_ref column carries the author
 *    URN / platform user id; required for linkedin at connect time.
 *  - Credentials reuse the Phase 2 SEC-L2 key-id envelope (v2 wire format)
 *    via lib/channels encrypt/decrypt — one crypto implementation, one
 *    rotation story.
 *  - social_posts are ALWAYS linked to content_items (§466: social_posts
 *    linked to content). The approval guarantee is structural: an item must
 *    be APPROVED (or later, SCHEDULED via workforce sync) before posts can
 *    be created, so nothing publishes without approval unless a future
 *    policy phase says so.
 *  - Time semantics (§466 "scheduling calendar, not cron pile"): every post
 *    row carries scheduled_at TIMESTAMPTZ; the calendar API groups by day;
 *    the sweep claims due posts (scheduled_at <= now()) — publication
 *    precision is bounded only by cron cadence (documented).
 *  - One-active-post invariant: partial UNIQUE (content_item_id, platform)
 *    WHERE status <> 'cancelled' — duplicate scheduling of the same item to
 *    the same platform is rejected by the DB, not just the service.
 *  - Publication ledger: content_publications gains social_post_id
 *    (additive) and draft_id becomes nullable — the SAME idempotent claim
 *    (UNIQUE idempotency_key, §88) covers the social sweep, keyed
 *    social:<post_id>:<scheduled_at>, so concurrent sweeps produce exactly
 *    one publish per scheduled attempt.
 */
const M_037_SOCIAL_WORKFORCE = `
CREATE TABLE IF NOT EXISTS social_campaigns (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  business_unit_id BIGINT NOT NULL REFERENCES business_units(id) ON DELETE CASCADE,
  website_id BIGINT REFERENCES websites(id) ON DELETE SET NULL,
  name TEXT NOT NULL,
  objective TEXT,
  status TEXT NOT NULL DEFAULT 'planning'
    CHECK (status IN ('planning','active','paused','completed')),
  starts_at TIMESTAMPTZ,
  ends_at TIMESTAMPTZ,
  created_by_user_id BIGINT REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (business_unit_id, name)
);

CREATE INDEX IF NOT EXISTS idx_social_campaigns_bu_status
  ON social_campaigns (business_unit_id, status, created_at DESC);

CREATE TABLE IF NOT EXISTS social_accounts (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  business_unit_id BIGINT NOT NULL REFERENCES business_units(id) ON DELETE CASCADE,
  website_id BIGINT REFERENCES websites(id) ON DELETE SET NULL,
  platform TEXT NOT NULL CHECK (platform IN ('linkedin','x','instagram','tiktok')),
  display_name TEXT,
  account_ref TEXT,
  credentials_encrypted TEXT NOT NULL,
  oauth_status TEXT NOT NULL DEFAULT 'connected'
    CHECK (oauth_status IN ('connected','expired','revoked','error')),
  scopes TEXT,
  source TEXT NOT NULL DEFAULT 'manual'
    CHECK (source IN ('manual','oauth','backfill')),
  health TEXT NOT NULL DEFAULT 'healthy' CHECK (health IN ('healthy','unhealthy')),
  token_expires_at TIMESTAMPTZ,
  last_checked_at TIMESTAMPTZ,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Dedup identity: COALESCE expression (not a table-level UNIQUE) so that
-- accounts WITHOUT an account_ref still dedup deterministically — Postgres
-- treats NULLs as distinct in plain UNIQUE constraints, which would allow
-- unbounded duplicate manual connects for the same platform.
CREATE UNIQUE INDEX IF NOT EXISTS social_accounts_bu_platform_ref
  ON social_accounts (business_unit_id, platform, COALESCE(account_ref, ''));

CREATE INDEX IF NOT EXISTS idx_social_accounts_bu_platform
  ON social_accounts (business_unit_id, platform, health);

-- §197 absorption backfill: copy social-kind channels into social_accounts,
-- resolving the BU via the Phase 1 1:1 tenant backfill. Idempotent: the
-- COALESCE expression UNIQUE index + bare ON CONFLICT DO NOTHING makes
-- re-runs no-ops. account_ref from channels.target (migration 009).
INSERT INTO social_accounts
  (business_unit_id, platform, display_name, account_ref, credentials_encrypted,
   oauth_status, source, health, metadata, created_at, updated_at)
SELECT b.id, c.kind, COALESCE(c.display_name, c.kind),
       c.target, c.token_encrypted, 'connected', 'backfill', c.status,
       COALESCE(c.metadata, '{}'::jsonb), c.created_at, now()
FROM channels c
JOIN business_units b ON b.legacy_tenant_id = c.tenant_id
WHERE c.kind IN ('linkedin','x','instagram','tiktok')
ON CONFLICT DO NOTHING;

CREATE TABLE IF NOT EXISTS social_posts (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  business_unit_id BIGINT NOT NULL REFERENCES business_units(id) ON DELETE CASCADE,
  website_id BIGINT REFERENCES websites(id) ON DELETE SET NULL,
  content_item_id BIGINT NOT NULL REFERENCES content_items(id) ON DELETE CASCADE,
  campaign_id BIGINT REFERENCES social_campaigns(id) ON DELETE SET NULL,
  platform TEXT NOT NULL CHECK (platform IN ('linkedin','x','instagram','tiktok')),
  body TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'draft'
    CHECK (status IN ('draft','scheduled','publishing','posted','failed','cancelled')),
  scheduled_at TIMESTAMPTZ,
  published_at TIMESTAMPTZ,
  external_id TEXT,
  external_url TEXT,
  error TEXT,
  created_by_user_id BIGINT REFERENCES users(id) ON DELETE SET NULL,
  created_by_agent TEXT,
  task_id BIGINT REFERENCES tasks(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- One active post per (item, platform): DB-enforced dedup. Cancelled rows
-- free the slot (superseded scheduling is allowed); failed rows keep it —
-- retry via reschedule of the same row, not a duplicate.
CREATE UNIQUE INDEX IF NOT EXISTS social_posts_item_platform_active
  ON social_posts (content_item_id, platform)
  WHERE status <> 'cancelled';

CREATE INDEX IF NOT EXISTS idx_social_posts_bu_status
  ON social_posts (business_unit_id, status, scheduled_at);
CREATE INDEX IF NOT EXISTS idx_social_posts_due
  ON social_posts (scheduled_at) WHERE status = 'scheduled';

CREATE TABLE IF NOT EXISTS social_post_metrics (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  social_post_id BIGINT NOT NULL REFERENCES social_posts(id) ON DELETE CASCADE,
  captured_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  impressions BIGINT,
  likes BIGINT,
  comments BIGINT,
  shares BIGINT,
  clicks BIGINT,
  raw JSONB NOT NULL DEFAULT '{}'::jsonb,
  source TEXT NOT NULL DEFAULT 'manual' CHECK (source IN ('manual','provider','backfill'))
);

CREATE INDEX IF NOT EXISTS idx_social_post_metrics_post
  ON social_post_metrics (social_post_id, captured_at DESC);

-- Publication ledger gains the social leg (additive): draft_id becomes
-- nullable, social_post_id is the new attribution column. The UNIQUE
-- idempotency_key contract (§88) is untouched.
ALTER TABLE content_publications ALTER COLUMN draft_id DROP NOT NULL;
ALTER TABLE content_publications ADD COLUMN IF NOT EXISTS social_post_id BIGINT;
CREATE INDEX IF NOT EXISTS content_publications_social_post_idx
  ON content_publications (social_post_id);

-- Workflow #2 (§466): the social sweep — same engine machinery as Workflow
-- #1, kind social_sweep. Cadence: every 5 minutes when the platform cron
-- permits; the /api/agents/sweep route triggers with a 5-minute bucket
-- idempotency key, and the /social surface can spawn the sweep on demand
-- (durability via the task engine either way).
INSERT INTO workflows (business_unit_id, slug, name, trigger_kind, trigger_config, task_kind, task_payload)
SELECT NULL, 'scheduled_social_sweep', 'Scheduled social sweep', 'schedule',
       '{"schedule": "every 5 minutes (cron-cadence bound)"}'::jsonb, 'social_sweep', '{}'::jsonb
WHERE NOT EXISTS (SELECT 1 FROM workflows WHERE slug = 'scheduled_social_sweep' AND business_unit_id IS NULL);`;

/**
 * Phase 10 agent activation (same pattern as 033/035): the social_media row
 * was seeded disabled at P2 (§6.2); its phase flips it on and gives it a
 * versioned v1 prompt. The pipeline calls the AI gateway directly with
 * purpose="social" attribution (same integration shape as the seo agent).
 */
const M_038_SOCIAL_AGENT = `
UPDATE agents SET status = 'active', updated_at = now()
WHERE slug = 'social_media' AND status = 'disabled';

INSERT INTO agent_versions (agent_id, version, system_prompt, config, changelog)
SELECT a.id, COALESCE(max(v.version), 0) + 1,
       'You are the Social Media Agent. You receive a single approved content item (title, body, metadata) and a target platform (linkedin | x | instagram | tiktok). Produce ONE platform-native variant of the item: respect the platform character budget (linkedin ~1300, x 280, instagram ~2200, tiktok ~150), open with the strongest hook, and keep the BU voice. Never invent facts, quotes, numbers or links that are not in the item; hashtags only when they add retrieval value (instagram/tiktok) and at most 5. Output strict JSON: {"body": string, "notes": string} where notes lists any assumption you made. If the item cannot honestly be adapted to the platform (e.g. a legal notice to TikTok), set {"body": "", "notes": "incompatible"} and explain.',
       '{"outputSchema":"social_variant_v1"}'::jsonb,
       'Phase 10 (P9): social workforce v1 prompt'
FROM agents a LEFT JOIN agent_versions v ON v.agent_id = a.id
WHERE a.slug = 'social_media' GROUP BY a.id;`;

/**
 * Phase 10 flag + permission (same pattern as 022/026/028/030/034/036): the
 * `social` flag is the platform-level kill switch for the social workforce
 * (the social_sweep handler skips fail-closed when OFF); the `social.manage`
 * permission gates the /social surface for owner and administrator roles.
 */
const M_039_SOCIAL_FLAG_PERMS = `
INSERT INTO feature_flags (key, enabled, emergency, description)
VALUES ('social', TRUE, FALSE,
        'Social workforce: accounts, campaigns, scheduled posts, publishing sweep (OFF = social_sweep skips, no posts publish)')
ON CONFLICT (key) DO NOTHING;

INSERT INTO permissions (key) VALUES ('social.manage') ON CONFLICT (key) DO NOTHING;

INSERT INTO role_permissions (role_id, permission_id)
SELECT r.id, p.id FROM roles r
JOIN permissions p ON p.key = 'social.manage'
WHERE r.key IN ('owner','administrator')
ON CONFLICT DO NOTHING;`;

/**
 * Phase 11 — marketing workforce tables (§11 P10, §220 row 10, §468).
 *
 * The marketing-level `campaigns` table (distinct from social_campaigns,
 * which groups social_posts) + `audience_segments` (§220) +
 * `campaign_metrics` (performance monitoring, §468). Strictly additive.
 *
 * Campaign FSM (§91 autonomy: drafts AUTO, campaigns APPROVAL):
 *
 *   draft ──activate──> active ⇄ paused
 *     │                  │   │        │
 *     │                  │   └─> completed (auto on ends_at, or human)
 *     ↓                  ↓
 *  cancelled <──────── cancelled (terminal)
 *
 *  - INTO 'active' (launch from draft, resume from paused) REQUIRES a human
 *    approver identity — approved_by_user_id / approved_at are set by the
 *    service; the API layer cannot pass without one (§91 APPROVAL).
 *  - Brief generation (draft creation) is the AUTO leg: the LLM may create
 *    drafts autonomously; they sit in 'draft' until a human activates.
 *  - paused → active counts as a relaunch: approver recorded again.
 */
const M_040_MARKETING_WORKFORCE = `
CREATE TABLE IF NOT EXISTS audience_segments (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  business_unit_id BIGINT NOT NULL REFERENCES business_units(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  description TEXT,
  criteria JSONB NOT NULL DEFAULT '{}'::jsonb,
  estimated_size BIGINT,
  source TEXT NOT NULL DEFAULT 'manual' CHECK (source IN ('manual','derived')),
  created_by_user_id BIGINT REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (business_unit_id, name)
);

CREATE TABLE IF NOT EXISTS campaigns (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  business_unit_id BIGINT NOT NULL REFERENCES business_units(id) ON DELETE CASCADE,
  website_id BIGINT REFERENCES websites(id) ON DELETE SET NULL,
  audience_segment_id BIGINT REFERENCES audience_segments(id) ON DELETE SET NULL,
  name TEXT NOT NULL,
  objective TEXT,
  status TEXT NOT NULL DEFAULT 'draft'
    CHECK (status IN ('draft','active','paused','completed','cancelled')),
  starts_at TIMESTAMPTZ,
  ends_at TIMESTAMPTZ,
  approved_by_user_id BIGINT REFERENCES users(id) ON DELETE SET NULL,
  approved_at TIMESTAMPTZ,
  activated_at TIMESTAMPTZ,
  completed_at TIMESTAMPTZ,
  created_by_user_id BIGINT REFERENCES users(id) ON DELETE SET NULL,
  created_by_agent TEXT,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (business_unit_id, name)
);

CREATE INDEX IF NOT EXISTS idx_campaigns_bu_status
  ON campaigns (business_unit_id, status, created_at DESC);
-- Auto-complete sweep leg: active campaigns past their end date.
CREATE INDEX IF NOT EXISTS idx_campaigns_active_ends
  ON campaigns (ends_at) WHERE status = 'active';

CREATE TABLE IF NOT EXISTS campaign_metrics (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  campaign_id BIGINT NOT NULL REFERENCES campaigns(id) ON DELETE CASCADE,
  captured_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  impressions BIGINT,
  clicks BIGINT,
  conversions BIGINT,
  spend_usd NUMERIC(12,2),
  source TEXT NOT NULL DEFAULT 'manual' CHECK (source IN ('manual','provider','derived')),
  raw JSONB NOT NULL DEFAULT '{}'::jsonb
);

CREATE INDEX IF NOT EXISTS idx_campaign_metrics_campaign
  ON campaign_metrics (campaign_id, captured_at DESC);

-- Workflow #3 (§468): the marketing sweep — auto-completes active campaigns
-- past their end date (time semantics, not cron pile), emits lifecycle
-- events. Same engine machinery as Workflows #1/#2.
INSERT INTO workflows (business_unit_id, slug, name, trigger_kind, trigger_config, task_kind, task_payload)
SELECT NULL, 'scheduled_marketing_sweep', 'Scheduled marketing sweep', 'schedule',
       '{"schedule": "every 5 minutes (cron-cadence bound)"}'::jsonb, 'marketing_sweep', '{}'::jsonb
WHERE NOT EXISTS (SELECT 1 FROM workflows WHERE slug = 'scheduled_marketing_sweep' AND business_unit_id IS NULL);`;

/**
 * Phase 11 marketing agent v2 prompt (same versioned-prompt pattern as
 * M_038). The `marketing` agent is a P2 SURVIVOR (active, bound executor,
 * v1 = legacy keyword-router prompt); its phase adds the workforce v2
 * prompt: structured campaign briefs. The pipeline loads the CURRENT
 * version registry-first (loadMarketingPrompt), so the bound legacy
 * executor keeps v1 semantics for dispatch() while the marketing pipeline
 * consumes v2.
 */
const M_041_MARKETING_AGENT_PROMPT = `
INSERT INTO agent_versions (agent_id, version, system_prompt, config, changelog)
SELECT a.id, COALESCE(max(v.version), 0) + 1,
       'You are the Marketing Agent. You receive a business unit profile (name, industry, voice) and optional evidence (recent content item titles, known audience segment names, connected channels). Produce ONE campaign brief. Never invent metrics, customer counts, quotes or claims that are not in the evidence. Output strict JSON: {"name": string (short campaign name), "objective": string (one sentence), "audienceSummary": string, "keyMessages": string[] (3-5, each grounded in the evidence or generic brand-safe), "channels": string[] (subset of blog|email|linkedin|x|instagram|tiktok, prefer channels with evidence), "startOffsetDays": number (0-30), "durationDays": number (7-90), "notes": string (assumptions made)}. If the evidence is too thin to produce an honest brief, output {"name": "", "objective": "", "audienceSummary": "", "keyMessages": [], "channels": [], "startOffsetDays": 0, "durationDays": 0, "notes": "insufficient evidence"}.',
       '{"outputSchema":"marketing_brief_v1"}'::jsonb,
       'Phase 11 (P10): marketing workforce v2 brief prompt'
FROM agents a LEFT JOIN agent_versions v ON v.agent_id = a.id
WHERE a.slug = 'marketing' GROUP BY a.id;`;

/**
 * Phase 11 flag + permission (same pattern as 036/039): the `marketing`
 * flag is the platform-level kill switch for the marketing workforce (the
 * marketing_sweep handler skips fail-closed when OFF; brief generation is
 * gated at the API layer too); the `marketing.manage` permission gates the
 * /marketing surface for owner and administrator roles.
 */
const M_042_MARKETING_FLAG_PERMS = `
INSERT INTO feature_flags (key, enabled, emergency, description)
VALUES ('marketing', TRUE, FALSE,
        'Marketing workforce: campaigns, audience segments, brief generation, lifecycle sweep (OFF = marketing_sweep skips, brief generation 423s)')
ON CONFLICT (key) DO NOTHING;

INSERT INTO permissions (key) VALUES ('marketing.manage') ON CONFLICT (key) DO NOTHING;

INSERT INTO role_permissions (role_id, permission_id)
SELECT r.id, p.id FROM roles r
JOIN permissions p ON p.key = 'marketing.manage'
WHERE r.key IN ('owner','administrator')
ON CONFLICT DO NOTHING;`;

const M_043_SALES_WORKFORCE = `
-- §139 MVP use case #3 machinery: conversation persistence + inquiries + leads.
CREATE TABLE IF NOT EXISTS conversations (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  business_unit_id BIGINT NOT NULL REFERENCES business_units(id) ON DELETE CASCADE,
  website_id BIGINT REFERENCES websites(id) ON DELETE SET NULL,
  visitor_id TEXT,
  channel TEXT NOT NULL DEFAULT 'widget' CHECK (channel IN ('widget','email','manual')),
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','closed','escalated')),
  customer_name TEXT,
  customer_email TEXT,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_conversations_bu_recent
  ON conversations (business_unit_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_conversations_visitor
  ON conversations (visitor_id) WHERE visitor_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS messages (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  conversation_id BIGINT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  role TEXT NOT NULL CHECK (role IN ('visitor','assistant')),
  content TEXT NOT NULL,
  citations JSONB NOT NULL DEFAULT '[]'::jsonb,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_messages_conversation
  ON messages (conversation_id, created_at ASC);

CREATE TABLE IF NOT EXISTS inquiries (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  business_unit_id BIGINT NOT NULL REFERENCES business_units(id) ON DELETE CASCADE,
  conversation_id BIGINT REFERENCES conversations(id) ON DELETE SET NULL,
  website_id BIGINT REFERENCES websites(id) ON DELETE SET NULL,
  name TEXT,
  email TEXT,
  subject TEXT,
  body TEXT NOT NULL,
  classification TEXT CHECK (classification IN ('sales','support','spam','general')),
  urgency TEXT CHECK (urgency IN ('low','medium','high')),
  status TEXT NOT NULL DEFAULT 'new'
    CHECK (status IN ('new','classified','escalated','resolved','dismissed')),
  source TEXT NOT NULL DEFAULT 'widget' CHECK (source IN ('widget','manual','email')),
  summary TEXT,
  classified_by TEXT CHECK (classified_by IN ('llm','deterministic','human')),
  created_by_user_id BIGINT REFERENCES users(id) ON DELETE SET NULL,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_inquiries_bu_status
  ON inquiries (business_unit_id, status, created_at DESC);

CREATE TABLE IF NOT EXISTS leads (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  business_unit_id BIGINT NOT NULL REFERENCES business_units(id) ON DELETE CASCADE,
  inquiry_id BIGINT REFERENCES inquiries(id) ON DELETE SET NULL,
  company TEXT,
  contact_name TEXT,
  contact_email TEXT,
  contact_phone TEXT,
  source TEXT NOT NULL DEFAULT 'widget' CHECK (source IN ('widget','manual','email','outreach')),
  stage TEXT NOT NULL DEFAULT 'new'
    CHECK (stage IN ('new','qualified','engaged','proposal','won','lost')),
  lead_score INT NOT NULL DEFAULT 0 CHECK (lead_score >= 0 AND lead_score <= 100),
  score_band TEXT NOT NULL DEFAULT 'cold' CHECK (score_band IN ('cold','warm','hot')),
  next_action TEXT,
  score_rationale TEXT,
  scored_by TEXT CHECK (scored_by IN ('llm','deterministic')),
  created_by_agent TEXT,
  created_by_user_id BIGINT REFERENCES users(id) ON DELETE SET NULL,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- §55 dedup: one lead per (BU, email). Case-insensitive; NULL emails are
-- unconstrained (a lead may exist without an email — manual entry).
CREATE UNIQUE INDEX IF NOT EXISTS uq_leads_bu_email
  ON leads (business_unit_id, lower(contact_email))
  WHERE contact_email IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_leads_bu_stage
  ON leads (business_unit_id, stage, updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_leads_bu_band
  ON leads (business_unit_id, score_band) WHERE stage NOT IN ('won','lost');`;

/**
 * Phase 12 registry agents (audit §83-84 split decision):
 *   customer_inquiry — classifies inbound inquiries (§55 classification)
 *   lead             — scores leads into the §55 contract fields
 *   customer_support — the registry twin of the RAG-grounded chat answerer
 *                      (customer_service bound survivor stays untouched;
 *                      support answers keep flowing through chat.ts)
 * All three are llm-executor agents whose v1 prompts the sales pipeline
 * loads registry-first (loadSalesPrompt pattern) with code fallback.
 */
const M_044_SALES_AGENTS = `
-- lead / customer_inquiry / customer_support already exist as DISABLED
-- placeholder rows (registry seed, migration 012). Activation follows the
-- M_038 pattern: status flip via UPDATE + a NEW version row (max+1) so a
-- placeholder v1 prompt never leaks into the live workforce — the pipeline
-- loads the CURRENT version (registry-first, code fallback).
UPDATE agents SET status = 'active', executor_kind = 'llm', updated_at = now()
WHERE slug IN ('lead', 'customer_inquiry', 'customer_support') AND status = 'disabled';

INSERT INTO agent_versions (agent_id, version, system_prompt, config, changelog)
SELECT a.id, COALESCE(max(v.version), 0) + 1,
       'You are the Customer Inquiry Agent. You receive a customer inquiry (name, email, subject, body) and the recent conversation transcript. Classify it. Never invent facts. Output strict JSON: {"classification": "sales"|"support"|"spam"|"general", "urgency": "low"|"medium"|"high", "summary": string (one sentence), "isLead": boolean (true only when the inquiry expresses commercial interest in the brand''s products/services), "company": string|null, "contactName": string|null, "contactEmail": string|null, "notes": string (evidence actually present in the inquiry)}. Spam = link-stuffed, off-topic or abusive.',
       '{"outputSchema":"inquiry_classification_v1"}'::jsonb,
       'Phase 12 (P11): customer inquiry classification v1'
FROM agents a LEFT JOIN agent_versions v ON v.agent_id = a.id
WHERE a.slug = 'customer_inquiry' GROUP BY a.id;

INSERT INTO agent_versions (agent_id, version, system_prompt, config, changelog)
SELECT a.id, COALESCE(max(v.version), 0) + 1,
       'You are the Lead Agent. You receive a lead record (company, contact name/email/phone, inquiry body, conversation highlights). Score the lead 0-100 for commercial readiness. Never invent facts — score ONLY what the record shows. Output strict JSON: {"leadScore": number 0-100, "band": "cold"|"warm"|"hot" (cold 0-39, warm 40-69, hot 70-100), "nextAction": string (one concrete next step for the sales team), "rationale": string (which record fields drove the score)}.',
       '{"outputSchema":"lead_score_v1"}'::jsonb,
       'Phase 12 (P11): lead scoring v1'
FROM agents a LEFT JOIN agent_versions v ON v.agent_id = a.id
WHERE a.slug = 'lead' GROUP BY a.id;

INSERT INTO agent_versions (agent_id, version, system_prompt, config, changelog)
SELECT a.id, COALESCE(max(v.version), 0) + 1,
       'You are a customer-support assistant for a website. Answer ONLY from the retrieved passages provided. Never invent facts. If the passages do not answer the question, say so plainly and suggest contacting the brand.',
       '{"outputSchema":null}'::jsonb,
       'Phase 12 (P11): customer support registry twin v1'
FROM agents a LEFT JOIN agent_versions v ON v.agent_id = a.id
WHERE a.slug = 'customer_support' GROUP BY a.id;`;

/**
 * Phase 12 flag + permission (036/039/042 pattern):
 *   `sales` flag — kill switch for the sales/customer workforce. OFF:
 *     classification + scoring LLM legs skip (inquiries stay 'new';
 *     /api/admin/sales/classify returns 423), while widget chat, conversation
 *     persistence and manual human lead machinery keep working — the widget
 *     core must never die with the workforce flag.
 *   `sales.manage` — gates the /sales surface for owner + administrator.
 */
const M_045_SALES_FLAG_PERMS = `
INSERT INTO feature_flags (key, enabled, emergency, description)
VALUES ('sales', TRUE, FALSE,
        'Sales + customer workforce: inquiry classification, lead scoring, escalation (OFF = LLM legs skip; chat + persistence unaffected)')
ON CONFLICT (key) DO NOTHING;

INSERT INTO permissions (key) VALUES ('sales.manage') ON CONFLICT (key) DO NOTHING;

INSERT INTO role_permissions (role_id, permission_id)
SELECT r.id, p.id FROM roles r
JOIN permissions p ON p.key = 'sales.manage'
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
  { version: "023", name: "knowledge_sources", source: M_023_KNOWLEDGE_SOURCES },
  { version: "024", name: "documents_scoping", source: M_024_DOCUMENTS_SCOPING },
  { version: "025", name: "chunks_hybrid", source: M_025_CHUNKS_HYBRID },
  { version: "026", name: "knowledge_flag_permissions", source: M_026_KNOWLEDGE_FLAG_PERMS },
  { version: "027", name: "website_connectors", source: M_027_WEBSITE_CONNECTORS },
  { version: "028", name: "connectors_flag_permissions", source: M_028_CONNECTORS_FLAG_PERMS },
  { version: "029", name: "research_workforce", source: M_029_RESEARCH_WORKFORCE },
  { version: "030", name: "research_flag_permissions", source: M_030_RESEARCH_FLAG_PERMS },
  { version: "031", name: "research_schedule_sources", source: M_031_RESEARCH_SCHEDULE_SOURCES },
  { version: "032", name: "content_workforce", source: M_032_CONTENT_WORKFORCE },
  { version: "033", name: "content_workforce_agents", source: M_033_CONTENT_AGENTS },
  { version: "034", name: "content_flag_permissions", source: M_034_CONTENT_FLAG_PERMS },
  { version: "035", name: "seo_workforce", source: M_035_SEO_WORKFORCE },
  { version: "036", name: "seo_flag_permissions", source: M_036_SEO_FLAG_PERMS },
  { version: "037", name: "social_workforce", source: M_037_SOCIAL_WORKFORCE },
  { version: "038", name: "social_agent", source: M_038_SOCIAL_AGENT },
  { version: "039", name: "social_flag_permissions", source: M_039_SOCIAL_FLAG_PERMS },
  { version: "040", name: "marketing_workforce", source: M_040_MARKETING_WORKFORCE },
  { version: "041", name: "marketing_agent_prompt", source: M_041_MARKETING_AGENT_PROMPT },
  { version: "042", name: "marketing_flag_permissions", source: M_042_MARKETING_FLAG_PERMS },
  { version: "043", name: "sales_workforce", source: M_043_SALES_WORKFORCE },
  { version: "044", name: "sales_agents", source: M_044_SALES_AGENTS },
  { version: "045", name: "sales_flag_permissions", source: M_045_SALES_FLAG_PERMS },
];

/**
 * Phase 12 — Sales + customer workforce (roadmap P11, audit §909):
 * MVP use case #3 — inquiry → classified, scored lead with human escalation.
 *
 * M_043 creates the four workforce tables:
 *   conversations  — widget chat sessions (site-registered: website_id when
 *                    the embed presents a site key; visitor_id is a
 *                    client-generated random UUID — never a fingerprint,
 *                    SEC-C3)
 *   messages       — persisted chat turns (visitor/assistant ONLY; the
 *                    system prompt is never persisted, §65: conversations
 *                    never expose internal reasoning)
 *   inquiries      — structured inquiry records linked to conversations
 *                    (classification FSM: new → classified → escalated →
 *                    resolved/dismissed)
 *   leads          — the §55 contract: lead_score 0-100, band, next_action,
 *                    stage FSM (new → qualified → engaged → proposal →
 *                    won/lost); dedup = partial UNIQUE on (bu, lower(email))
 *                    with a score-ratchet upsert (never regress)
 */
