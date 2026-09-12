/**
 * Structured outputs + validation (Phase 4, §86–§87 — pulled-forward seam).
 *
 * A dependency-free JSON-Schema subset validator (type/object/properties/
 * required/enum/items/string constraints) plus `completeJSON`, which asks
 * the model for JSON, parses, validates, and retries ONCE with a repair
 * instruction on failure. Phase 6 contract consumers build on this seam.
 */
import type { ChatMessage, LLMClient } from "./types";

export interface SchemaValidationResult {
  ok: boolean;
  errors: string[];
}

const TYPES = ["string", "number", "integer", "boolean", "object", "array", "null"];

function typeOf(v: unknown): string {
  if (v === null) return "null";
  if (Array.isArray(v)) return "array";
  if (typeof v === "number") return Number.isInteger(v) ? "integer" : "number";
  return typeof v;
}

export function validateAgainstSchema(
  value: unknown,
  schema: Record<string, unknown>,
  path = "$"
): SchemaValidationResult {
  const errors: string[] = [];

  const expected = schema.type;
  if (typeof expected === "string") {
    const t = typeOf(value);
    if (expected === "number" ? !["number", "integer"].includes(t) : t !== expected) {
      errors.push(`${path}: expected ${expected}, got ${t}`);
      return { ok: false, errors };
    }
  } else if (Array.isArray(expected)) {
    const t = typeOf(value);
    const okOne = expected.some((e) => (e === "number" ? ["number", "integer"].includes(t) : t === e));
    if (!okOne) {
      errors.push(`${path}: expected one of [${expected.join(", ")}], got ${t}`);
      return { ok: false, errors };
    }
  }

  if (Array.isArray(schema.enum) && !schema.enum.includes(value)) {
    errors.push(`${path}: value not in enum [${schema.enum.map(String).join(", ")}]`);
  }

  if (typeof value === "string") {
    if (typeof schema.minLength === "number" && value.length < schema.minLength)
      errors.push(`${path}: shorter than minLength ${schema.minLength}`);
    if (typeof schema.maxLength === "number" && value.length > schema.maxLength)
      errors.push(`${path}: longer than maxLength ${schema.maxLength}`);
    if (typeof schema.pattern === "string" && !new RegExp(schema.pattern).test(value))
      errors.push(`${path}: does not match pattern ${schema.pattern}`);
  }
  if ((typeof value === "number" || typeOf(value) === "integer") && typeof value === "number") {
    if (typeof schema.minimum === "number" && value < schema.minimum)
      errors.push(`${path}: below minimum ${schema.minimum}`);
    if (typeof schema.maximum === "number" && value > schema.maximum)
      errors.push(`${path}: above maximum ${schema.maximum}`);
  }

  if (Array.isArray(value) && schema.items && typeof schema.items === "object") {
    value.forEach((item, i) => {
      const sub = validateAgainstSchema(item, schema.items as Record<string, unknown>, `${path}[${i}]`);
      errors.push(...sub.errors);
    });
  }

  if (value !== null && typeof value === "object" && !Array.isArray(value)) {
    const props = (schema.properties ?? {}) as Record<string, Record<string, unknown>>;
    const required = Array.isArray(schema.required) ? (schema.required as string[]) : [];
    for (const key of required) {
      if (!(key in value)) errors.push(`${path}: missing required property "${key}"`);
    }
    const additional = schema.additionalProperties;
    for (const [k, v] of Object.entries(value)) {
      if (props[k]) {
        errors.push(...validateAgainstSchema(v, props[k], `${path}.${k}`).errors);
      } else if (additional === false) {
        errors.push(`${path}: additional property "${k}" not allowed`);
      }
    }
  }

  return { ok: errors.length === 0, errors };
}

function extractJson(text: string): unknown {
  const trimmed = text.trim();
  // Tolerate fences and preambles: find the outermost JSON object/array.
  const candidates = [trimmed];
  const fence = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fence) candidates.unshift(fence[1]);
  const firstBrace = trimmed.search(/[{[]/);
  if (firstBrace > 0) candidates.push(trimmed.slice(firstBrace));
  for (const c of candidates) {
    try {
      return JSON.parse(c);
    } catch {
      /* try next */
    }
  }
  throw new Error("model output is not parseable JSON");
}

export interface CompleteJsonOptions {
  model?: string;
  temperature?: number;
  maxRetries?: number; // repair attempts on invalid output (default 1)
}

/** Result carries validation metadata so callers can audit model compliance. */
export interface CompleteJsonResult<T = unknown> {
  value: T;
  raw: string;
  attempts: number;
  repaired: boolean;
}

export async function completeJSON<T = unknown>(
  client: LLMClient,
  messages: ChatMessage[],
  schema: Record<string, unknown>,
  opts: CompleteJsonOptions = {}
): Promise<CompleteJsonResult<T>> {
  const maxRetries = opts.maxRetries ?? 1;
  const schemaHint = `You MUST answer with a single JSON value only (no prose, no markdown fences) conforming to this JSON Schema: ${JSON.stringify(schema)}`;
  const chat: ChatMessage[] = [{ role: "system", content: schemaHint }, ...messages];

  let lastRaw = "";
  let lastErrors: string[] = [];
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    let value: unknown;
    let raw = "";
    try {
      raw = await client.complete(chat, { model: opts.model, temperature: opts.temperature ?? 0 });
      lastRaw = raw;
      value = extractJson(raw);
    } catch (e) {
      lastErrors = [e instanceof Error ? e.message : String(e)];
      if (attempt === maxRetries) break;
      chat.push({ role: "assistant", content: lastRaw || "(unparseable output)" });
      chat.push({
        role: "user",
        content: `Your previous answer was not parseable JSON (${lastErrors[0]}). Answer again with a single JSON value conforming to the schema. No other text.`,
      });
      continue;
    }
    const check = validateAgainstSchema(value, schema);
    if (check.ok) return { value: value as T, raw, attempts: attempt + 1, repaired: attempt > 0 };
    lastErrors = check.errors;
    if (attempt === maxRetries) break;
    chat.push({ role: "assistant", content: raw });
    chat.push({
      role: "user",
      content: `Your JSON violated the schema: ${check.errors.join("; ")}. Return corrected JSON only, conforming to the schema.`,
    });
  }
  throw new Error(`structured output failed schema validation after ${maxRetries + 1} attempt(s): ${lastErrors.join("; ")}`);
}
