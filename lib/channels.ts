import crypto from "node:crypto";

function envKey(): Buffer {
  const hex = process.env.CHANNEL_ENC_KEY;
  const key = hex ? Buffer.from(hex, "hex") : Buffer.alloc(0);
  if (!hex || key.length !== 32) {
    throw new Error("CHANNEL_ENC_KEY must be a 32-byte hex string");
  }
  return key;
}

export function encryptChannelToken(plaintext: string, key: Buffer = envKey()): string {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
  const enc = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `${iv.toString("hex")}:${tag.toString("hex")}:${enc.toString("hex")}`;
}

export function decryptChannelToken(payload: string, key: Buffer = envKey()): string {
  const [ivHex, tagHex, dataHex] = payload.split(":");
  if (!ivHex || !tagHex || !dataHex) throw new Error("malformed encrypted payload");
  const decipher = crypto.createDecipheriv("aes-256-gcm", key, Buffer.from(ivHex, "hex"));
  decipher.setAuthTag(Buffer.from(tagHex, "hex"));
  return Buffer.concat([decipher.update(Buffer.from(dataHex, "hex")), decipher.final()]).toString("utf8");
}