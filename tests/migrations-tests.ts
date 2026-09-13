import { spawn } from "node:child_process";
import { query } from "../lib/db";
import { runMigrations, migrationLedger } from "../lib/migrations";
import { MIGRATIONS } from "../lib/migrations/definitions";

/**
 * Migrations (Phase 1 M0 — SEC-C6 acceptance: ordered, repeatable ledger;
 * apply-to-empty works; re-running is a no-op).
 *
 * The main suite database is expected to be non-production (CI: ephemeral
 * Postgres). The apply-to-empty check spawns a child process against a
 * THROWAWAY database created via CREATE DATABASE; when the connected role
 * lacks CREATEDB (e.g. pooled Neon), that section is skipped with a notice
 * rather than failing.
 */
let failures = 0;
function check(name: string, cond: boolean, detail = "") {
  console.log(`${cond ? "PASS" : "FAIL"} ${name}${detail ? " :: " + detail : ""}`);
  if (!cond) failures++;
}

function runNode(args: string[], envOverride: Record<string, string>, onLine: (l: string) => void): Promise<number> {
  return new Promise((resolve) => {
    const r = spawn(process.execPath, ["--env-file=.env.local", "node_modules/tsx/dist/cli.mjs", ...args], {
      env: { ...process.env, ...envOverride },
      stdio: ["ignore", "pipe", "pipe"],
    });
    r.stdout.on("data", (d) => String(d).split("\n").filter(Boolean).forEach(onLine));
    r.stderr.on("data", (d) => String(d).split("\n").filter(Boolean).forEach(onLine));
    r.on("exit", (code) => resolve(code ?? 1));
  });
}

try {
  // ---------- ledger on the suite database ----------
  const first = await runMigrations();
  const ledger1 = await migrationLedger();
  check("ledger: one row per defined migration", ledger1.length === MIGRATIONS.length, `rows=${ledger1.length} expected=${MIGRATIONS.length}`);
  check("ledger: versions ordered ascending", ledger1.every((r, i) => i === 0 || ledger1[i - 1].version < r.version));
  check("ledger: checksums recorded", ledger1.every((r) => typeof r.checksum === "string" && r.checksum.length === 16));

  // ---------- idempotency: second run is a no-op ----------
  const second = await runMigrations();
  const ledger2 = await migrationLedger();
  check("idempotent: re-run applies nothing (noop=true)", second.noop === true, `applied=${second.applied.filter((m) => m.status === "applied").length}`);
  check("idempotent: ledger unchanged after re-run", ledger2.length === ledger1.length);

  // ---------- apply-to-empty on a throwaway database ----------
  const dbname = `agentos_mig_test_${Date.now()}`;
  let canCreate = false;
  try {
    await query(`CREATE DATABASE ${dbname}`);
    canCreate = true;
  } catch {
    console.log("SKIP apply-to-empty: connected role lacks CREATEDB (expected on pooled Neon)");
  }

  if (canCreate) {
    try {
      const u = new URL(process.env.DATABASE_URL as string);
      u.pathname = `/${dbname}`;
      const ephemeralUrl = u.toString();
      const lines: string[] = [];
      const code1 = await runNode(["scripts/migrate.ts"], { DATABASE_URL: ephemeralUrl }, (l) => lines.push(l));
      check("empty-db: runner exits 0 on fresh database", code1 === 0, lines.slice(-3).join(" | "));

      // verify from this process via a one-off connection
      const { Pool } = await import("pg");
      const pool = new Pool({ connectionString: ephemeralUrl });
      const eLedger = await pool.query("SELECT version FROM schema_migrations ORDER BY version");
      check("empty-db: ledger complete (11 versions incl. legacy baseline)", eLedger.rowCount === MIGRATIONS.length, `rows=${eLedger.rowCount}`);
      const tables = await pool.query(
        `SELECT tablename FROM pg_tables WHERE schemaname='public' AND tablename IN ('users','sessions','roles','audit_logs','business_units','websites','website_integrations','website_capabilities','feature_flags','system_settings','tenant_usage_daily','connector_deliveries','research_schedules','research_items','competitors','competitor_events','content_items','content_versions','approval_actions')`
      );
      check("empty-db: Phase 1+8 tables exist", tables.rowCount === 19, `found=${tables.rowCount}`);
      const buCount = await pool.query("SELECT count(*)::int AS n FROM business_units");
      check("empty-db: backfill no-op on zero tenants", buCount.rows[0].n === 0);
      const seededRoles = await pool.query("SELECT count(*)::int AS n FROM roles WHERE is_active");
      check("empty-db: RBAC seed present (4 active roles)", seededRoles.rows[0].n === 4);
      const seededFlags = await pool.query("SELECT count(*)::int AS n FROM feature_flags");
      check("empty-db: flags seed present (8 incl. ai_gateway + knowledge_v2 + connectors + research + content)", seededFlags.rows[0].n === 8);
      await pool.end();

      const lines2: string[] = [];
      const code2 = await runNode(["scripts/migrate.ts"], { DATABASE_URL: ephemeralUrl }, (l) => lines2.push(l));
      check("empty-db: second run exits 0 (idempotent)", code2 === 0);
      check("empty-db: second run logs all skipped", lines2.some((l) => l.includes("skipped")), lines2.slice(-2).join(" | "));
    } finally {
      await query(`DROP DATABASE ${dbname}`).catch(() => {
        console.log("note: could not drop throwaway database (open connections); it is ephemeral");
      });
    }
  }
} finally {
  // no data mutations on the suite database beyond the ledger itself
}

if (failures > 0) { console.error(`${failures} FAIL`); process.exit(1); }
console.log("MIGRATIONS SUITE PASS");
