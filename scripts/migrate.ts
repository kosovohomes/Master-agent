import { query } from "../lib/db";
import { MIGRATION_DDL } from "../lib/migrations";

console.log("running migration…");
await query(MIGRATION_DDL);
console.log("migration complete");
