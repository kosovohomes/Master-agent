/**
 * Versioned migration runner (Phase 1 M0 — SEC-C6).
 *
 * Replaces the unversioned runtime DDL apply with an ordered, ledgered,
 * idempotent runner. Properties:
 *  - ordered: migrations run in version order, exactly once each
 *  - ledgered: every applied version is recorded in schema_migrations with
 *    a checksum, timestamp, and applier identity
 *  - idempotent: re-running is a no-op for already-applied versions;
 *    migration text itself is additive/IF-NOT-EXISTS based
 *  - transactional: each migration runs in its own transaction; a failed
 *    migration leaves no partial DDL and no ledger row
 *
 * No destructive operations are permitted in this runner (Phase 0.5 §5 rule 3).
 */
import crypto from "node:crypto";
import { query, transaction } from "../db";
import { MIGRATIONS, type MigrationDef } from "./definitions";

export type QueryFn = <T = any>(sql: string, params?: unknown[]) => Promise<T[]>;

export interface MigrationOutcome {
  version: string;
  name: string;
  status: "applied" | "skipped";
}

export interface MigrationRun {
  applied: MigrationOutcome[];
  ledgerSize: number;
  /** true when nothing needed doing (idempotent re-run) */
  noop: boolean;
}

function checksum(text: string): string {
  return crypto.createHash("sha256").update(text).digest("hex").slice(0, 16);
}

async function ledgerExists(): Promise<boolean> {
  const rows = await query<{ n: number }>(
    `SELECT count(*)::int AS n FROM information_schema.tables
     WHERE table_schema = 'public' AND table_name = 'schema_migrations'`
  );
  return rows[0].n > 0;
}

/**
 * Applies all pending migrations in order. Safe to call concurrently from
 * multiple instances: the ledger INSERT uses ON CONFLICT DO NOTHING and a
 * losing runner treats the version as already applied.
 */
export async function runMigrations(): Promise<MigrationRun> {
  const applied: MigrationOutcome[] = [];

  // Bootstrap the ledger itself if this is a fresh database. Migration 001
  // contains the same DDL and still records its own ledger row.
  if (!(await ledgerExists())) {
    await query(MIGRATIONS.find((m) => m.version === "001")!.source);
  }

  const known = new Set(
    (await query<{ version: string }>("SELECT version FROM schema_migrations")).map((r) => r.version)
  );

  for (const m of MIGRATIONS as MigrationDef[]) {
    if (known.has(m.version)) {
      applied.push({ version: m.version, name: m.name, status: "skipped" });
      continue;
    }
    const cs = checksum(m.source);
    const runInTx = async (q: QueryFn) => {
      if (m.up) await m.up(q);
      else await q(m.source);
      const ins = await q<{ version: string }>(
        `INSERT INTO schema_migrations (version, name, checksum) VALUES ($1, $2, $3)
         ON CONFLICT (version) DO NOTHING RETURNING version`,
        [m.version, m.name, cs]
      );
      if (ins.length === 0) throw new Error(`migration ${m.version} lost a concurrent apply race`);
    };
    try {
      await transaction(runInTx);
      applied.push({ version: m.version, name: m.name, status: "applied" });
    } catch (e) {
      // A concurrent-runner race is benign: re-check and treat as skipped.
      const nowKnown = await query<{ version: string }>(
        "SELECT version FROM schema_migrations WHERE version = $1",
        [m.version]
      );
      if (nowKnown.length > 0) {
        applied.push({ version: m.version, name: m.name, status: "skipped" });
        continue;
      }
      throw e;
    }
  }

  const ledgerSize = (await query<{ n: number }>("SELECT count(*)::int AS n FROM schema_migrations"))[0].n;
  return {
    applied,
    ledgerSize,
    noop: applied.every((a) => a.status === "skipped"),
  };
}

/** Ordered ledger contents (audit/verification helper). */
export async function migrationLedger(): Promise<{ version: string; name: string; checksum: string; applied_at: string }[]> {
  return query(
    "SELECT version, name, checksum, applied_at FROM schema_migrations ORDER BY version ASC"
  );
}
