/**
 * Connector webhook signing (Phase 6 — SEC-L4 / §77: signature, timestamp,
 * replay, rotation).
 *
 * Wire format (Stripe-style, verified against the RAW request body):
 *   X-AgentOS-Signature: t=<unix_seconds>,v1=<hmac_sha256_hex>
 *   X-AgentOS-Delivery:  <opaque sender-chosen delivery id>
 * signed payload  = HMAC_SHA256(secret, `${t}.${rawBody}`)
 *
 * Guarantees:
 *  - constant-time comparison (crypto.timingSafeEqual) — no string compare
 *    of secrets anywhere on the verification path;
 *  - timestamp tolerance window (default 5 minutes) bounds the replay horizon
 *    on top of the DB delivery-id replay cache;
 *  - rotation with zero downtime: verification tries the CURRENT secret
 *    first, then the PREVIOUS secret while it is inside the rotation window
 *    (default 24h from rotated_at). Rotation invalidates the old secret the
 *    moment the window passes, so a leaked previous secret ages out.
 */
import crypto from "node:crypto";
import type { SignatureHeader, SignatureVerifyResult } from "./types";

export const SIGNATURE_MAX_AGE_SEC = 300; // 5-minute timestamp tolerance
export const ROTATION_WINDOW_HOURS = 24; // previous secret stays valid this long

/** 32-byte url-safe random signing secret (per connector, shown ONCE). */
export function generateSigningSecret(): string {
  return crypto.randomBytes(32).toString("base64url");
}

export function signPayload(secret: string, timestampSec: number, rawBody: string): string {
  return crypto.createHmac("sha256", secret).update(`${timestampSec}.${rawBody}`).digest("hex");
}

/** Build a ready-to-send signature header (used by tests + the send-sample helper). */
export function buildSignatureHeader(secret: string, rawBody: string, timestampSec?: number): string {
  const t = timestampSec ?? Math.floor(Date.now() / 1000);
  return `t=${t},v1=${signPayload(secret, t, rawBody)}`;
}

export function parseSignatureHeader(header: string | null | undefined): SignatureHeader | null {
  if (!header) return null;
  const parts = header.split(",").map((p) => p.trim());
  let timestamp: number | null = null;
  let signature: string | null = null;
  for (const part of parts) {
    const eq = part.indexOf("=");
    if (eq <= 0) continue;
    const key = part.slice(0, eq);
    const value = part.slice(eq + 1);
    if (key === "t") {
      if (!/^\d+$/.test(value)) return null;
      timestamp = Number(value);
    } else if (key === "v1") {
      if (!/^[0-9a-f]{64}$/.test(value)) return null;
      signature = value;
    }
  }
  if (timestamp == null || signature == null) return null;
  return { timestamp, signature };
}

function timingSafeEqualHex(a: string, b: string): boolean {
  const ab = Buffer.from(a, "hex");
  const bb = Buffer.from(b, "hex");
  if (ab.length !== bb.length) return false;
  return crypto.timingSafeEqual(ab, bb);
}

/**
 * Verify a signed webhook against one or more secrets (current first, then
 * the rotation-window previous secret). `nowMs` injectable for tests.
 */
export function verifySignedPayload(opts: {
  secrets: { secret: string; isPrevious?: boolean; rotatedAt?: string | null }[];
  header: string | null | undefined;
  rawBody: string;
  nowMs?: number;
  maxAgeSec?: number;
}): SignatureVerifyResult {
  const nowMs = opts.nowMs ?? Date.now();
  const maxAgeSec = opts.maxAgeSec ?? SIGNATURE_MAX_AGE_SEC;

  const parsed = parseSignatureHeader(opts.header);
  if (!parsed) return { ok: false, reason: "malformed_header" };

  const ageSec = Math.abs(nowMs / 1000 - parsed.timestamp);
  if (!Number.isFinite(ageSec) || ageSec > maxAgeSec) {
    return { ok: false, reason: "stale_timestamp" };
  }

  for (const entry of opts.secrets) {
    if (entry.isPrevious) {
      // Rotation window: a previous secret only verifies while fresh.
      if (!entry.rotatedAt) continue;
      const rotatedMs = new Date(entry.rotatedAt).getTime();
      if (!Number.isFinite(rotatedMs)) continue;
      if (nowMs - rotatedMs > ROTATION_WINDOW_HOURS * 3600 * 1000) continue;
    }
    const expected = signPayload(entry.secret, parsed.timestamp, opts.rawBody);
    if (timingSafeEqualHex(expected, parsed.signature)) return { ok: true };
  }
  return { ok: false, reason: "invalid_signature" };
}
