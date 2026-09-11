import crypto from "node:crypto";

/**
 * Channel-token encryption (AES-256-GCM), Phase 2 SEC-L2: key-id envelope.
 *
 * Wire formats:
 *   v1 (legacy, still decryptable):  iv:tag:data                       (hex)
 *   v2 (current):                    v2:<key_id>:iv:tag:data           (hex)
 *
 * v2 adds a key id so credentials can be ROTATED without downtime: encrypt
 * always uses the current key; decrypt resolves the id against the configured
 * key set (current + optional previous). A key id of "-" means the caller
 * supplied the key directly (used by tests and in-process callers) and the
 * key argument/env key is used as-is.
 *
 * Env:
 *   CHANNEL_ENC_KEY              current 32-byte hex key (required)
 *   CHANNEL_ENC_KEY_ID           id of the current key  (default "k1")
 *   CHANNEL_ENC_KEY_PREVIOUS     previous key during a rotation window (optional)
 *   CHANNEL_ENC_KEY_PREVIOUS_ID  id of the previous key (default "k0")
 */

export const V1_PREFIX_LENGTH = 0; // legacy payloads carry no prefix marker

function hexToKey(hex: string | undefined, label: string): Buffer {
  if (!hex) throw new Error(`${label} must be set`);
  const key = Buffer.from(hex, "hex");
  if (key.length !== 32) throw new Error(`${label} must be a 32-byte hex string`);
  return key;
}

/** Current encryption key + its id. */
function currentKey(): { key: Buffer; id: string } {
  return {
    key: hexToKey(process.env.CHANNEL_ENC_KEY, "CHANNEL_ENC_KEY"),
    id: process.env.CHANNEL_ENC_KEY_ID || "k1",
  };
}

/** Resolve a v2 key id to its key material (current → previous → fail). */
function keyForId(keyId: string, explicit?: Buffer): Buffer {
  if (keyId === "-") {
    return explicit ?? currentKey().key;
  }
  const cur = currentKey();
  if (keyId === cur.id) return cur.key;
  const prevHex = process.env.CHANNEL_ENC_KEY_PREVIOUS;
  if (prevHex && keyId === (process.env.CHANNEL_ENC_KEY_PREVIOUS_ID || "k0")) {
    return hexToKey(prevHex, "CHANNEL_ENC_KEY_PREVIOUS");
  }
  throw new Error(`unknown encryption key id: ${keyId}`);
}

export function encryptChannelToken(plaintext: string, key: Buffer = currentKey().key): string {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
  const enc = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  // Caller-supplied keys are marked "-" (no env id); env-key encryption
  // stamps the current key id so future rotation can resolve old payloads.
  const isEnvKey = key.toString("hex") === currentKey().key.toString("hex");
  const keyId = isEnvKey ? currentKey().id : "-";
  return `v2:${keyId}:${iv.toString("hex")}:${tag.toString("hex")}:${enc.toString("hex")}`;
}

export function decryptChannelToken(payload: string, key: Buffer = currentKey().key): string {
  if (payload.startsWith("v2:")) {
    const parts = payload.split(":");
    if (parts.length !== 5) throw new Error("malformed v2 encrypted payload");
    const [, keyId, ivHex, tagHex, dataHex] = parts;
    const decipher = crypto.createDecipheriv("aes-256-gcm", keyForId(keyId, key), Buffer.from(ivHex, "hex"));
    decipher.setAuthTag(Buffer.from(tagHex, "hex"));
    return Buffer.concat([decipher.update(Buffer.from(dataHex, "hex")), decipher.final()]).toString("utf8");
  }
  // Legacy v1 envelope: iv:tag:data under the provided/current key.
  const [ivHex, tagHex, dataHex] = payload.split(":");
  if (!ivHex || !tagHex || !dataHex) throw new Error("malformed encrypted payload");
  const decipher = crypto.createDecipheriv("aes-256-gcm", key, Buffer.from(ivHex, "hex"));
  decipher.setAuthTag(Buffer.from(tagHex, "hex"));
  return Buffer.concat([decipher.update(Buffer.from(dataHex, "hex")), decipher.final()]).toString("utf8");
}
