/**
 * Batch runner: runs a subset of suites sequentially (shared-DB safe).
 * Usage: env -u DATABASE_URL ALLOW_PROD_TESTS=1 node --env-file=.env.local \
 *   node_modules/tsx/dist/cli.mjs scripts/run-batch.ts suite1.ts suite2.ts ...
 */
import { spawn } from "node:child_process";

const files = process.argv.slice(2);
if (files.length === 0) {
  console.error("no suites given");
  process.exit(2);
}
let failures = 0;
for (const f of files) {
  const r = spawn(process.execPath, ["--env-file=.env.local", "node_modules/tsx/dist/cli.mjs", f], { stdio: "inherit" });
  const code: number = await new Promise((res) => r.on("exit", res));
  if (code !== 0) failures++;
  console.log(`>>> ${code === 0 ? "OK  " : "FAIL"} ${f}`);
}
if (failures > 0) { console.error(`BATCH FAIL: ${failures} suite(s)`); process.exit(1); }
console.log("BATCH PASS");
