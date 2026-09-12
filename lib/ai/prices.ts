/**
 * Model price table + cost computation (Phase 4, §24/§26).
 *
 * `model_prices` is the operator-editable source of truth: gateway rows
 * carrying tokens are priced through this table, so cost math is data, not
 * code. Unknown models price at $0 with an `unpriced_model` flag in the
 * ledger row's metadata — never silently mis-costed, never blocked.
 */
import { query } from "../db";

export interface ModelPrice {
  provider: string;
  model: string;
  kind: "chat" | "embed";
  inputPer1kUsd: number;
  outputPer1kUsd: number | null;
}

interface CacheEntry {
  at: number;
  rows: Map<string, ModelPrice>;
}

const CACHE_TTL_MS = 60_000;
let cache: CacheEntry | null = null;

function key(provider: string, model: string, kind: string): string {
  return `${provider}:${model}:${kind}`;
}

export function invalidatePriceCache(): void {
  cache = null;
}

export async function priceFor(provider: string, model: string, kind: "chat" | "embed"): Promise<ModelPrice | null> {
  if (!cache || Date.now() - cache.at > CACHE_TTL_MS) {
    const rows = await query<{
      provider: string;
      model: string;
      kind: string;
      input_per_1k_usd: string;
      output_per_1k_usd: string | null;
    }>("SELECT provider, model, kind, input_per_1k_usd, output_per_1k_usd FROM model_prices");
    const map = new Map<string, ModelPrice>();
    for (const r of rows) {
      map.set(key(r.provider, r.model, r.kind), {
        provider: r.provider,
        model: r.model,
        kind: r.kind as "chat" | "embed",
        inputPer1kUsd: Number(r.input_per_1k_usd),
        outputPer1kUsd: r.output_per_1k_usd === null ? null : Number(r.output_per_1k_usd),
      });
    }
    cache = { at: Date.now(), rows: map };
  }
  return cache.rows.get(key(provider, model, kind)) ?? null;
}

/**
 * Cost of one call in USD. Embed calls have no output tokens (price row's
 * output column is NULL → completion tokens priced 0).
 */
export function computeCostUsd(
  price: ModelPrice | null,
  usage: { promptTokens: number | null; completionTokens: number | null }
): number {
  if (!price) return 0;
  const input = ((usage.promptTokens ?? 0) / 1000) * price.inputPer1kUsd;
  const output =
    price.outputPer1kUsd !== null ? ((usage.completionTokens ?? 0) / 1000) * price.outputPer1kUsd : 0;
  // Round to 1e-8: NUMERIC(14,8) storage precision.
  return Math.round((input + output) * 1e8) / 1e8;
}
