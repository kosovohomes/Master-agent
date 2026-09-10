import { spawn } from "node:child_process";

const files = ["tests/smoke-tests.ts", "tests/db-tests.ts", "tests/llm-tests.ts", "tests/channels-tests.ts", "tests/agents-routing-tests.ts", "tests/approval-tests.ts", "tests/rag-tests.ts", "tests/generators-tests.ts", "tests/dispatch-tests.ts", "tests/chat-tests.ts", "tests/publishers-tests.ts", "tests/widget-tests.ts", "tests/admin-tests.ts", "tests/security-tests.ts"];
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