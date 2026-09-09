import { query } from "./db";

export interface WidgetConfig {
  tenantId: number;
  brand: string;
}

export async function getWidgetConfig(tenantLookup: string): Promise<WidgetConfig> {
  const numeric = /^\d+$/.test(tenantLookup) ? Number(tenantLookup) : null;
  const rows = await query<{ id: number; name: string }>(
    numeric !== null
      ? "SELECT id, name FROM tenants WHERE id = $1 AND status = 'active'"
      : "SELECT id, name FROM tenants WHERE slug = $1 AND status = 'active'",
    [numeric !== null ? numeric : tenantLookup]
  );
  if (rows.length === 0) throw new Error("unknown tenant");
  return { tenantId: rows[0].id, brand: rows[0].name };
}