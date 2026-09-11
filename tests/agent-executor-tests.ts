import { query } from "../lib/db";
import { dispatch, getTenantConfig, AgentNotRunnableError } from "../lib/agents/dispatch";
import { makeGenericLLMExecutor } from "../lib/agents/executors";
import { getAgentBySlug, setAgentStatus, currentVersion, createAgentVersion } from "../lib/agents/registry";
import type { LLMClient } from "../lib/llm";

/**
 * Agent executor suite (Phase 2):
 *  - generic LLM executor runs a registry-only agent from its versioned prompt
 *  - bound executors produce byte-identical legacy prompts (golden)
 *  - run attribution: agent_id, business_unit_id, prompt_version_id, model,
 *    timing, real prompt_hash
 *  - failed executions are RECORDED as failed (§71) with an error class
 *  - registry refusal surfaces as AgentNotRunnableError → route 409
 */
let failures = 0;
function check(name: string, cond: boolean, detail = "") {
  console.log(`${cond ? "PASS" : "FAIL"} ${name}${detail ? " :: " + detail : ""}`);
  if (!cond) failures++;
}

const stamp = Date.now();
const createdTenantIds: number[] = [];
const createdAgentSlugs: string[] = [];

let completeCalls = 0;
let lastSystem = "";
const stubLLM: LLMClient = {
  async complete(messages) {
    completeCalls++;
    lastSystem = (messages as { role: string; content: string }[]).find((m) => m.role === "system")?.content ?? "";
    return "Generic agent output";
  },
  async embed() { return []; },
};

const sysPromptOf = async (tenantId: number) =>
  (await dispatch({ llm: stubLLM, getConfig: getTenantConfig }, { tenantId, topic: "probe", channel: "x" }));

