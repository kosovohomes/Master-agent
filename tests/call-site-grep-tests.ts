import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Call-site grep enforcement (Phase 4 acceptance: "zero call sites construct
 * provider clients directly — grep-enforced").
 *
 * NOTHING outside lib/ai/** and the lib/llm.ts shim may:
 *   - import the provider module (lib/llm, lib/ai/providers/*)
 *   - construct a provider client (makeOpenAI / makeLLM calls)
 *
 * Executors, generators, routes, and the task engine receive the
 * gateway-wrapped client as their plain LLMClient — this test keeps it that
 * way as the codebase grows.
 */
let failures = 0;
function check(name: string, cond: boolean, detail = "") {
  console.log(`${cond ? "PASS" : "FAIL"} ${name}${detail ? " :: " + detail : ""}`);
  if (!cond) failures++;
}

const ROOT = fileURLToPath(new URL("..", import.meta.url)).replace(/\/$/, "");
const ALLOWED_PREFIXES = ["lib/ai/", "lib/llm.ts"];
const FORBIDDEN = [
  /from\s+["'][^"']*lib\/llm["']/,
  /from\s+["'][^"']*lib\/ai\/providers\//,
  /\bmakeOpenAI\s*\(/,
  /\bmakeLLM\s*\(/,
];

function walk(dir: string, acc: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    if (entry === "node_modules" || entry === ".next" || entry.startsWith(".")) continue;
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) walk(full, acc);
    else if (/\.(ts|tsx)$/.test(entry)) acc.push(full);
  }
  return acc;
}

const offenders: string[] = [];
const scanned = walk(ROOT).filter((f) => f.includes("/lib/") || f.includes("/app/"));
for (const file of scanned) {
  const rel = file.slice(ROOT.length + 1).replaceAll("\\", "/");
  if (ALLOWED_PREFIXES.some((p) => rel.startsWith(p))) continue;
  const src = readFileSync(file, "utf8");
  for (const rx of FORBIDDEN) {
    if (rx.test(src)) offenders.push(`${rel} :: ${rx.source}`);
  }
}
check("no direct provider imports/constructors outside lib/ai + shim", offenders.length === 0, offenders.join(" ; "));

// The gateway singleton must be the composition-root import everywhere.
const gatewayImports = scanned.filter(
  (f) => /from\s+["'][^"']*(lib\/ai|\.{1,2}\/ai)["']/.test(readFileSync(f, "utf8")) && !f.includes("/lib/ai/") && !f.endsWith("lib/llm.ts")
);
check("composition roots import the gateway surface (lib/ai)", gatewayImports.length >= 3, gatewayImports.map((f) => f.slice(ROOT.length + 1)).join(", "));

if (failures > 0) { console.error(`${failures} FAIL`); process.exit(1); }
console.log("CALL-SITE GREP SUITE PASS");
