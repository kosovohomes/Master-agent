import { dispatch, getTenantConfig } from "../lib/agents/dispatch";
import type { TenantCfg } from "../lib/agents/dispatch";
import { query } from "../lib/db";
import type { LLMClient } from "../lib/llm";

let failures = 0;
function check(name: string, cond: boolean, detail = "") {
  console.log(`${cond ? "PASS" : "FAIL"} ${name}${detail ? " :: " + detail : ""}`);
  if (!cond) failures++;
}

let completeCalls = 0;
let lastMessages: { role: string; content: string }[] = [];
const stubLLM: LLMClient = {
  async complete(messages) { completeCalls++; lastMessages = messages as any; return "Drafted post"; },
  async embed() { return []; },
};

const stamp = Date.now();
const slugA = `t9-d9-a-${stamp}`;
const slugB = `t9-d9-b-${stamp}`;
let tenantA: number | undefined;
let tenantB: number | undefined;

const sysMsg = () => lastMessages.find((m) => m.role === "system")?.content ?? "";
const draftsFor = async (t: number) => query<{ id: number }>("SELECT id FROM drafts WHERE tenant_id = $1", [t]);
const runsFor = async (t: number) => query<{ id: number }>("SELECT id FROM agent_runs WHERE tenant_id = $1", [t]);

