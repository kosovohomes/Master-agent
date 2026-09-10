import { listDraftsByTenant } from "./agents/approval";
import type { DraftRow } from "./agents/approval";
import { safeEqual } from "./security";

export function authorizeAdmin(token: string | null): boolean {
  const expected = process.env.ADMIN_PASSWORD;
  return Boolean(expected) && safeEqual(token, expected);
}

export async function listDraftsForAdmin(tenantId: number): Promise<DraftRow[]> {
  return listDraftsByTenant(tenantId);
}