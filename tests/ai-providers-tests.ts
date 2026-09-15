import {
  resolveProvider,
  resolveProviderSafe,
  defaultChatModelFor,
  defaultEmbedModelFor,
} from "../lib/ai/providers/resolve";
import { makeOpenAICompatible, requireEnv } from "../lib/ai/providers/openai-compatible";
import { makeOpenAI } from "../lib/ai/providers/openai";
import type { ChatMessage } from "../lib/ai/types";

/**
 * Provider resolution + OpenAI-compatible adapter suite (Phase 10.5 —
 * free-tier enablement). Pure unit: no DB. Proves
 *  - LLM_PROVIDER selects the adapter and the ledger name
 *  - the OpenAI adapter keeps its exact Phase-4 wire behavior (delegation)
 *  - gemini posts to its OpenAI-compat root with dimensions=1536 and
 *    MRL-truncates oversized embeddings back to the vector(1536) column
 *  - chat/embed-only providers fail loudly with actionable guidance
 *  - a bad LLM_PROVIDER never takes the app down (safe fallback)
 */
let failures = 0;
function check(name: string, cond: boolean, detail = "") {
  console.log(`${cond ? "PASS" : "FAIL"} ${name}${detail ? " :: " + detail : ""}`);
  if (!cond) failures++;
}

type Recorded = { url: string; headers: Record<string, string>; body: any };
function recordingFetch(payload: unknown, status = 200) {
  const calls: Recorded[] = [];
  const impl = (async (url: string, init: RequestInit = {}) => {
    calls.push({
      url: String(url),
      headers: (init.headers as Record<string, string>) ?? {},
      body: JSON.parse(String(init.body ?? "{}")),
    });
    return new Response(JSON.stringify(payload), { status });
  }) as unknown as typeof fetch;
  return { calls, impl, last: () => calls[calls.length - 1] };
}

const chatPayload = { choices: [{ message: { content: "hello" } }], model: "served-model", usage: { prompt_tokens: 3, completion_tokens: 5, total_tokens: 8 } };
const MSGS: ChatMessage[] = [{ role: "user", content: "hi" }];

const savedEnv: Record<string, string | undefined> = {};
function setEnv(k: string, v: string | undefined) {
  if (!(k in savedEnv)) savedEnv[k] = process.env[k];
  if (v === undefined) delete process.env[k];
  else process.env[k] = v;
}