try {
  const [t] = await query<{ id: number }>(
    `INSERT INTO tenants (slug, name) VALUES ($1, $2) RETURNING id`, [`ax-t-${stamp}`, "Executor Tenant"]);
  createdTenantIds.push(t.id);
  await query("INSERT INTO tenant_config (tenant_id, brand_voice, persona, audience) VALUES ($1, $2, $3, $4)",
    [t.id, "warm and practical", "master builder", "first-time buyers"]);

  // ---------- generic LLM executor on a registry-only agent ----------
  // Seed a fresh llm-kind agent + version, then run it through dispatch.
  const slug = `greeter-${stamp}`;
  createdAgentSlugs.push(slug);
  const [ga] = await query<{ id: number }>(
    `INSERT INTO agents (slug, name, description, executor_kind, status) VALUES ($1, 'Greeter', 'test agent', 'llm', 'active') RETURNING id`,
    [slug]
  );
  const version = await createAgentVersion({
    agentId: ga.id,
    systemPrompt: "Greeter agent: write a friendly one-line greeting.",
    changelog: "executor suite seed",
  });

  completeCalls = 0;
  const res = await dispatch({ llm: stubLLM, getConfig: getTenantConfig },
    { tenantId: t.id, topic: "welcome new visitors", channel: "x" });
  // default marketing path first (topic has no keywords) — sanity
  check("default path still routes to marketing", res.agent === "marketing");
  check("bound executor ran (legacy path)", completeCalls === 1);

  // Now drive the generic executor DIRECTLY (registry-only agent, no router entry by design):
  completeCalls = 0;
  const gen = makeGenericLLMExecutor({ systemPrompt: version.systemPrompt, agentSlug: slug });
  const out = await gen({ llm: stubLLM }, {
    tenantId: t.id, channel: "linkedin", topic: "say hello",
    config: { brandVoice: "warm", persona: "host", audience: "guests" },
  });
  check("generic executor calls the LLM once", completeCalls === 1);
  check("generic executor output creates a draft under the registry slug",
    out.draftId != null &&
    (await query<{ agent: string }>("SELECT agent FROM drafts WHERE id = $1", [out.draftId!]))[0].agent === slug);
  check("generic executor prompt assembly: version prompt + brand config + rules",
    lastSystem.startsWith("Greeter agent: write a friendly one-line greeting.") &&
    lastSystem.includes("Brand voice: warm") && lastSystem.includes("Persona: host") &&
    lastSystem.includes("never mention abilities you lack"));

  // ---------- run attribution on the marketing path ----------
  const runRow = (await query<{
    agent: string; agent_id: number | null; business_unit_id: number | null;
    prompt_version_id: number | null; prompt_hash: string; topic: string | null;
    model: string | null; started_at: Date | null; completed_at: Date | null;
    duration_ms: number | null; status: string; output_ref: string | null;
  }>("SELECT agent, agent_id, business_unit_id, prompt_version_id, prompt_hash, topic, model, started_at, completed_at, duration_ms, status, output_ref FROM agent_runs WHERE id = $1", [res.runId]))[0];
  const mkt = await getAgentBySlug("marketing");
  const mktVersion = mkt ? await currentVersion(mkt.id) : null;
  check("run attribution: agent_id + prompt_version_id + model recorded",
    runRow.agent_id === mkt?.id && runRow.prompt_version_id === mktVersion?.id && runRow.model === "gpt-4o-mini");
  check("run attribution: topic column carries the goal topic (C-14)", runRow.topic === "probe");
  check("run attribution: timing recorded", runRow.started_at != null && runRow.completed_at != null && (runRow.duration_ms ?? -1) >= 0);
  check("run attribution: output_ref points at the draft", runRow.output_ref === `drafts/${res.draftId}`);
  check("run attribution: prompt_hash = sha-256 of the rendered system prompt (golden)",
    runRow.prompt_hash === (await import("node:crypto")).createHash("sha256").update("You are the Marketing agent: write platform-appropriate social copy that fits the channel's style and character limits.\nBrand voice: warm and practical\nPersona: master builder\nTarget audience: first-time buyers\nRules: no invented facts; no legal claims not present in the input; never mention abilities you lack.").digest("hex"));

  // ---------- failed executions are recorded ----------
  const failingLLM: LLMClient = {
    async complete() { throw new Error("llm complete 429: insufficient_quota"); },
    async embed() { return []; },
  };
  let threw = false;
  try {
    await dispatch({ llm: failingLLM, getConfig: getTenantConfig }, { tenantId: t.id, topic: "another post", channel: "x" });
  } catch {
    threw = true;
  }
  check("dispatch rethrows executor failure", threw);
  const [failedRow] = await query<{ status: string; error_class: string; error: string | null; agent_id: number | null }>(
    "SELECT status, error_class, error, agent_id FROM agent_runs WHERE tenant_id = $1 AND status = 'failed' ORDER BY id DESC LIMIT 1",
    [t.id]
  );
  check("failed run recorded with provider_quota class",
    failedRow?.status === "failed" && failedRow.error_class === "provider_quota" && failedRow.agent_id === mkt?.id);

  // ---------- registry refusal via dispatch ----------
  const marketing = await getAgentBySlug("marketing");
  await setAgentStatus(marketing!.id, "disabled");
  let refused: AgentNotRunnableError | null = null;
  try {
    await dispatch({ llm: stubLLM, getConfig: getTenantConfig }, { tenantId: t.id, topic: "third post", channel: "x" });
  } catch (e) {
    if (e instanceof AgentNotRunnableError) refused = e;
  }
  check("disabled agent refuses with AGENT_DISABLED", refused?.code === "AGENT_DISABLED");
  await setAgentStatus(marketing!.id, "active");
  check("re-enabled agent dispatches again", (await sysPromptOf(t.id)).agent === "marketing");

  // ---------- BU-scoped refusal: BU-disabled agent via the route (409) ----------
  // dispatch-tests already cover the HTTP 409 path via AgentNotRunnableError
  // mapping; here we assert the class contract directly.
  check("AgentNotRunnableError carries a stable code", new AgentNotRunnableError("AGENT_BU_DISABLED").code === "AGENT_BU_DISABLED");
} finally {
  try {
    await query("DELETE FROM drafts WHERE tenant_id = ANY($1)", [createdTenantIds.length ? createdTenantIds : [0]]);
    await query("DELETE FROM agent_runs WHERE tenant_id = ANY($1)", [createdTenantIds.length ? createdTenantIds : [0]]);
    await query("DELETE FROM agent_runs WHERE agent = ANY($1)", [createdAgentSlugs.length ? createdAgentSlugs : ["—"]]);
    await query("DELETE FROM drafts WHERE agent = ANY($1)", [createdAgentSlugs.length ? createdAgentSlugs : ["—"]]);
    await query("DELETE FROM agent_versions WHERE agent_id IN (SELECT id FROM agents WHERE slug = ANY($1))", [createdAgentSlugs.length ? createdAgentSlugs : ["—"]]);
    await query("DELETE FROM business_unit_agents WHERE agent_id IN (SELECT id FROM agents WHERE slug = ANY($1))", [createdAgentSlugs.length ? createdAgentSlugs : ["—"]]);
    await query("DELETE FROM agents WHERE slug = ANY($1)", [createdAgentSlugs.length ? createdAgentSlugs : ["—"]]);
    await query("DELETE FROM tenant_config WHERE tenant_id = ANY($1)", [createdTenantIds.length ? createdTenantIds : [0]]);
    await query("DELETE FROM tenants WHERE id = ANY($1)", [createdTenantIds.length ? createdTenantIds : [0]]);
  } catch (e) {
    console.error("cleanup error", e);
  }
}

if (failures > 0) { console.error(`${failures} FAIL`); process.exit(1); }
console.log("AGENT-EXECUTOR SUITE PASS");
