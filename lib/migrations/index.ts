/**
 * Versioned migration system (Phase 1 M0). Supersedes the pre-Phase-1
 * monolithic DDL apply (now lib/migrations-legacy.ts, referenced only as
 * migration 000's baseline text).
 */
export { MIGRATIONS, type MigrationDef } from "./definitions";
export { runMigrations, migrationLedger, type MigrationRun, type MigrationOutcome } from "./runner";
