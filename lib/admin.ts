import { listDraftsByTenant } from "./agents/approval";
import type { DraftRow } from "./agents/approval";
import { safeEqual } from "./security";

export function authorizeAdmin(token: string | null): boolean {
  const expected = process.env.ADMIN_PASSWORD;
  return Boolean(expected) && safeEqual(token, expected);
}

/**
 * Same trust level as authorizeAdmin, but also accepts a dedicated ops key
 * (OPS_TOKEN) so automation can run operational endpoints (e.g. DB migrate)
 * without sharing the dashboard password. Set OPS_TOKEN to enable; optional.
 */
export function authorizeOpsOrAdmin(token: string | null): boolean {
  const ops = process.env.OPS_TOKEN;
  if (ops && safeEqual(token, ops)) return true;
  return authorizeAdmin(token);
}

export async function listDraftsForAdmin(tenantId: number): Promise<DraftRow[]> {
  return listDraftsByTenant(tenantId);
}