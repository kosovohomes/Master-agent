import crypto from "node:crypto";
import { encryptChannelToken, decryptChannelToken } from "../lib/channels";

let failures = 0;
function check(name: string, cond: boolean, detail = "") {
  console.log(`${cond ? "PASS" : "FAIL"} ${name}${detail ? " :: " + detail : ""}`);
  if (!cond) failures++;
}

const key = Buffer.from("34c1f0a9f1cbb5f2a8d7e6b5c4d3e2f109876543210abcdef0123456789abcdef", "hex");
const c1 = encryptChannelToken("secret-token-123", key);
const c2 = encryptChannelToken("secret-token-123", key);
check("ciphertext differs per call (random IV)", c1 !== c2);
check("output is the v2 envelope v2:<key_id>:iv:tag:cipher", /^v2:-:[0-9a-f]+:[0-9a-f]+:[0-9a-f]+$/.test(c1), c1);
check("roundtrip decrypts to original", decryptChannelToken(c1, key) === "secret-token-123");

let threw = false;
try { decryptChannelToken(c1, Buffer.alloc(32, 1)); } catch { threw = true; }
check("wrong key fails (GCM auth)", threw);

const tampered = c1.slice(0, -1) + (c1.endsWith("0") ? "1" : "0");
threw = false;
try { decryptChannelToken(tampered, key); } catch { threw = true; }
check("tampered ciphertext throws (GCM auth)", threw);

threw = false;
try { decryptChannelToken("not-an-encrypted-payload", key); } catch { threw = true; }
check("malformed payload throws", threw);

const keyFromEnv = encryptChannelToken("abc");
check("env-key ciphertext stamps the current key id", keyFromEnv.startsWith("v2:k1:"), keyFromEnv.split(":").slice(0, 2).join(":"));
check("uses CHANNEL_ENC_KEY from env", decryptChannelToken(keyFromEnv) === "abc");

const savedEnvKey = process.env.CHANNEL_ENC_KEY;
delete process.env.CHANNEL_ENC_KEY;
let envErr = "";
try { encryptChannelToken("abc"); } catch (e) { envErr = (e as Error).message; }
process.env.CHANNEL_ENC_KEY = savedEnvKey;
check("missing CHANNEL_ENC_KEY throws clear error at call time", envErr.includes("CHANNEL_ENC_KEY"), envErr);

// ---------- Phase 2 SEC-L2: legacy v1 payload compatibility ----------
const iv = crypto.randomBytes(12);
const legacyCipher = crypto.createCipheriv("aes-256-gcm", key, iv);
const legacyEnc = Buffer.concat([legacyCipher.update("legacy-payload", "utf8"), legacyCipher.final()]);
const legacyTag = legacyCipher.getAuthTag();
const v1Payload = `${iv.toString("hex")}:${legacyTag.toString("hex")}:${legacyEnc.toString("hex")}`;
check("legacy v1 payloads (pre-registry rows) still decrypt",
  decryptChannelToken(v1Payload, key) === "legacy-payload");

// ---------- Phase 2 SEC-L2: key rotation without downtime ----------
const saved = {
  key: process.env.CHANNEL_ENC_KEY,
  id: process.env.CHANNEL_ENC_KEY_ID,
  prev: process.env.CHANNEL_ENC_KEY_PREVIOUS,
  prevId: process.env.CHANNEL_ENC_KEY_PREVIOUS_ID,
};
const keyA = "a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1";
const keyB = "b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2";
process.env.CHANNEL_ENC_KEY = keyA;
process.env.CHANNEL_ENC_KEY_ID = "k1";
const underK1 = encryptChannelToken("rotate-me");
process.env.CHANNEL_ENC_KEY = keyB;
process.env.CHANNEL_ENC_KEY_ID = "k2";
process.env.CHANNEL_ENC_KEY_PREVIOUS = keyA;
process.env.CHANNEL_ENC_KEY_PREVIOUS_ID = "k1";
check("old ciphertext decrypts after rotation via its key id",
  decryptChannelToken(underK1) === "rotate-me");
const underK2 = encryptChannelToken("new-key-write");
check("new ciphertexts stamp the new key id", underK2.startsWith("v2:k2:"), underK2.split(":").slice(0, 2).join(":"));
check("new ciphertext roundtrips", decryptChannelToken(underK2) === "new-key-write");
process.env.CHANNEL_ENC_KEY_PREVIOUS = "";
threw = false;
try { decryptChannelToken(underK1); } catch { threw = true; }
check("unresolvable key id fails loudly", threw);
process.env.CHANNEL_ENC_KEY = saved.key;
if (saved.id !== undefined) process.env.CHANNEL_ENC_KEY_ID = saved.id; else delete process.env.CHANNEL_ENC_KEY_ID;
if (saved.prev !== undefined) process.env.CHANNEL_ENC_KEY_PREVIOUS = saved.prev; else delete process.env.CHANNEL_ENC_KEY_PREVIOUS;
if (saved.prevId !== undefined) process.env.CHANNEL_ENC_KEY_PREVIOUS_ID = saved.prevId; else delete process.env.CHANNEL_ENC_KEY_PREVIOUS_ID;

if (failures > 0) { console.error(`${failures} FAIL`); process.exit(1); }
console.log("CHANNELS SUITE PASS");
