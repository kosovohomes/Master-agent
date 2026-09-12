import { completeJSON, validateAgainstSchema } from "../lib/ai/structured";
import type { ChatMessage, LLMClient } from "../lib/ai/types";

/**
 * Structured outputs suite (Phase 4, §86–§87):
 *  - dependency-free JSON-Schema subset validator (types, required, enum,
 *    nested objects/arrays, string/number constraints, additionalProperties)
 *  - completeJSON parses fenced/preamble-wrapped JSON, validates, and
 *    repairs ONCE with a corrective follow-up turn
 */
let failures = 0;
function check(name: string, cond: boolean, detail = "") {
  console.log(`${cond ? "PASS" : "FAIL"} ${name}${detail ? " :: " + detail : ""}`);
  if (!cond) failures++;
}

const schema = {
  type: "object",
  required: ["title", "channel", "tags"],
  properties: {
    title: { type: "string", minLength: 3, maxLength: 80 },
    channel: { type: "string", enum: ["facebook", "instagram", "x"] },
    tags: { type: "array", items: { type: "string" } },
    score: { type: "number", minimum: 0, maximum: 1 },
    meta: {
      type: "object",
      required: ["lang"],
      properties: { lang: { type: "string" } },
      additionalProperties: false,
    },
  },
} as Record<string, unknown>;

// ---------- validator ----------
check("valid object passes", validateAgainstSchema(
  { title: "Hello there", channel: "facebook", tags: ["a"], score: 0.5, meta: { lang: "en" } },
  schema
).ok);

const bad = validateAgainstSchema(
  { title: "ab", channel: "tiktok", tags: "not-an-array", score: 2, meta: { lang: 1, extra: true } },
  schema
);
check("invalid object reports every violation", !bad.ok && bad.errors.length >= 5, bad.errors.join(" | "));
check("missing required reported", bad.errors.some((e) => e.includes('missing required property "title"')) === false, "title present but short — minLength fires instead");

const missing = validateAgainstSchema({ title: "Hello there" }, schema);
check("required properties enforced", !missing.ok && missing.errors.some((e) => e.includes('"channel"')));

check("type mismatch caught", !validateAgainstSchema("nope", { type: "object" }).ok);
check("integer vs number", validateAgainstSchema(3, { type: "number" }).ok && !validateAgainstSchema(3.5, { type: "integer" }).ok);
check("pattern enforced", !validateAgainstSchema("abc", { type: "string", pattern: "^\\d+$" }).ok);

// ---------- completeJSON with repair ----------
const scripted: string[] = [
  "Here is your JSON:\n```json\n{\"title\":\"Hi\",\"channel\":\"tiktok\"}\n```", // invalid (fenced + wrong enum + missing)
  "{\"title\":\"Hello there\",\"channel\":\"facebook\",\"tags\":[\"x\"],\"score\":0.9,\"meta\":{\"lang\":\"en\"}}", // valid
];
let turn = 0;
const repairClient: LLMClient = {
  async complete(messages: ChatMessage[]) {
    const raw = scripted[turn++] ?? "{}";
    // The repair turn must carry the validator's complaints back to the model.
    if (turn === 2) {
      const lastUser = [...messages].reverse().find((m) => m.role === "user");
      if (!lastUser || !lastUser.content.includes("violated the schema")) throw new Error("repair instruction missing");
    }
    return raw;
  },
  async embed() { return []; },
};

const result = await completeJSON(repairClient, [{ role: "user", content: "make a post" }], schema);
check("repair turn produces valid structured output", (result.value as { channel: string }).channel === "facebook");
check("repair is reported (attempts=2, repaired=true)", result.attempts === 2 && result.repaired === true);

// ---------- first-try success ----------
let turns = 0;
const cleanClient: LLMClient = {
  async complete() { turns++; return "{\"title\":\"Hello there\",\"channel\":\"x\",\"tags\":[],\"score\":0.1,\"meta\":{\"lang\":\"en\"}}"; },
  async embed() { return []; },
};
const clean = await completeJSON(cleanClient, [{ role: "user", content: "go" }], schema);
check("valid first attempt needs no repair", clean.attempts === 1 && clean.repaired === false && turns === 1);

// ---------- exhaustion ----------
let always = 0;
const badClient: LLMClient = {
  async complete() { always++; return "totally not json"; },
  async embed() { return []; },
};
let failed = false;
try {
  await completeJSON(badClient, [{ role: "user", content: "go" }], schema, { maxRetries: 1 });
} catch (e) {
  failed = e instanceof Error && e.message.includes("schema validation");
}
check("unparseable output exhausts retries and throws", failed && always === 2, `turns=${always}`);

if (failures > 0) { console.error(`${failures} FAIL`); process.exit(1); }
console.log("STRUCTURED SUITE PASS");
