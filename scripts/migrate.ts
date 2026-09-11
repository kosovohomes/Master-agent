import { runMigrations } from "../lib/migrations";

console.log("running versioned migrations…");
const run = await runMigrations();
for (const m of run.applied) {
  console.log(`  ${m.status === "applied" ? "applied " : "skipped "} ${m.version} ${m.name}`);
}
console.log(`done — ledger now holds ${run.ledgerSize} versions`);
