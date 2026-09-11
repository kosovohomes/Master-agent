/**
 * Phase 1 migration ledger — one entry per version, strictly additive.
 *
 * Authority: PHASE-0.5-Final-Architecture-Reconciliation.md §12.3:
 *   001 schema_migrations · 002 audit_logs · 003 users, sessions ·
 *   004 roles/permissions (+seed) · 005 system_settings, feature_flags ·
 *   006 tenant_usage_daily · 007 business_units + websites (+1:1 backfill) ·
 *   008 website_integrations, website_capabilities (structure only) ·
 *   009 channels ADD target/metadata/display_name · 010 approvals ADD reviewer_user_id
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
];
