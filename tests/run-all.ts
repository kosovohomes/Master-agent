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
  // Phase 2 suites
  "tests/registry-tests.ts",
  "tests/agent-executor-tests.ts",
  // Phase 3 suites
  "tests/task-queue-tests.ts",
  "tests/workflow-engine-tests.ts",
  "tests/events-tests.ts",
  // Phase 4 suites
  "tests/gateway-tests.ts",
  "tests/budgets-tests.ts",
  "tests/structured-tests.ts",
  "tests/call-site-grep-tests.ts",
  // Phase 10.5 suites
  "tests/ai-providers-tests.ts",
  // Phase 5 suites
  "tests/knowledge-chunking-tests.ts",
  "tests/knowledge-fetchers-tests.ts",
  "tests/knowledge-scopes-tests.ts",
  "tests/knowledge-retrieval-tests.ts",
  // Phase 6 suites
  "tests/connectors-crypto-tests.ts",
  "tests/connectors-service-tests.ts",
  "tests/connectors-events-tests.ts",
  "tests/connectors-route-tests.ts",
  // Phase 7 suites (research workforce)
  "tests/research-tools-tests.ts",
  "tests/research-pipeline-tests.ts",
  "tests/research-service-tests.ts",
  "tests/research-tasks-tests.ts",
  // Phase 8 suites (content workforce)
  "tests/content-lifecycle-tests.ts",
  "tests/content-service-tests.ts",
  "tests/content-tasks-tests.ts",
  // Phase 9 suites (SEO workforce)
  "tests/seo-pipeline-tests.ts",
  "tests/seo-service-tests.ts",
  "tests/seo-tasks-tests.ts",
  // Phase 10 suites
  "tests/social-service-tests.ts",
  "tests/social-sweep-tests.ts",
  "tests/social-oauth-tests.ts",
  // Phase 11 suite (marketing workforce)
  "tests/marketing-tests.ts",
  "tests/sales-tests.ts",
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
