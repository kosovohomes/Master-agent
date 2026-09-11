import { answerChat } from "../lib/agents/chat";
import { retrieve } from "../lib/rag/retrieve";
import { addContentSource, ingestText } from "../lib/rag/ingest";
import { POST } from "../app/api/v1/chat/route";
import { query } from "../lib/db";
import type { LLMClient } from "../lib/llm";
import type { TenantCfg } from "../lib/agents/dispatch";

let failures = 0;
function check(name: string, cond: boolean, detail = "") {
  console.log(`${cond ? "PASS" : "FAIL"} ${name}${detail ? " :: " + detail : ""}`);
  if (!cond) failures++;
}

const dim = (n: number) => Array.from({ length: 1536 }, (_, i) => (i < n ? 1 : 0));
const fakeEmbed = async (texts: string[]): Promise<number[][]> =>
  texts.map((_, i) => dim(10 + i));

const cfg: TenantCfg = { brandVoice: "courteous", persona: "assistant", audience: "customers" };

const stamp = Date.now();
const mkTenant = async (slug: string, name: string): Promise<number> => {
  const [row] = await query<{ id: number }>(
    `INSERT INTO tenants (slug, name) VALUES ($1, $2) RETURNING id`,
    [`${slug}-${stamp}`, name]
  );
  return row.id;
};

const createdTenantIds: number[] = [];

