import { generateDraft, systemPromptFor } from "../lib/agents/generators";
import type { GenAgent } from "../lib/agents/generators";
import { query } from "../lib/db";
import type { LLMClient } from "../lib/llm";

let failures = 0;
function check(name: string, cond: boolean, detail = "") {
  console.log(`${cond ? "PASS" : "FAIL"} ${name}${detail ? " :: " + detail : ""}`);
  if (!cond) failures++;
}

const GEN_AGENTS: GenAgent[] = ["research", "marketing", "sales", "ambassador"];

const cfgA = { brandVoice: "professional and warm", persona: "trusted advisor", audience: "law firms and legal tech" };
const cfgB = { brandVoice: "bold and punchy", persona: "growth hacker", audience: "startup founders" };

// --- system prompt contract (Test A, brief-verbatim) ---
const prompt = systemPromptFor("marketing", cfgA);
check("system prompt carries brand voice", prompt.includes("professional and warm"));
check("system prompt carries persona", prompt.includes("trusted advisor"));
check("system prompt carries audience", prompt.includes("law firms and legal tech"));
check("system prompt carries rules guard", prompt.includes("no invented facts"));
for (const agent of GEN_AGENTS) {
  check(`system prompt names the ${agent} role`,
    systemPromptFor(agent, cfgA).includes(agent[0].toUpperCase() + agent.slice(1) + " agent"));
}

// --- stubbed LLM: records the messages it receives, returns a controllable string ---
let lastMessages: { role: string; content: string }[] = [];
let nextContent = "Check out our services!";
const stubLLM: LLMClient = {
  async complete(messages) { lastMessages = messages as any; return nextContent; },
  async embed() { return []; },
};

