import { query } from "../lib/db";
import {
  listAgents,
  getAgentBySlug,
  setAgentStatus,
  currentVersion,
  createAgentVersion,
  listVersions,
  setBuAgent,
  listBuAgents,
  checkRunnable,
  buIdForLegacyTenant,
  createAgentIdentity,
  listAgentIdentities,
  revokeAgentIdentity,
  promptHash,
} from "../lib/agents/registry";
import { isFlagEnabled, setFeatureFlag } from "../lib/settings";

/**
 * Agent Registry suite (Phase 2 acceptance):
 *  - registry CRUD + versioning + per-BU enablement
 *  - flipping an agent's enabled flag changes behavior in <= 1 run, zero deploys
 *  - the four survivors are seeded active/bound; placeholders seeded disabled
 *  - machine identity lifecycle
 */
let failures = 0;
function check(name: string, cond: boolean, detail = "") {
  console.log(`${cond ? "PASS" : "FAIL"} ${name}${detail ? " :: " + detail : ""}`);
  if (!cond) failures++;
}

const stamp = Date.now();
const createdAgentIds: number[] = [];
const createdBuIds: number[] = [];
const createdTenantIds: number[] = [];
const createdFlagKeys: string[] = [];

try {
  // ---------- seed shape ----------
  const agents = await listAgents();
  const survivors = ["research", "marketing", "sales", "customer_service"];
  check("registry seeds the four survivors active", survivors.every((s) => agents.find((a) => a.slug === s)?.status === "active"));
  check("survivors are bound executors", survivors.every((s) => agents.find((a) => a.slug === s)?.executorKind === "bound"));
  check("ambassador is NOT a registry row (fold decision)",
    !agents.some((a) => a.slug === "ambassador"));
  const placeholders = ["supervisor", "intelligence", "legal_intelligence", "competitor", "content_strategy", "content", "fact_check", "seo", "social_media", "lead", "customer_inquiry", "customer_support", "analytics", "strategy", "reporting"];
  check("all 15 future-workforce placeholders seeded disabled",
    placeholders.every((s) => agents.find((a) => a.slug === s)?.status === "disabled"));
  check("registry has 19 rows (4 active + 15 placeholders)", agents.length === 19, `n=${agents.length}`);

  // golden prompts: version 1 of each survivor matches the legacy role line
  const golden: Record<string, string> = {
    research: "Research agent: produce a concise intel brief with bullets and sources.",
    marketing: "Marketing agent: write platform-appropriate social copy that fits the channel's style and character limits.",
    sales: "Sales agent: write a professional, non-spammy outreach or partnership pitch email.",
    customer_service: "Customer service agent: answer only from retrieved knowledge sources.",
  };
  for (const [slug, expected] of Object.entries(golden)) {
    const a = await getAgentBySlug(slug);
    const v = a ? await currentVersion(a.id) : null;
    check(`golden prompt v1 preserved for ${slug}`, v?.systemPrompt === expected && v?.version === 1);
  }

  // ---------- versioning ----------
  const [research] = agents.filter((a) => a.slug === "research");
  const v2 = await createAgentVersion({
    agentId: research.id,
    systemPrompt: "Research agent v2: deep-dive brief with confidence scores.",
    changelog: "test: second version",
  });
  check("createAgentVersion appends next version", v2.version === 2);
  const cur = await currentVersion(research.id);
  check("currentVersion returns the max version", cur?.id === v2.id && cur.version === 2);
  const hist = await listVersions(research.id);
  check("version history is complete and ordered desc", hist.length === 2 && hist[0].version === 2 && hist[1].version === 1);
  createdAgentIds.push(research.id); // only tag for cleanup; restore below
  // restore: append a v3 equal to the golden prompt (versions are immutable)
  await createAgentVersion({ agentId: research.id, systemPrompt: golden.research, changelog: "test: restore golden" });
  check("restore version appended", (await currentVersion(research.id))?.version === 3);

  // ---------- status flip propagates (acceptance: <= 1 run, zero deploys) ----------
  const runnableBefore = await checkRunnable("research", null);
  check("research runnable while active", runnableBefore.ok);
  const disabled = await setAgentStatus(research.id, "disabled");
  check("setAgentStatus flips to disabled", disabled?.status === "disabled");
  const runnableAfter = await checkRunnable("research", null);
  check("registry refuses a disabled agent on the very next check", !runnableAfter.ok && !runnableAfter.ok && runnableAfter.code === "AGENT_DISABLED");
  await setAgentStatus(research.id, "active");
  check("re-enabled agent is runnable again", (await checkRunnable("research", null)).ok);

  // ---------- kill-switch flag ----------
  const flagKey = `disable_agent:research-test-${stamp}`;
  createdFlagKeys.push(flagKey);
  await query(
    `INSERT INTO feature_flags (key, enabled, emergency, description) VALUES ($1, true, true, 'test kill switch') ON CONFLICT (key) DO UPDATE SET enabled = true`,
    [flagKey.replace("research-test", "marketing")] // flag must match a real slug; use marketing
  );
  createdFlagKeys.push(`disable_agent:marketing`);
  const flagged = await checkRunnable("marketing", null);
  check("kill-switch flag blocks even an active agent", !flagged.ok && flagged.code === "AGENT_KILL_SWITCH");
  await setFeatureFlag("disable_agent:marketing", false, null);
  check("flag off → agent runnable again", (await checkRunnable("marketing", null)).ok);

  // ---------- per-BU enablement ----------
  const [bu] = await query<{ id: number }>(
    `INSERT INTO business_units (slug, name) VALUES ($1, $2) RETURNING id`,
    [`rg-bu-${stamp}`, "Registry Test BU"]
  );
  createdBuIds.push(bu.id);
  const link = await setBuAgent(bu.id, research.id, false);
  check("setBuAgent disables research for the BU", link.enabled === false);
  const buBlocked = await checkRunnable("research", bu.id);
  check("BU-disabled agent refused for that BU", !buBlocked.ok && buBlocked.code === "AGENT_BU_DISABLED");
  const otherBu = await checkRunnable("research", null);
  check("BU-disablement does not leak to other contexts", otherBu.ok);
  const links = await listBuAgents(bu.id);
  check("listBuAgents returns the link", links.length === 1 && links[0].agentId === research.id && links[0].enabled === false);
  await setBuAgent(bu.id, research.id, true);
  check("re-enabled for BU → runnable", (await checkRunnable("research", bu.id)).ok);

  // ---------- legacy tenant mapping ----------
  const [t] = await query<{ id: number }>(
    `INSERT INTO tenants (slug, name) VALUES ($1, $2) RETURNING id`, [`rg-t-${stamp}`, "Registry Tenant"]);
  createdTenantIds.push(t.id);
  const [bu2] = await query<{ id: number }>(
    `INSERT INTO business_units (slug, name, legacy_tenant_id) VALUES ($1, $2, $3) RETURNING id`,
    [`rg-bu2-${stamp}`, "Legacy Mapped BU", t.id]
  );
  createdBuIds.push(bu2.id);
  check("buIdForLegacyTenant resolves the mapping", (await buIdForLegacyTenant(t.id)) === bu2.id);
  check("buIdForLegacyTenant returns null for unmapped tenants", (await buIdForLegacyTenant(999999999)) === null);

  // ---------- machine identities ----------
  const ident = await createAgentIdentity(research.id, `key-${stamp}`, "CI runner");
  check("identity created active", ident.status === "active" && ident.keyId === `key-${stamp}`);
  const idents = await listAgentIdentities(research.id);
  check("identity listed", idents.some((i) => i.id === ident.id));
  check("revokeAgentIdentity flips status", (await revokeAgentIdentity(ident.id)) === true);
  check("revoked identity no longer active", (await listAgentIdentities(research.id)).find((i) => i.id === ident.id)?.status === "revoked");

  // ---------- promptHash contract (C-14) ----------
  const h = promptHash("stable prompt");
  check("promptHash is sha-256 hex", /^[0-9a-f]{64}$/.test(h) && h === promptHash("stable prompt") && h !== promptHash("other prompt"));

  // ---------- agents.manage permission seeded ----------
  const [perm] = await query<{ n: number }>(
    `SELECT count(*)::int AS n FROM role_permissions rp
     JOIN roles r ON r.id = rp.role_id JOIN permissions p ON p.id = rp.permission_id
     WHERE p.key = 'agents.manage' AND r.key IN ('owner','administrator')`
  );
  check("agents.manage granted to owner + administrator", perm.n === 2);
} finally {
  // restore research registry state (versions/history are KEPT — immutable ledger)
  try {
    const a = await getAgentBySlug("research");
    if (a) await setAgentStatus(a.id, "active");
    await query("DELETE FROM business_unit_agents WHERE business_unit_id = ANY($1)", [createdBuIds.length ? createdBuIds : [0]]);
    await query("DELETE FROM agent_identities WHERE agent_id = ANY($1)", [createdAgentIds.length ? createdAgentIds : [0]]);
    await query("DELETE FROM business_units WHERE id = ANY($1)", [createdBuIds.length ? createdBuIds : [0]]);
    await query("DELETE FROM tenants WHERE id = ANY($1)", [createdTenantIds.length ? createdTenantIds : [0]]);
    for (const k of createdFlagKeys) await query("DELETE FROM feature_flags WHERE key = $1", [k]);
  } catch (e) {
    console.error("cleanup error", e);
  }
}

if (failures > 0) { console.error(`${failures} FAIL`); process.exit(1); }
console.log("REGISTRY SUITE PASS");
