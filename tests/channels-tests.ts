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
check("output is hex-encoded iv:tag:cipher", /^[0-9a-f]+:[0-9a-f]+:[0-9a-f]+$/.test(c1), c1);
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
check("uses CHANNEL_ENC_KEY from env", decryptChannelToken(keyFromEnv) === "abc");

const savedEnvKey = process.env.CHANNEL_ENC_KEY;
delete process.env.CHANNEL_ENC_KEY;
let envErr = "";
try { encryptChannelToken("abc"); } catch (e) { envErr = (e as Error).message; }
process.env.CHANNEL_ENC_KEY = savedEnvKey;
check("missing CHANNEL_ENC_KEY throws clear error at call time", envErr.includes("CHANNEL_ENC_KEY"), envErr);

if (failures > 0) { console.error(`${failures} FAIL`); process.exit(1); }
console.log("CHANNELS SUITE PASS");