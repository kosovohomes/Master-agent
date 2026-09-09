import { makeLLM, llm, type ChatMessage } from "../lib/llm";

let failures = 0;
function check(name: string, cond: boolean, detail = "") {
  console.log(`${cond ? "PASS" : "FAIL"} ${name}${detail ? " :: " + detail : ""}`);
  if (!cond) failures++;
}

// Env is read at call time, so tests own these vars. Restore after the run.
const savedEnv = {
  api: process.env.OPENAI_API_KEY,
  model: process.env.OPENAI_MODEL,
  embed: process.env.OPENAI_EMBEDDINGS_MODEL,
};
process.env.OPENAI_API_KEY = "test-secret-abc";
process.env.OPENAI_MODEL = "test-model-1";
process.env.OPENAI_EMBEDDINGS_MODEL = "test-embed-1";

type Call = {
  url: string;
  init: RequestInit;
  body: any;
  headers: Record<string, string>;
};
const calls: Call[] = [];
function resetCalls() {
  calls.length = 0;
}
function lastCall(): Call {
  return calls[calls.length - 1];
}
function recordCall(url: string, init: RequestInit, body: unknown): void {
  calls.push({
    url,
    init,
    body,
    headers: (init.headers as Record<string, string> | undefined) ?? {},
  });
}
function jsonFetch(status: number, payload: unknown): typeof fetch {
  return (async (url: string, init: RequestInit = {}) => {
    recordCall(url, init, JSON.parse(String(init.body ?? "{}")));
    return new Response(JSON.stringify(payload), { status });
  }) as unknown as typeof fetch;
}
function rawFetch(bodyText: string, status = 200): typeof fetch {
  return (async (url: string, init: RequestInit = {}) => {
    recordCall(url, init, {});
    return new Response(bodyText, { status });
  }) as unknown as typeof fetch;
}