try {
  // --- resolution: default is openai ---
  setEnv("LLM_PROVIDER", undefined);
  const def = resolveProvider();
  check("default LLM_PROVIDER resolves openai", def.name === "openai");

  // --- OpenAI adapter delegation preserves Phase-4 wire behavior ---
  setEnv("OPENAI_API_KEY", "test-openai-key");
  setEnv("OPENAI_MODEL", "test-openai-model");
  const oa = recordingFetch(chatPayload);
  await makeOpenAI(oa.impl).complete(MSGS, { temperature: 0.4 });
  check("openai adapter still posts to api.openai.com", oa.last().url === "https://api.openai.com/v1/chat/completions", oa.last().url);
  check("openai adapter still honors OPENAI_MODEL", oa.last().body.model === "test-openai-model", oa.last().body.model);
  check("openai adapter still sends Bearer key", oa.last().headers.Authorization === "Bearer test-openai-key");

  // --- gemini resolution + wire shape ---
  setEnv("LLM_PROVIDER", "gemini");
  setEnv("GEMINI_API_KEY", "test-gemini-key");
  const gm = recordingFetch(chatPayload);
  const gemini = resolveProvider(gm.impl);
  check("LLM_PROVIDER=gemini resolves gemini", gemini.name === "gemini");
  await gemini.client.complete(MSGS);
  check("gemini posts to its OpenAI-compat root", gm.last().url === "https://generativelanguage.googleapis.com/v1beta/openai/chat/completions", gm.last().url);
  check("gemini carries GEMINI_API_KEY", gm.last().headers.Authorization === "Bearer test-gemini-key");
  check("gemini default chat model", gm.last().body.model === "gemini-2.0-flash", gm.last().body.model);
  await gemini.client.complete(MSGS, { model: "gemini-2.5-flash" });
  check("gemini explicit model override", gm.last().body.model === "gemini-2.5-flash", gm.last().body.model);

  // gemini embeddings: dimensions requested + MRL truncate guard.
  // Bound to a dedicated recording fetch (the resolveProvider instance is
  // wired to the chat stub above).
  const wide = Array.from({ length: 3072 }, (_, i) => ((i % 7) - 3) + 0.5); // deterministic 3072-dim
  const ge = recordingFetch({ data: [{ embedding: wide }], model: "gemini-embedding-001", usage: { prompt_tokens: 4 } });
  const geminiEmbed = makeOpenAICompatible(
    {
      provider: "gemini",
      baseUrl: "https://generativelanguage.googleapis.com/v1beta/openai",
      apiKey: () => "test-gemini-key",
      chatModelEnv: "LLM_CHAT_MODEL",
      embedModelEnv: "LLM_EMBED_MODEL",
      defaultChatModel: "gemini-2.0-flash",
      defaultEmbedModel: "gemini-embedding-001",
      embedDimensions: 1536,
      embedTargetDim: 1536,
    },
    ge.impl
  );
  const embedded = await geminiEmbed.embedWithUsage(["doc one"], { timeoutMs: 5000 });
  check("gemini embed requests dimensions=1536", ge.last().body.dimensions === 1536, JSON.stringify(ge.last().body.dimensions));
  check("gemini embed posts to /embeddings", ge.last().url.endsWith("/embeddings"), ge.last().url);
  check("MRL guard truncates 3072 -> 1536", embedded.vectors[0].length === 1536, String(embedded.vectors[0].length));
  const trunc = wide.slice(0, 1536);
  const norm = Math.sqrt(trunc.reduce((s, x) => s + x * x, 0));
  check("MRL guard renormalizes (unit norm)", Math.abs(embedded.vectors[0][10] - trunc[10] / norm) < 1e-9);
  check("MRL guard preserves direction", Math.abs(embedded.vectors[0][0] * norm - trunc[0]) < 1e-9);

  // exact-width passthrough (no renormalization of an already-1536 vector)
  const exact = Array.from({ length: 1536 }, (_, i) => (i % 3) + 1);
  const ge2 = recordingFetch({ data: [{ embedding: exact }], model: "m" });
  const geminiEmbed2 = makeOpenAICompatible(
    {
      provider: "gemini",
      baseUrl: "https://generativelanguage.googleapis.com/v1beta/openai",
      apiKey: () => "test-gemini-key",
      defaultChatModel: "gemini-2.0-flash",
      defaultEmbedModel: "gemini-embedding-001",
      embedDimensions: 1536,
      embedTargetDim: 1536,
    },
    ge2.impl
  );
  const out2 = await geminiEmbed2.embedWithUsage(["x"]);
  check("1536-dim vector passes through unmodified", out2.vectors[0][5] === exact[5] && out2.vectors[0].length === 1536);

  // undersized embedding fails loudly
  const ge3 = recordingFetch({ data: [{ embedding: Array.from({ length: 10 }, () => 0.1) }], model: "m" });
  const geminiEmbed3 = makeOpenAICompatible(
    {
      provider: "gemini",
      baseUrl: "https://generativelanguage.googleapis.com/v1beta/openai",
      apiKey: () => "test-gemini-key",
      defaultChatModel: "gemini-2.0-flash",
      defaultEmbedModel: "gemini-embedding-001",
      embedDimensions: 1536,
      embedTargetDim: 1536,
    },
    ge3.impl
  );
  let undersized = "";
  try {
    await geminiEmbed3.embedWithUsage(["x"]);
  } catch (e) {
    undersized = e instanceof Error ? e.message : String(e);
  }
  check("undersized embedding rejected with guidance", undersized.includes("width 10"), undersized.slice(0, 120));

  // --- groq: chat only ---
  setEnv("LLM_PROVIDER", "groq");
  setEnv("GROQ_API_KEY", "test-groq-key");
  const gq = recordingFetch(chatPayload);
  const groq = resolveProvider(gq.impl);
  check("LLM_PROVIDER=groq resolves groq", groq.name === "groq");
  await groq.client.complete(MSGS);
  check("groq posts to its OpenAI-compat root", gq.last().url === "https://api.groq.com/openai/v1/chat/completions", gq.last().url);
  check("groq default chat model", gq.last().body.model === "llama-3.3-70b-versatile", gq.last().body.model);
  let groqEmbedErr = "";
  try {
    await groq.client.embed(["x"]);
  } catch (e) {
    groqEmbedErr = e instanceof Error ? e.message : String(e);
  }
  check("groq embed fails with provider guidance", groqEmbedErr.includes("gemini") || groqEmbedErr.includes("embeddings"), groqEmbedErr.slice(0, 140));

  // --- openrouter: attribution headers ---
  setEnv("LLM_PROVIDER", "openrouter");
  setEnv("OPENROUTER_API_KEY", "test-or-key");
  setEnv("NEXT_PUBLIC_APP_URL", "https://masteragent-nine.vercel.app");
  const or = recordingFetch(chatPayload);
  const openrouter = resolveProvider(or.impl);
  await openrouter.client.complete(MSGS);
  check("openrouter posts to its root", or.last().url === "https://openrouter.ai/api/v1/chat/completions", or.last().url);
  check("openrouter sends HTTP-Referer attribution", or.last().headers["HTTP-Referer"] === "https://masteragent-nine.vercel.app");
  check("openrouter sends X-Title", or.last().headers["X-Title"] === "AgentOS");
  check("openrouter default free model", or.last().body.model === "meta-llama/llama-3.3-70b-instruct:free", or.last().body.model);

  // --- custom: strict config validation ---
  setEnv("LLM_PROVIDER", "custom");
  setEnv("LLM_BASE_URL", undefined);
  let customErr = "";
  try {
    resolveProvider();
  } catch (e) {
    customErr = e instanceof Error ? e.message : String(e);
  }
  check("custom without LLM_BASE_URL rejected", customErr.includes("LLM_BASE_URL"), customErr.slice(0, 120));
  setEnv("LLM_BASE_URL", "https://my-vllm.internal/v1");
  setEnv("LLM_CHAT_MODEL", undefined);
  customErr = "";
  try {
    resolveProvider();
  } catch (e) {
    customErr = e instanceof Error ? e.message : String(e);
  }
  check("custom without LLM_CHAT_MODEL rejected", customErr.includes("LLM_CHAT_MODEL"), customErr.slice(0, 120));
  setEnv("LLM_CHAT_MODEL", "Qwen/Qwen2.5-7B");
  setEnv("LLM_API_KEY", "test-custom-key");
  const cu = recordingFetch(chatPayload);
  const custom = resolveProvider(cu.impl);
  check("custom resolves with name custom", custom.name === "custom");
  await custom.client.complete(MSGS);
  check("custom posts to LLM_BASE_URL", cu.last().url === "https://my-vllm.internal/v1/chat/completions", cu.last().url);
  check("custom uses LLM_CHAT_MODEL", cu.last().body.model === "Qwen/Qwen2.5-7B");

  // --- unknown provider never takes the app down ---
  setEnv("LLM_PROVIDER", "doesnotexist");
  let unknownErr = "";
  try {
    resolveProvider();
  } catch (e) {
    unknownErr = e instanceof Error ? e.message : String(e);
  }
  check("unknown LLM_PROVIDER rejected with options", unknownErr.includes("gemini") && unknownErr.includes("openai"), unknownErr.slice(0, 140));
  const safe = resolveProviderSafe();
  check("resolveProviderSafe falls back to openai", safe.name === "openai");

  // --- gateway model defaults stay provider-aware ---
  setEnv("LLM_CHAT_MODEL", undefined);
  check("defaultChatModelFor openai", defaultChatModelFor("openai") === "test-openai-model");
  check("defaultChatModelFor gemini default", defaultChatModelFor("gemini") === "gemini-2.0-flash");
  check("defaultChatModelFor gemini env override", (setEnv("LLM_CHAT_MODEL", "gemini-2.5-flash"), defaultChatModelFor("gemini") === "gemini-2.5-flash"));
  setEnv("LLM_CHAT_MODEL", undefined);
  check("defaultChatModelFor unknown is null (gateway fails fast)", defaultChatModelFor("mystery") === null);
  check("defaultEmbedModelFor groq is unavailable", defaultEmbedModelFor("groq") === "unavailable");
  check("defaultEmbedModelFor gemini default", defaultEmbedModelFor("gemini") === "gemini-embedding-001");

  // --- requireEnv helper ---
  setEnv("LLM_PROBE_A", undefined);
  setEnv("LLM_PROBE_B", "yes");
  let reqErr = "";
  try {
    requireEnv("LLM_PROBE_A", "LLM_PROBE_B");
  } catch (e) {
    reqErr = e instanceof Error ? e.message : String(e);
  }
  check("requireEnv picks first non-empty", reqErr === "", reqErr.slice(0, 80));
  setEnv("LLM_PROBE_B", undefined);
  try {
    requireEnv("LLM_PROBE_A", "LLM_PROBE_B");
  } catch (e) {
    reqErr = e instanceof Error ? e.message : String(e);
  }
  check("requireEnv throws listing all names", reqErr.includes("LLM_PROBE_A") && reqErr.includes("LLM_PROBE_B"));

  // --- factory embed-model env override ---
  setEnv("LLM_PROVIDER", "gemini");
  setEnv("LLM_EMBED_MODEL", "text-embedding-004");
  const ge4 = recordingFetch({ data: [{ embedding: exact }], model: "text-embedding-004" });
  const geminiEmbed4 = makeOpenAICompatible(
    {
      provider: "gemini",
      baseUrl: "https://generativelanguage.googleapis.com/v1beta/openai",
      apiKey: () => "test-gemini-key",
      chatModelEnv: "LLM_CHAT_MODEL",
      embedModelEnv: "LLM_EMBED_MODEL",
      defaultChatModel: "gemini-2.0-flash",
      defaultEmbedModel: "gemini-embedding-001",
      embedDimensions: 1536,
      embedTargetDim: 1536,
    },
    ge4.impl
  );
  await geminiEmbed4.embed(["x"]);
  check("LLM_EMBED_MODEL overrides gemini embed model", ge4.last().body.model === "text-embedding-004", ge4.last().body.model);
} finally {
  for (const [k, v] of Object.entries(savedEnv)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
}

console.log(failures === 0 ? "\nALL PASS" : `\n${failures} FAILURE(S)`);
if (failures > 0) process.exit(1);
