import { spawn } from "node:child_process";

/**
 * Phase 1 safety guard: the suites MUTATE data (create tenants/users, test
 * FSM transitions). Refuse to run against the production Neon database
 * unless explicitly overridden with ALLOW_PROD_TESTS=1. CI always runs
 * against an ephemeral Postgres container.
 */
const DB_URL = process.env.DATABASE_URL ?? "";
const PROD_MARKERS = ["aui4sh0g"]; // production Neon endpoint fragment (see PHASE-1 report §Staging)
if (DB_URL && !process.env.ALLOW_PROD_TESTS && PROD_MARKERS.some((m) => DB_URL.includes(m))) {
  console.error(
    "REFUSING TO RUN: DATABASE_URL looks like the production database.\n" +
      "Point DATABASE_URL at an ephemeral/non-production Postgres, or set ALLOW_PROD_TESTS=1 to override."
  );
  process.exit(2);
}

const files = [
  "tests/smoke-tests.ts",
  "tests/db-tests.ts",
  "tests/llm-tests.ts",
  "tests/channels-tests.ts",
  "tests/agents-routing-tests.ts",
  "tests/approval-tests.ts",
  "tests/rag-tests.ts",
  "tests/generators-tests.ts",
  "tests/dispatch-tests.ts",
  "tests/chat-tests.ts",
  "tests/publishers-tests.ts",
  "tests/widget-tests.ts",
  "tests/admin-tests.ts",
  "tests/security-tests.ts",
  // Phase 1 suites
  "tests/migrations-tests.ts",
  "tests/auth-tests.ts",
  "tests/rbac-tests.ts",
  "tests/ratelimit-tests.ts",
  "tests/audit-tests.ts",
  "tests/bu-website-tests.ts",
];
let failures = 0;
for (const f of files) {
  const r = spawn(process.execPath, [
    "--env-file=.env.local",
    "node_modules/tsx/dist/cli.mjs",
    f,
  ], { stdio: "inherit" });
  const code: number = await new Promise((res) => r.on("exit", res));
  if (code !== 0) failures++;
}
if (failures > 0) { console.error(`FAIL ${failures} suite(s)`); process.exit(1); }
console.log("ALL SUITES PASS");