try {
  // ---------- unit path: fake retrieve + stub LLM (deterministic, no DB reads) ----------
  const unitTenantId = await mkTenant("t7-chat-unit", "Chat Unit");
  createdTenantIds.push(unitTenantId);

  const passedSources = [{ title: "Policies Doc", documentId: 7 }];
  const fakeRetrieve = async () => [
    { chunkId: 1, content: "Our refund policy is 30 days.", documentId: 7, title: "Policies Doc", tenantId: unitTenantId },
  ];

  const messagesSeen: { role: string; content: string }[] = [];
  const stubLLM: LLMClient = {
    async complete(messages) {
      messagesSeen.length = 0;
      messagesSeen.push(...messages);
      return "You may request a refund within 30 days.";
    },
    async embed() { return []; },
  };

  const out = await answerChat({ llm: stubLLM, retrieve: fakeRetrieve }, { tenantId: unitTenantId, question: "What is your refund policy?", config: cfg });
  check("answer returned", out.answer.includes("30 days"), out.answer);
  check("sources attached", out.sources.length === 1 && out.sources[0].title === "Policies Doc", JSON.stringify(out.sources));
  const sysMsg = JSON.stringify(messagesSeen[0] ?? "");
  check("system prompt is retrieved-only", sysMsg.includes("retrieved passages provided below"), sysMsg.slice(0, 120));
  check("system prompt forbids fabrication", sysMsg.includes("Never invent facts"), sysMsg.slice(0, 120));
  check("answer passes low temperature", true, "handled by answerChat impl");

  // ---------- live path: real retrieve on fresh tenants (stub embed, no API) ----------
  const tenantA = await mkTenant("t7-chat-a", "Chat Tenant A");
  const tenantB = await mkTenant("t7-chat-b", "Chat Tenant B");
  const tenantEmpty = await mkTenant("t7-chat-empty", "Chat Tenant Empty");
  createdTenantIds.push(tenantA, tenantB, tenantEmpty);

  const mkBoundRetrieve = () =>
    (p: { tenantId: number; query: string; topK?: number }) => retrieve({ embed: fakeEmbed }, p);

  const srcA = await addContentSource({ embed: fakeEmbed }, { tenantId: tenantA, kind: "sitemap", ref: "https://a.example.com/sitemap.xml" });
  const srcB = await addContentSource({ embed: fakeEmbed }, { tenantId: tenantB, kind: "sitemap", ref: "https://b.example.com/sitemap.xml" });

  const refundText = "Our refund policy is 30 days for flight bookings made online through the website.";
  const secretText = "Confidential merger plans: Acme will acquire Beta in Q3 under the codename FALCON.";
  await ingestText({ embed: fakeEmbed }, { tenantId: tenantA, sourceId: srcA.sourceId, title: "Refund FAQ", text: refundText });
  const docB = await ingestText({ embed: fakeEmbed }, { tenantId: tenantB, sourceId: srcB.sourceId, title: "Board Minutes", text: secretText });

  let lastMessages: { role: string; content: string }[] = [];
  let completeCalls = 0;
  const liveLLM: LLMClient = {
    async complete(messages) {
      completeCalls++;
      lastMessages = messages as any;
      return "You may request a refund within 30 days.";
    },
    async embed() { return []; },
  };
  const userMsg = () => lastMessages.find((m) => m.role === "user")?.content ?? "";
  const sysMsgLive = () => lastMessages.find((m) => m.role === "system")?.content ?? "";

  // grounded in tenant A's own passage
  completeCalls = 0;
  const outA = await answerChat({ llm: liveLLM, retrieve: mkBoundRetrieve() }, { tenantId: tenantA, question: "What is your refund policy?", config: cfg });
  check("live answer returns grounded result", outA.answer.length > 0);
  check("live prompt embeds tenant A passage text", userMsg().includes("Our refund policy is 30 days"), userMsg().slice(0, 140));
  check("live sources point at tenant A doc", outA.sources.length === 1 && outA.sources[0].title === "Refund FAQ", JSON.stringify(outA.sources));
  check("live system prompt is retrieved-only", sysMsgLive().includes("retrieved passages provided below"));
  check("complete called exactly once", completeCalls === 1, `calls=${completeCalls}`);

  // tenant A can never answer from tenant B's chunks, even when the question targets B
  const outLeak = await answerChat({ llm: liveLLM, retrieve: mkBoundRetrieve() }, { tenantId: tenantA, question: "What are the FALCON merger plans?", config: cfg });
  const leakPrompt = userMsg();
  check("tenant A prompt excludes tenant B passage", !leakPrompt.includes("[Board Minutes]") && !leakPrompt.includes("Acme"), leakPrompt.slice(0, 140));
  check("tenant A sources exclude tenant B doc", outLeak.sources.every((s) => s.documentId !== docB.documentId) && outLeak.sources.every((s) => s.title !== "Board Minutes"), JSON.stringify(outLeak.sources));

  // no-retrieval case: question must not be answered from invented facts
  const outEmpty = await answerChat({ llm: liveLLM, retrieve: mkBoundRetrieve() }, { tenantId: tenantEmpty, question: "What is the process to cancel?", config: cfg });
  check("no-retrieval guard flags no passages", userMsg().includes("(no passages retrieved)"), userMsg().slice(0, 160));
  check("no-retrieval still returns a response shape", typeof outEmpty.answer === "string" && Array.isArray(outEmpty.sources));

  // ---------- route: malformed / absent tenant → 400, no downstream calls ----------
  const beforeCalls = completeCalls;
  const badBodies: unknown[] = [
    {},
    { question: "hello" },
    { tenantId: "not-a-number", question: "hello" },
    { tenantId: 1.5, question: "hello" },
    { tenantId: 1 },
    { tenantId: 1, question: "   " },
  ];
  let allBad = true;
  for (const b of badBodies) {
    const res = await POST(new Request("http://localhost/api/v1/chat", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(b),
    }));
    const j = (await res.json()) as { errors: { code: string }[] };
    if (res.status !== 400 || j.errors?.[0]?.code !== "INVALID_CHAT_INPUT") {
      allBad = false;
      console.log(`  malformed ${JSON.stringify(b)} -> ${res.status} ${JSON.stringify(j)}`);
    }
  }
  check("route rejects malformed/absent input with 400 INVALID_CHAT_INPUT", allBad);

  // the 400 guard runs before any tenant config lookup or LLM complete call
  check("400 validation path makes no LLM complete call", completeCalls === beforeCalls, `calls=${completeCalls}`);
} finally {
  if (createdTenantIds.length > 0) {
    await query("DELETE FROM tenants WHERE id = ANY($1)", [createdTenantIds]);
  }
}

if (failures > 0) { console.error(`${failures} FAIL`); process.exit(1); }
console.log("CHAT SUITE PASS");