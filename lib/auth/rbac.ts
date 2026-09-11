/**
 * RBAC queries (Phase 1 M1 — Phase 0.5 §12.6).
 *
 * roles × permissions × role_permissions × user_roles. Roles seeded by
 * migration 004: owner / administrator / operator / reviewer active;
 * analyst / developer / agent seeded inactive for later phases.
 *
 * BU scoping: user_roles.business_unit_id NULL = global (all BUs);
 * a non-null value scopes the role grant to that business unit.
 * Owner/Administrator are global by role. (Agent machine identities are a
 * Phase 2 model — the "agent" role exists structurally but is inactive.)
 */
import { query } from "../db";

export async function roleKeysForUser(userId: number): Promise<string[]> {
  const rows = await query<{ key: string }>(
    `SELECT DISTINCT r.key
     FROM user_roles ur
     JOIN roles r ON r.id = ur.role_id
     WHERE ur.user_id = $1 AND r.is_active`,
    [userId]
  );
  return rows.map((r) => r.key);
}

export async function permissionsForUser(userId: number): Promise<string[]> {
  const rows = await query<{ key: string }>(
    `SELECT DISTINCT p.key
     FROM user_roles ur
     JOIN roles r ON r.id = ur.role_id AND r.is_active
     JOIN role_permissions rp ON rp.role_id = r.id
     JOIN permissions p ON p.id = rp.permission_id
     WHERE ur.user_id = $1`,
    [userId]
  );
  return rows.map((r) => r.key);
}

export async function hasPermission(userId: number, permission: string): Promise<boolean> {
  const perms = await permissionsForUser(userId);
  return perms.includes(permission);
}

export interface BuScope {
  kind: "all" | "list";
  businessUnitIds: number[];
}

/**
 * BU access for a user: "all" for global roles (owner/administrator) or any
 * global (NULL bu) assignment; otherwise the union of assigned BU ids.
 */
export async function buScopeForUser(userId: number): Promise<BuScope> {
  const roleRows = await query<{ key: string }>(
    `SELECT DISTINCT r.key FROM user_roles ur JOIN roles r ON r.id = ur.role_id
     WHERE ur.user_id = $1 AND r.is_active AND r.key IN ('owner','administrator')`,
    [userId]
  );
  if (roleRows.length > 0) return { kind: "all", businessUnitIds: [] };

  const scoped = await query<{ all_scope: number }>(
    `SELECT count(*)::int AS all_scope FROM user_roles ur
     WHERE ur.user_id = $1 AND ur.business_unit_id IS NULL`,
    [userId]
  );
  if (scoped[0].all_scope > 0) return { kind: "all", businessUnitIds: [] };

  const list = await query<{ business_unit_id: number }>(
    `SELECT DISTINCT ur.business_unit_id FROM user_roles ur
     WHERE ur.user_id = $1 AND ur.business_unit_id IS NOT NULL`,
    [userId]
  );
  return { kind: "list", businessUnitIds: list.map((r) => r.business_unit_id) };
}