try {
  // --- complete: request shape + response parsing ---
  resetCalls();
  const out = await makeLLM(jsonFetch(200, { choices: [{ message: { content: "hi" } }] }))
    .complete([{ role: "user", content: "hello" }], { temperature: 0.2 });
  check("complete returns assistant message content", out === "hi", `got ${JSON.stringify(out)}`);
  check("complete posts to /v1/chat/completions", lastCall().url === "https://api.openai.com/v1/chat/completions", lastCall().url);
  check("complete uses HTTP POST", lastCall().init.method === "POST");
  check("body sends messages list", Array.isArray(lastCall().body.messages) && lastCall().body.messages[0].content === "hello");
  check("body uses OPENAI_MODEL by default", lastCall().body.model === "test-model-1", `got ${JSON.stringify(lastCall().body.model)}`);
  check("temperature forwarded", lastCall().body.temperature === 0.2, `got ${lastCall().body.temperature}`);
  check("Authorization bearer header carries key",
    lastCall().headers["Authorization"] === "Bearer test-secret-abc",
    `got ${JSON.stringify(lastCall().headers["Authorization"])}`);
  check("Content-Type json header", lastCall().headers["Content-Type"] === "application/json");

  resetCalls();
  await makeLLM(jsonFetch(200, { choices: [{ message: { content: "x" } }] }))
    .complete([{ role: "user", content: "hi" }], { model: "override-model", temperature: 0.9 });
  check("opts.model overrides env default", lastCall().body.model === "override-model", `got ${lastCall().body.model}`);
  check("opts.temperature overrides default", lastCall().body.temperature === 0.9, `got ${lastCall().body.temperature}`);

  resetCalls();
  const msgs: ChatMessage[] = [
    { role: "system", content: "you are terse" },
    { role: "user", content: "hello" },
  ];
  await makeLLM(jsonFetch(200, { choices: [{ message: { content: "ok" } }] })).complete(msgs);
  check("messages array forwarded verbatim", JSON.stringify(lastCall().body.messages) === JSON.stringify(msgs),
    `got ${JSON.stringify(lastCall().body.messages)}`);

  resetCalls();
  const empty = await makeLLM(jsonFetch(200, { choices: [] }))
    .complete([{ role: "user", content: "x" }]);
  check("empty choices yields empty string", empty === "", `got ${JSON.stringify(empty)}`);

  // --- complete: error paths ---
  let err = "";
  try {
    await makeLLM(jsonFetch(401, { error: { message: "bad key" } }))
      .complete([{ role: "user", content: "x" }]);
  } catch (e) { err = (e as Error).message; }
  check("complete non-200 raises with status + detail", err.includes("401") && err.includes("bad key"), err);

  err = "";
  try {
    await makeLLM(rawFetch("<html>not json</html>")).complete([{ role: "user", content: "x" }]);
  } catch (e) { err = (e as Error).message; }
  check("complete rejects on malformed JSON response", err.includes("JSON"), err);

  err = "";
  delete process.env.OPENAI_API_KEY;
  try {
    await makeLLM(jsonFetch(200, { choices: [{ message: { content: "x" } }] }))
      .complete([{ role: "user", content: "x" }]);
  } catch (e) { err = (e as Error).message; }
  process.env.OPENAI_API_KEY = "test-secret-abc";
  check("complete throws when OPENAI_API_KEY unset", err.includes("OPENAI_API_KEY"), err);

  // --- embed: request shape + dims passthrough ---
  resetCalls();
  const emb = await makeLLM(jsonFetch(200, { data: [{ embedding: [0.1, 0.2, 0.3] }] })).embed(["x"]);
  check("embed returns one vector per input", emb.length === 1 && emb[0].length === 3,
    `got ${JSON.stringify(emb)}`);
  check("embed posts to /v1/embeddings", lastCall().url === "https://api.openai.com/v1/embeddings", lastCall().url);
  check("embed body uses OPENAI_EMBEDDINGS_MODEL", lastCall().body.model === "test-embed-1", `got ${lastCall().body.model}`);
  check("embed body carries input array", Array.isArray(lastCall().body.input) && lastCall().body.input[0] === "x");

  resetCalls();
  const emb2 = await makeLLM(jsonFetch(200, { data: [{ embedding: [1, 2] }, { embedding: [3, 4, 5, 6] }] }))
    .embed(["a", "b"]);
  check("embed dims passthrough per result", emb2.length === 2 && emb2[0].length === 2 && emb2[1].length === 4,
    `got ${JSON.stringify(emb2.map((v) => v.length))}`);

  // --- embed: error paths ---
  err = "";
  try {
    await makeLLM(jsonFetch(429, { error: { message: "rate limited" } })).embed(["x"]);
  } catch (e) { err = (e as Error).message; }
  check("embed non-200 raises with status + detail", err.includes("429") && err.includes("rate limited"), err);

  err = "";
  delete process.env.OPENAI_API_KEY;
  try {
    await makeLLM(jsonFetch(200, { data: [{ embedding: [] }] })).embed(["x"]);
  } catch (e) { err = (e as Error).message; }
  process.env.OPENAI_API_KEY = "test-secret-abc";
  check("embed throws when OPENAI_API_KEY unset", err.includes("OPENAI_API_KEY"), err);

  // --- default singleton: fails loudly before any network when key missing ---
  err = "";
  delete process.env.OPENAI_API_KEY;
  try {
    await llm.complete([{ role: "user", content: "x" }]);
  } catch (e) { err = (e as Error).message; }
  process.env.OPENAI_API_KEY = "test-secret-abc";
  check("default llm instance throws clearly when key unset", err.includes("OPENAI_API_KEY"), err);
} finally {
  process.env.OPENAI_API_KEY = savedEnv.api;
  process.env.OPENAI_MODEL = savedEnv.model;
  process.env.OPENAI_EMBEDDINGS_MODEL = savedEnv.embed;
}

if (failures > 0) { console.error(`${failures} FAIL`); process.exit(1); }
console.log("LLM SUITE PASS");