import { NextResponse } from "next/server";
import { authorizeOpsOrAdmin } from "@/lib/admin";
import { MIGRATION_DDL, AGENTOS_TABLES } from "@/lib/migrations";
import { query } from "@/lib/db";

export const runtime = "nodejs";

/**
 * POST /api/admin/migrate
 * Bearer-guarded (ADMIN_PASSWORD or OPS_TOKEN). Applies the idempotent
 * AgentOS schema to the DATABASE_URL of the current environment.
 * Lets a fresh deployment (Vercel, container, etc.) bootstrap its DB
 * without local terminal access.
 */
export async function POST(req: Request) {
  const token = req.headers.get("authorization")?.replace("Bearer ", "") ?? null;
  if (!authorizeOpsOrAdmin(token)) {
    return NextResponse.json({ errors: [{ code: "UNAUTHORIZED" }] }, { status: 401 });
  }
  try {
    await query(MIGRATION_DDL);
    const placeholders = AGENTOS_TABLES.map((_, i) => `$${i + 1}`).join(",");
    const [row] = await query<{ n: number }>(
      `SELECT count(*)::int AS n FROM pg_tables WHERE schemaname = 'public' AND tablename IN (${placeholders})`,
      [...AGENTOS_TABLES]
    );
    return NextResponse.json({ data: { migrated: true, tables: row.n, expected: AGENTOS_TABLES.length } });
  } catch (e) {
    return NextResponse.json(
      { errors: [{ code: "MIGRATION_FAILED", detail: e instanceof Error ? e.message : "unknown error" }] },
      { status: 500 }
    );
  }
}