const stamp = Date.now();
const slugA = `t8-gen-a-${stamp}`;
const slugB = `t8-gen-b-${stamp}`;
let tenantA: number | undefined;
let tenantB: number | undefined;
try {
  const [ta] = await query<{ id: number }>(
    `INSERT INTO tenants (slug, name) VALUES ($1, $2) RETURNING id`, [slugA, "Gen Tenant A"]);
  const [tb] = await query<{ id: number }>(
    `INSERT INTO tenants (slug, name) VALUES ($1, $2) RETURNING id`, [slugB, "Gen Tenant B"]);
  tenantA = ta.id;
  tenantB = tb.id;

  // realistic tenant setup: brand voice/persona config + connected channels
  await query("INSERT INTO tenant_config (tenant_id, brand_voice, persona, audience) VALUES ($1, $2, $3, $4)",
    [tenantA, cfgA.brandVoice, cfgA.persona, cfgA.audience]);
  await query("INSERT INTO tenant_config (tenant_id, brand_voice, persona, audience) VALUES ($1, $2, $3, $4)",
    [tenantB, cfgB.brandVoice, cfgB.persona, cfgB.audience]);
  for (const kind of ["x", "email", "linkedin"]) {
    await query("INSERT INTO channels (tenant_id, kind, token_encrypted, status) VALUES ($1, $2, $3, 'healthy')",
      [tenantA, kind, "stub-token"]);
  }

  // --- marketing draft (Test A flow): prompt injection + pending draft ---
  const out = await generateDraft({ llm: stubLLM }, {
    tenantId: tenantA, agent: "marketing", channel: "x", topic: "promote our site launch", config: cfgA,
  });
  check("returns generated content", out.content === "Check out our services!");
  check("returns numeric draftId", Number.isInteger(out.draftId));
  check("creates a pending draft",
    (await query<{ status: string }>("SELECT status FROM drafts WHERE id = $1", [out.draftId]))[0].status === "pending");
  const mktRow = (await query<{ agent: string; channel: string }>("SELECT agent, channel FROM drafts WHERE id = $1", [out.draftId]))[0];
  check("marketing draft row is agent-correct", mktRow.agent === "marketing");
  check("marketing draft row is channel-correct", mktRow.channel === "x");
  check("user message contains topic", JSON.stringify(lastMessages).includes("site launch"));
  const sysMsg = lastMessages.find((m) => m.role === "system")?.content ?? "";
  const usrMsg = lastMessages.find((m) => m.role === "user")?.content ?? "";
  check("system message carries brand voice", sysMsg.includes("professional and warm"));
  check("system message carries persona", sysMsg.includes("trusted advisor"));
  check("system message carries audience", sysMsg.includes("law firms and legal tech"));
  check("user message carries channel hint", usrMsg.includes("280 characters"));

  // --- research draft: context is injected into the completion prompt ---
  nextContent = "Intel brief: courts are digitalizing.";
  const outRes = await generateDraft({ llm: stubLLM }, {
    tenantId: tenantA, agent: "research", channel: "x", topic: "gather legal industry news",
    config: cfgA, context: "focus on e-filing adoption",
  });
  const usrRes = lastMessages.find((m) => m.role === "user")?.content ?? "";
  check("context included in user message", usrRes.includes("focus on e-filing adoption"));
  const resRow = (await query<{ agent: string; status: string; content: string }>("SELECT agent, status, content FROM drafts WHERE id = $1", [outRes.draftId]))[0];
  check("research draft persisted as research/pending", resRow.agent === "research" && resRow.status === "pending");
  check("research draft stores LLM content verbatim", resRow.content === "Intel brief: courts are digitalizing." && outRes.content === resRow.content);

  // --- every generator agent produces a pending draft preserving agent/channel/content ---
  const agentChannels: Array<[GenAgent, string]> = [
    ["research", "x"], ["marketing", "x"], ["sales", "email"], ["ambassador", "linkedin"],
  ];
  for (const [agent, channel] of agentChannels) {
    nextContent = `content-${agent}`;
    const r = await generateDraft({ llm: stubLLM }, {
      tenantId: tenantA, agent, channel, topic: `topic-${agent}`, config: cfgA,
    });
    const row = (await query<{ agent: string; channel: string; content: string; status: string }>(
      "SELECT agent, channel, content, status FROM drafts WHERE id = $1", [r.draftId]))[0];
    check(`${agent} draft: status pending`, row.status === "pending");
    check(`${agent} draft: agent-correct`, row.agent === agent);
    check(`${agent} draft: channel-correct`, row.channel === channel);
    check(`${agent} draft: content preserved`, row.content === `content-${agent}`);
    check(`${agent} draft: returned content matches`, r.content === `content-${agent}`);
  }

  // --- sales records a lead when a prospect is provided (Test B, superseded) ---
  // the sales run inside the loop above had no prospect: it must NOT have written a lead
  check("sales without prospect writes no lead",
    (await query<{ n: string }>("SELECT count(*)::text AS n FROM leads WHERE tenant_id = $1", [tenantA]))[0].n === "0");

  const outSales = await generateDraft({ llm: stubLLM }, {
    tenantId: tenantA, agent: "sales", channel: "email", topic: "pitch partnership",
    config: cfgA, prospect: { company: "Acme Law", name: "Rana", contact: "rana@acme.com" },
  });
  const leads = await query<{ company: string; name: string; contact: string; channel: string; stage: string; source: string }>(
    "SELECT company, name, contact, channel, stage, source FROM leads WHERE tenant_id = $1", [tenantA]);
  const lead = leads.find((l) => l.contact === "rana@acme.com");
  check("sales records a lead",
    !!lead && lead.company === "Acme Law" && lead.name === "Rana" && lead.contact === "rana@acme.com");
  check("sales lead staged new / sourced agent",
    !!lead && lead.stage === "new" && lead.source === "agent");
  check("sales lead channel matches draft channel", !!lead && lead.channel === "email");
  check("sales lead tied to sales draft tenant",
    (await query<{ tenant_id: number }>("SELECT tenant_id FROM drafts WHERE id = $1", [outSales.draftId]))[0].tenant_id === tenantA);

  // --- broad / short / empty LLM outputs still produce drafts (content preserved) ---
  nextContent = "A".repeat(2000);
  const rLong = await generateDraft({ llm: stubLLM }, {
    tenantId: tenantA, agent: "research", channel: "x", topic: "long output", config: cfgA,
  });
  check("broad (long) output still drafts",
    rLong.content.length === 2000 &&
    (await query<{ status: string }>("SELECT status FROM drafts WHERE id = $1", [rLong.draftId]))[0].status === "pending");

  nextContent = "ok";
  const rShort = await generateDraft({ llm: stubLLM }, {
    tenantId: tenantA, agent: "marketing", channel: "x", topic: "short output", config: cfgA,
  });
  check("short output still drafts",
    rShort.content === "ok" &&
    (await query<{ content: string }>("SELECT content FROM drafts WHERE id = $1", [rShort.draftId]))[0].content === "ok");

  nextContent = "";
  const rEmpty = await generateDraft({ llm: stubLLM }, {
    tenantId: tenantA, agent: "marketing", channel: "x", topic: "empty output", config: cfgA,
  });
  check("empty output still drafts",
    rEmpty.content === "" &&
    (await query<{ content: string; status: string }>("SELECT content, status FROM drafts WHERE id = $1", [rEmpty.draftId]))[0].content === "" &&
    (await query<{ status: string }>("SELECT status FROM drafts WHERE id = $1", [rEmpty.draftId]))[0].status === "pending");

  // --- tenant scoping: the config passed in is the one injected (tenant A voice, never B's) ---
  nextContent = "tenant A copy";
  await generateDraft({ llm: stubLLM }, {
    tenantId: tenantA, agent: "marketing", channel: "x", topic: "a post", config: cfgA,
  });
  const sysA = lastMessages.find((m) => m.role === "system")?.content ?? "";
  check("tenant A config injected, tenant B's not",
    sysA.includes("professional and warm") && !sysA.includes("bold and punchy"));

  nextContent = "tenant B copy";
  await generateDraft({ llm: stubLLM }, {
    tenantId: tenantB, agent: "marketing", channel: "x", topic: "b post", config: cfgB,
  });
  const sysB = lastMessages.find((m) => m.role === "system")?.content ?? "";
  check("tenant B config injected, tenant A's not",
    sysB.includes("bold and punchy") && !sysB.includes("professional and warm"));
  check("tenant B draft scoped to tenant B",
    (await query<{ id: number }>("SELECT id FROM drafts WHERE tenant_id = $1 AND content = $2", [tenantB, "tenant B copy"])).length === 1);
  // config never leaks across tenants: A has drafts, B only the one it generated
  const idA = (await query<{ id: number }>("SELECT id FROM drafts WHERE tenant_id = $1", [tenantA])).map((r) => r.id);
  const idB = (await query<{ id: number }>("SELECT id FROM drafts WHERE tenant_id = $1", [tenantB])).map((r) => r.id);
  check("draft rows are tenant-scoped", idA.length > 0 && idB.length === 1 && idA.every((x) => !idB.includes(x)));
} finally {
  if (tenantA !== undefined) await query("DELETE FROM tenants WHERE id = $1", [tenantA]);
  if (tenantB !== undefined) await query("DELETE FROM tenants WHERE id = $1", [tenantB]);
}

if (failures > 0) { console.error(`${failures} FAIL`); process.exit(1); }
console.log("GENERATORS SUITE PASS");