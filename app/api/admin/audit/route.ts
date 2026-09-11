import { NextResponse } from "next/server";
import { query } from "@/lib/db";
import { requirePermission } from "@/lib/auth/guards";
import { requestIdFor } from "@/lib/audit";

export const runtime = "nodejs";

/**
 * GET /api/admin/audit — audit viewer reads (audit.read).
 * Supports ?limit= (max 500, default 100), ?action= prefix filter,
 * ?result= filter. Records contain actor identity, action, resource,
 * result, correlation id, and sanitized metadata only.
 */
export async function GET(req: Request) {
  const requestId = requestIdFor(req);
  const gate = await requirePermission(req, "audit.read");
  if (!gate.ok) return gate.response;

  const params = new URL(req.url).searchParams;
  const limitRaw = params.get("limit") ?? "100";
  const limit = /^\d+$/.test(limitRaw) ? Math.min(Number(limitRaw), 500) : 100;
  const action = params.get("action");
  const result = params.get("result");

  const where: string[] = [];
  const values: unknown[] = [];
  if (action) {
    values.push(`${action}%`);
    where.push(`action LIKE $${values.length}`);
  }
  if (result && ["success", "failure", "denied"].includes(result)) {
    values.push(result);
    where.push(`result = $${values.length}`);
  }
  const whereSql = where.length > 0 ? `WHERE ${where.join(" AND ")}` : "";

  const rows = await query<any>(
    `SELECT id, created_at, actor_type, actor_id, actor_label, action, resource,
            resource_id, result, request_id, ip, metadata
     FROM audit_logs ${whereSql}
     ORDER BY id DESC
     LIMIT ${limit}`,
    values
  );
  return NextResponse.json({ data: rows, meta: { requestId, limit } });
}
