import assert from "node:assert";
import { routeAgent, recordRun } from "../lib/agents/core";
import { AGENT_CATALOG, getAgent } from "../lib/agents/catalog";
import type { AgentId } from "../lib/agents/types";
import { query } from "../lib/db";

let failures = 0;
function check(name: string, cond: boolean, detail = "") {
  console.log(`${cond ? "PASS" : "FAIL"} ${name}${detail ? " :: " + detail : ""}`);
  if (!cond) failures++;
}

// --- deterministic routing: purpose/intent per channel ---
check("chat channel routes to customer_service", routeAgent({ topic: "help with your pricing", channel: "chat" }).agent === "customer_service");
check("research topic routes to research", routeAgent({ topic: "gather legal industry news for next week", channel: "" }).agent === "research");
check("sales topic routes to sales", routeAgent({ topic: "draft outreach to law firm partners", channel: "email" }).agent === "sales");
check("ambassador topic folds to marketing (Phase 2 \u00a76.1)", routeAgent({ topic: "promote our award mention", channel: "linkedin" }).agent === "marketing");
check("fold reason documents the ambassador fold", routeAgent({ topic: "promote our award mention", channel: "linkedin" }).reason.includes("ambassador"));
check("default routes to marketing", routeAgent({ topic: "post about our services", channel: "x" }).agent === "marketing");

// --- Phase 3 C-16: the router is an explicit classifier with a fallback flag ---
check("matched routes are NOT fallback (chat)", routeAgent({ topic: "help me", channel: "chat" }).fallback === false);
check("matched routes are NOT fallback (research)", routeAgent({ topic: "research the market", channel: "" }).fallback === false);
check("matched routes are NOT fallback (sales)", routeAgent({ topic: "outreach to partners", channel: "email" }).fallback === false);
check("matched routes are NOT fallback (ambassador fold)", routeAgent({ topic: "promote the award", channel: "x" }).fallback === false);
check("default miss IS fallback (C-16)", routeAgent({ topic: "post about our services", channel: "x" }).fallback === true);
check("non-matching gibberish IS fallback", routeAgent({ topic: "zzz unrelated", channel: "" }).fallback === true);

// --- hard split: customer_service ONLY via chat, generation NEVER via chat ---
check("chat beats matching intel keywords", routeAgent({ topic: "research our pricing help", channel: "chat" }).agent === "customer_service");
check("chat beats matching outreach keywords", routeAgent({ topic: "outreach deal pricing", channel: "chat" }).agent === "customer_service");
const nonChatGeneration: [string, string][] = [
  ["legal industry news brief", ""],
  ["outreach to partners", "email"],
  ["promote the award", "instagram"],
  ["post about our services", "tiktok"],
  ["hello there", "x"],
];
check(
  "no generation input ever routes to customer_service",
  nonChatGeneration.every(([topic, channel]) => routeAgent({ topic, channel }).agent !== "customer_service")
);

// --- catalog contract ---
check("catalog has 5 agents", AGENT_CATALOG.length === 5);
check("catalog ids unique", new Set(AGENT_CATALOG.map(a => a.id)).size === 5);
check("catalog covers every AgentId",
  ["research", "marketing", "sales", "ambassador", "customer_service"]
    .every(id => AGENT_CATALOG.some(a => a.id === id)));
check("every agent has name and description",
  AGENT_CATALOG.every(a => a.name.length > 0 && a.description.length > 0));
const def = getAgent("marketing");
check("getAgent returns def", def.id === "marketing" && def.name.length > 0);
let threw = "";
try { getAgent("bogus" as AgentId); } catch (e) { threw = (e as Error).message; }
check("unknown agent id rejected", threw.includes("unknown agent"), threw);

// --- recordRun writes an append-only audit row (real tenant id: agent_runs.tenant_id is a hard FK) ---
const slug = `t4-${Date.now()}`;
let tid: number | undefined;
try {
  tid = (await query<{ id: number }>(
    "INSERT INTO tenants (slug, name) VALUES ($1, $2) RETURNING id", [slug, "T4 Routing"]
  ))[0].id;
  const run = await recordRun({ tenantId: tid, agent: "research", trigger: "test", promptHash: "abc123" });
  const rows = await query<{ agent: string }>("SELECT agent FROM agent_runs WHERE id = $1", [run.runId]);
  check("recordRun persisted", rows.length === 1 && rows[0].agent === "research");
  check("recordRun returns numeric id", typeof run.runId === "number" && Number.isInteger(run.runId));
  check("recordRun defaults status to completed",
    (await query<{ status: string }>("SELECT status FROM agent_runs WHERE id = $1", [run.runId]))[0].status === "completed");

  const run2 = await recordRun({ tenantId: tid, agent: "sales", trigger: "manual", promptHash: "def456", outputRef: "drafts/1" });
  const two = await query<{ id: number }>("SELECT id FROM agent_runs WHERE tenant_id = $1", [tid]);
  check("recordRun is append-only (distinct rows)", run2.runId !== run.runId && two.length === 2);
  check("recordRun persists output_ref",
    (await query<{ output_ref: string | null }>("SELECT output_ref FROM agent_runs WHERE id = $1", [run2.runId]))[0].output_ref === "drafts/1");
} finally {
  if (tid !== undefined) await query("DELETE FROM tenants WHERE id = $1", [tid]);
}

if (failures > 0) { console.error(`${failures} FAIL`); process.exit(1); }
console.log("AGENTS ROUTING SUITE PASS");