try {
  const [ta] = await query<{ id: number }>(
    `INSERT INTO tenants (slug, name) VALUES ($1, $2) RETURNING id`, [slugA, "Dispatch Tenant A"]);
  const [tb] = await query<{ id: number }>(
    `INSERT INTO tenants (slug, name) VALUES ($1, $2) RETURNING id`, [slugB, "Dispatch Tenant B"]);
  tenantA = ta.id;
  tenantB = tb.id;

  await query("INSERT INTO tenant_config (tenant_id, brand_voice, persona, audience) VALUES ($1, $2, $3, $4)",
    [tenantA, "clear and direct", "city lawyer", "small businesses"]);
  await query("INSERT INTO tenant_config (tenant_id, brand_voice, persona, audience) VALUES ($1, $2, $3, $4)",
    [tenantB, "bold and punchy", "growth hacker", "startup founders"]);

  // --- getTenantConfig loads the tenant's row from the DB ---
  const cfgA: TenantCfg = await getTenantConfig(tenantA);
  check("config loads brand voice from tenant row", cfgA.brandVoice === "clear and direct");
  check("config loads persona from tenant row", cfgA.persona === "city lawyer");
  check("config loads audience from tenant row", cfgA.audience === "small businesses");
  check("config exposes empty content system prompt default", cfgA.contentSystemPrompt === "");
  const missing = await getTenantConfig(999999999);
  check("unknown tenant config returns empty defaults",
    missing.brandVoice === "" && missing.persona === "" && missing.audience === "" && missing.contentSystemPrompt === "");

  // --- dispatch routes a default marketing goal and records run + pending draft ---
  completeCalls = 0;
  const res = await dispatch({ llm: stubLLM, getConfig: getTenantConfig },
    { tenantId: tenantA, topic: "post about our services", channel: "x" });
  check("routes to marketing", res.agent === "marketing");
  check("route reason names marketing", res.routeReason.toLowerCase().includes("marketing"));
  check("runId is numeric", Number.isInteger(res.runId));
  check("draftId is numeric", Number.isInteger(res.draftId));
  check("run recorded", (await query<{ id: number }>("SELECT id FROM agent_runs WHERE id = $1", [res.runId])).length === 1);
  check("draft created", (await query<{ id: number }>("SELECT id FROM drafts WHERE id = $1", [res.draftId!])).length === 1);
  const mktRun = (await query<{ agent: string; trigger: string; status: string; prompt_hash: string; tenant_id: number }>(
    "SELECT agent, trigger, status, prompt_hash, tenant_id FROM agent_runs WHERE id = $1", [res.runId]))[0];
  check("run row is marketing/completed/manual with topic hash and tenant",
    mktRun.agent === "marketing" && mktRun.status === "completed" && mktRun.trigger === "manual" &&
    mktRun.prompt_hash === "post about our services" && mktRun.tenant_id === tenantA);
  const mktDraft = (await query<{ agent: string; channel: string; status: string; tenant_id: number }>(
    "SELECT agent, channel, status, tenant_id FROM drafts WHERE id = $1", [res.draftId!]))[0];
  check("draft is pending marketing/x for the tenant", mktDraft.agent === "marketing" && mktDraft.channel === "x" &&
    mktDraft.status === "pending" && mktDraft.tenant_id === tenantA);
  check("generator called once", completeCalls === 1);

  // --- binding flag: tenant_config from the tenant row is injected, not a hardcoded default ---
  const sysA = sysMsg();
  check("system prompt carries tenant brand voice", sysA.includes("Brand voice: clear and direct"));
  check("system prompt carries tenant persona", sysA.includes("city lawyer"));
  check("system prompt carries tenant audience", sysA.includes("small businesses"));
  check("system prompt did not fall back to generator default voice", !sysA.includes("Brand voice: professional"));

  // --- research / sales / ambassador route to their own agents ---
  completeCalls = 0;
  const rRes = await dispatch({ llm: stubLLM, getConfig: getTenantConfig },
    { tenantId: tenantA, topic: "gather legal industry news", channel: "x" });
  check("routes to research", rRes.agent === "research");
  check("research draft is pending research/x",
    (await query<{ agent: string; channel: string; status: string }>(
      "SELECT agent, channel, status FROM drafts WHERE id = $1", [rRes.draftId!]))[0].agent === "research" &&
    (await query<{ channel: string; status: string }>("SELECT channel, status FROM drafts WHERE id = $1", [rRes.draftId!]))[0].channel === "x");

  completeCalls = 0;
  const rSales = await dispatch({ llm: stubLLM, getConfig: getTenantConfig },
    { tenantId: tenantA, topic: "pitch partnership to Acme", channel: "email" });
  check("routes to sales", rSales.agent === "sales");
  const sDraft = (await query<{ agent: string; channel: string; status: string }>(
    "SELECT agent, channel, status FROM drafts WHERE id = $1", [rSales.draftId!]))[0];
  check("sales draft is pending sales/email", sDraft.agent === "sales" && sDraft.channel === "email" && sDraft.status === "pending");
  check("sales dispatch without prospect writes no lead",
    (await query<{ n: string }>("SELECT count(*)::text AS n FROM leads WHERE tenant_id = $1", [tenantA]))[0].n === "0");

  completeCalls = 0;
  const rAmb = await dispatch({ llm: stubLLM, getConfig: getTenantConfig },
    { tenantId: tenantA, topic: "promote our awards night", channel: "x" });
  check("routes to ambassador", rAmb.agent === "ambassador");
  check("ambassador draft is pending ambassador/x",
    (await query<{ agent: string; status: string }>(
      "SELECT agent, status FROM drafts WHERE id = $1", [rAmb.draftId!]))[0].agent === "ambassador" &&
    (await query<{ status: string }>("SELECT status FROM drafts WHERE id = $1", [rAmb.draftId!]))[0].status === "pending");

  // --- binding flag: customer_service is guarded before generators (chat-first, no LLM) ---
  const draftsBeforeChat = (await draftsFor(tenantA)).length;
  const runsBeforeChat = (await runsFor(tenantA)).length;
  completeCalls = 0;
  const rChat = await dispatch({ llm: stubLLM, getConfig: getTenantConfig },
    { tenantId: tenantA, topic: "gather a pitch for the sale", channel: "chat" });
  check("chat routes to customer_service even with keyword-heavy topic", rChat.agent === "customer_service");
  check("chat guard never calls a generator", completeCalls === 0);
  check("chat dispatch produces no draft", rChat.draftId === null &&
    (await draftsFor(tenantA)).length === draftsBeforeChat);
  check("chat dispatch still records an audit run",
    (await query<{ agent: string; status: string }>("SELECT agent, status FROM agent_runs WHERE id = $1", [rChat.runId]))[0].agent === "customer_service" &&
    (await runsFor(tenantA)).length === runsBeforeChat + 1);
  check("chat run is completed", (await query<{ status: string }>("SELECT status FROM agent_runs WHERE id = $1", [rChat.runId]))[0].status === "completed");

  // --- cross-tenant isolation: B's config injected for B, rows scoped per tenant ---
  completeCalls = 0;
  const rB = await dispatch({ llm: stubLLM, getConfig: getTenantConfig },
    { tenantId: tenantB, topic: "post something bold", channel: "linkedin" });
  check("tenant B routes to marketing", rB.agent === "marketing");
  const sysB = sysMsg();
  check("tenant B brand voice injected for B", sysB.includes("Brand voice: bold and punchy"));
  check("tenant A voice not leaked into B prompt", !sysB.includes("clear and direct"));
  check("tenant B draft scoped to B",
    (await query<{ tenant_id: number }>("SELECT tenant_id FROM drafts WHERE id = $1", [rB.draftId!]))[0].tenant_id === tenantB);
  check("tenant B run scoped to B",
    (await query<{ tenant_id: number }>("SELECT tenant_id FROM agent_runs WHERE id = $1", [rB.runId]))[0].tenant_id === tenantB);
  const idA = (await draftsFor(tenantA)).map((r) => r.id);
  const idB = (await draftsFor(tenantB)).map((r) => r.id);
  check("draft rows are disjoint across tenants", idA.length > 0 && idB.length === 1 && idA.every((x) => !idB.includes(x)));
  const runAIds = (await runsFor(tenantA)).map((r) => r.id);
  const runBIds = (await runsFor(tenantB)).map((r) => r.id);
  check("run rows are disjoint across tenants", runAIds.length > 0 && runBIds.every((x) => !runAIds.includes(x)));

  // --- HTTP route handler: real POST against /api/agents/run ---
  process.env.OPENAI_API_KEY = "sk-test-fake-t9";
  let fetchCalls = 0;
  const fakeFetch = async (_url: any, init?: any) => {
    fetchCalls++;
    const body = JSON.parse(String(init?.body ?? "{}"));
    if (Array.isArray(body?.input)) {
      return new Response(JSON.stringify({ data: [{ embedding: new Array(1536).fill(0.1) }] }), { status: 200 });
    }
    return new Response(JSON.stringify({ choices: [{ message: { content: "HTTP drafted copy" } }] }), { status: 200 });
  };
  (globalThis as any).fetch = fakeFetch;
  const routeMod = await import("../app/api/agents/run/route");

  const mkReq = (body: unknown) => new Request("http://localhost/api/agents/run", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });

  fetchCalls = 0;
  const h1 = await routeMod.POST(mkReq({ tenantId: tenantB, topic: "gather legal industry news", channel: "x" }));
  const j1 = await h1.json();
  check("route returns 200 for valid research goal", h1.status === 200);
  check("route returns dispatch result with agent/run/draft", j1?.data?.agent === "research" &&
    Number.isInteger(j1?.data?.runId) && Number.isInteger(j1?.data?.draftId) && typeof j1?.data?.routeReason === "string");
  check("route writes a pending research draft for tenant B",
    (await query<{ agent: string; status: string; tenant_id: number }>(
      "SELECT agent, status, tenant_id FROM drafts WHERE id = $1", [j1.data.draftId]))[0].agent === "research" &&
    (await query<{ agent: string; status: string; tenant_id: number }>(
      "SELECT agent, status, tenant_id FROM drafts WHERE id = $1", [j1.data.draftId]))[0].status === "pending");
  check("route records a completed run via real LLM path", (await query<{ status: string }>(
    "SELECT status FROM agent_runs WHERE id = $1", [j1.data.runId]))[0].status === "completed");
  check("route actually invoked the LLM", fetchCalls === 1);

  const draftsAfterResearch = (await draftsFor(tenantB)).length;
  const runsAfterResearch = (await runsFor(tenantB)).length;
  const h2 = await routeMod.POST(mkReq({ tenantId: tenantB, topic: "gather a pitch for the sale", channel: "chat" }));
  const j2 = await h2.json();
  check("route guards chat before generators", h2.status === 200 && j2?.data?.agent === "customer_service" && j2?.data?.draftId === null);
  check("route chat writes no draft", (await draftsFor(tenantB)).length === draftsAfterResearch);
  check("route chat writes a customer_service run",
    (await query<{ agent: string }>("SELECT agent FROM agent_runs WHERE id = $1", [j2.data.runId]))[0].agent === "customer_service");
  check("route chat added exactly one run", (await runsFor(tenantB)).length === runsAfterResearch + 1);
  check("route chat never calls the LLM", fetchCalls === 1);

  const draftsAfterChat = (await draftsFor(tenantB)).length;
  const runsAfterChat = (await runsFor(tenantB)).length;
  const h3 = await routeMod.POST(mkReq({ topic: "post something", channel: "x" }));
  const j3 = await h3.json();
  check("route rejects missing tenantId with 400", h3.status === 400 && j3?.errors?.[0]?.code === "INVALID_TENANT");
  check("route 400 writes no draft or run", (await draftsFor(tenantB)).length === draftsAfterChat &&
    (await runsFor(tenantB)).length === runsAfterChat);
} finally {
  if (tenantA !== undefined) await query("DELETE FROM tenants WHERE id = $1", [tenantA]);
  if (tenantB !== undefined) await query("DELETE FROM tenants WHERE id = $1", [tenantB]);
}

if (failures > 0) { console.error(`${failures} FAIL`); process.exit(1); }
console.log("DISPATCH SUITE PASS");