import { NextResponse } from "next/server";
import { authorizeOpsOrAdmin } from "@/lib/admin";
import { runMigrations } from "@/lib/migrations";
import { AGENTOS_TABLES } from "@/lib/migrations-legacy";
import { query } from "@/lib/db";
import { writeAudit, requestIdFor } from "@/lib/audit";

export const runtime = "nodejs";

/**
 * POST /api/admin/migrate
 * Bearer-guarded (ADMIN_PASSWORD or OPS_TOKEN). Applies the versioned,
 * ledgered migration set (lib/migrations/) to the DATABASE_URL of the
 * current environment. Idempotent: re-running is a no-op for applied
 * versions. Replaces the Phase-0 monolithic DDL apply (SEC-C6).
 * Every call is audited.
 */
export async function POST(req: Request) {
  const requestId = requestIdFor(req);
  const token = req.headers.get("authorization")?.replace(/^Bearer\s+/i, "") ?? null;
  if (!authorizeOpsOrAdmin(token)) {
    await writeAudit({ actorType: "anonymous", actorLabel: "ops:bearer", action: "ops.migrate", resource: "schema_migrations", result: "denied", requestId });
    return NextResponse.json({ errors: [{ code: "UNAUTHORIZED" }] }, { status: 401 });
  }
  try {
    const run = await runMigrations();
    const placeholders = AGENTOS_TABLES.map((_, i) => `$${i + 1}`).join(",");
    const [row] = await query<{ n: number }>(
      `SELECT count(*)::int AS n FROM pg_tables WHERE schemaname = 'public' AND tablename IN (${placeholders})`,
      [...AGENTOS_TABLES]
    );
    await writeAudit({
      actorType: "system", actorLabel: "ops:bearer", action: "ops.migrate", resource: "schema_migrations",
      result: "success", requestId,
      metadata: { applied: run.applied.filter((m) => m.status === "applied").map((m) => m.version), ledgerSize: run.ledgerSize, noop: run.noop },
    });
    return NextResponse.json({
      data: {
        migrated: true,
        applied: run.applied.filter((m) => m.status === "applied").map((m) => `${m.version} ${m.name}`),
        skipped: run.applied.filter((m) => m.status === "skipped").length,
        ledgerSize: run.ledgerSize,
        noop: run.noop,
        legacyTables: row.n,
        expectedLegacyTables: AGENTOS_TABLES.length,
      },
      meta: { ts: new Date().toISOString(), requestId },
    });
  } catch (e) {
    await writeAudit({ actorType: "system", actorLabel: "ops:bearer", action: "ops.migrate", resource: "schema_migrations", result: "failure", requestId, metadata: { error: e instanceof Error ? e.message : "unknown" } });
    return NextResponse.json(
      { errors: [{ code: "MIGRATION_FAILED", detail: e instanceof Error ? e.message : "unknown error" }] },
      { status: 500 }
    );
  }
}
