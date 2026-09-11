/**
 * System settings + feature flags + emergency flags (Phase 1 M3; SEC-L8 v1).
 *
 * feature_flags carries the Phase 1 emergency controls:
 *   - stop_all_agents: blocks agent LLM execution paths (agents/run, chat)
 *   - disable_publishing: blocks the scheduled publishing sweep
 *   - legacy_bearer_auth: Phase 1 transition flag — when off, guarded admin
 *     endpoints accept session cookies only (final bearer cutover).
 *
 * system_settings holds simple runtime configuration (JSONB values).
 * Secrets never live in either table.
 */
import { query } from "./db";

export interface FeatureFlag {
  key: string;
  enabled: boolean;
  emergency: boolean;
  description: string | null;
  updatedAt: string;
}

export async function listFeatureFlags(): Promise<FeatureFlag[]> {
  const rows = await query<{
    key: string; enabled: boolean; emergency: boolean; description: string | null; updated_at: string;
  }>(
    `SELECT key, enabled, emergency, description, updated_at
     FROM feature_flags ORDER BY emergency DESC, key ASC`
  );
  return rows.map((r) => ({
    key: r.key,
    enabled: r.enabled,
    emergency: r.emergency,
    description: r.description,
    updatedAt: r.updated_at,
  }));
}

/** Single-flag read with a safe fallback when the table is absent (cold boot). */
export async function isFlagEnabled(key: string, fallback = false): Promise<boolean> {
  try {
    const rows = await query<{ enabled: boolean }>(
      "SELECT enabled FROM feature_flags WHERE key = $1",
      [key]
    );
    return rows.length > 0 ? rows[0].enabled : fallback;
  } catch {
    return fallback;
  }
}

export async function setFeatureFlag(
  key: string,
  enabled: boolean,
  updatedByUserId: number | null
): Promise<FeatureFlag | null> {
  const rows = await query<{
    key: string; enabled: boolean; emergency: boolean; description: string | null; updated_at: string;
  }>(
    `UPDATE feature_flags
     SET enabled = $2, updated_by_user_id = $3, updated_at = now()
     WHERE key = $1
     RETURNING key, enabled, emergency, description, updated_at`,
    [key, enabled, updatedByUserId]
  );
  const r = rows[0];
  return r
    ? { key: r.key, enabled: r.enabled, emergency: r.emergency, description: r.description, updatedAt: r.updated_at }
    : null;
}

export async function listSystemSettings(): Promise<Record<string, unknown>> {
  const rows = await query<{ key: string; value: unknown }>(
    "SELECT key, value FROM system_settings ORDER BY key ASC"
  );
  return Object.fromEntries(rows.map((r) => [r.key, r.value]));
}

export async function setSystemSetting(
  key: string,
  value: unknown,
  updatedByUserId: number | null
): Promise<void> {
  await query(
    `INSERT INTO system_settings (key, value, updated_by_user_id, updated_at)
     VALUES ($1, $2::jsonb, $3, now())
     ON CONFLICT (key) DO UPDATE
       SET value = EXCLUDED.value, updated_by_user_id = EXCLUDED.updated_by_user_id, updated_at = now()`,
    [key, JSON.stringify(value), updatedByUserId]
  );
}
