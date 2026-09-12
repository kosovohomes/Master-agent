/**
 * Phase 6 — connector webhook signing (SEC-L4 / §77). Pure crypto suite:
 * signature roundtrip, tamper rejection, timestamp tolerance, malformed
 * headers, and the zero-downtime rotation window. No DB.
 */
import {
  generateSigningSecret,
  signPayload,
  buildSignatureHeader,
  parseSignatureHeader,
  verifySignedPayload,
  SIGNATURE_MAX_AGE_SEC,
  ROTATION_WINDOW_HOURS,
} from "../lib/connectors/crypto";

let failures = 0;
function check(name: string, cond: boolean, detail = "") {
  console.log(`${cond ? "PASS" : "FAIL"} ${name}${detail ? " :: " + detail : ""}`);
  if (!cond) failures++;
}

const BODY = JSON.stringify({ type: "content.sync", data: { sitemapUrl: "https://site.example/sitemap.xml" } });
const NOW = 1_750_000_000_000;

// ---------- secret generation ----------
{
  const a = generateSigningSecret();
  const b = generateSigningSecret();
  check("secret: 32 bytes base64url (~43 chars)", a.length >= 40 && a.length <= 44, `len=${a.length}`);
  check("secret: url-safe alphabet", /^[A-Za-z0-9_-]+$/.test(a));
  check("secret: unique per call", a !== b);
}

// ---------- sign + parse ----------
{
  const t = Math.floor(NOW / 1000);
  const sig = signPayload("secret-a", t, BODY);
  check("sign: deterministic hex sha256", sig.length === 64 && /^[0-9a-f]{64}$/.test(sig));
  check("sign: same input same output", signPayload("secret-a", t, BODY) === sig);
  check("sign: different secret different output", signPayload("secret-b", t, BODY) !== sig);
  check("sign: different body different output", signPayload("secret-a", t, BODY + " ") !== sig);

  const header = buildSignatureHeader("secret-a", BODY, t);
  check("header: wire format t=...,v1=...", header === `t=${t},v1=${sig}`, header);

  const parsed = parseSignatureHeader(header);
  check("parse: valid header", parsed?.timestamp === t && parsed?.signature === sig);
  check("parse: whitespace tolerated", parseSignatureHeader(` ${header.replace(",", " , ")} `)?.signature === sig);
  check("parse: null for missing header", parseSignatureHeader(null) === null);
  check("parse: null for empty header", parseSignatureHeader("") === null);
  check("parse: null without v1", parseSignatureHeader(`t=${t}`) === null);
  check("parse: null without t", parseSignatureHeader(`v1=${sig}`) === null);
  check("parse: null for non-numeric t", parseSignatureHeader(`t=12ab,v1=${sig}`) === null);
  check("parse: null for short v1", parseSignatureHeader(`t=${t},v1=abcd`) === null);
  check("parse: null for non-hex v1", parseSignatureHeader(`t=${t},v1=${"z".repeat(64)}`) === null);
}

// ---------- verification ----------
{
  const t = Math.floor(NOW / 1000);
  const mk = (tsSec: number, body: string) => `t=${tsSec},v1=${signPayload("secret-a", tsSec, body)}`;

  check("verify: valid roundtrip", verifySignedPayload({
    secrets: [{ secret: "secret-a" }],
    header: mk(t, BODY),
    rawBody: BODY,
    nowMs: NOW,
  }).ok === true);

  check("verify: tampered body rejected", verifySignedPayload({
    secrets: [{ secret: "secret-a" }],
    header: mk(t, BODY),
    rawBody: BODY.replace("sync", "SYNC"),
    nowMs: NOW,
  }).ok === false && (verifySignedPayload({ secrets: [{ secret: "secret-a" }], header: mk(t, BODY), rawBody: BODY + "x", nowMs: NOW }) as { reason?: string }).reason === "invalid_signature");

  check("verify: wrong secret rejected", verifySignedPayload({
    secrets: [{ secret: "secret-b" }],
    header: mk(t, BODY),
    rawBody: BODY,
    nowMs: NOW,
  }).ok === false);

  check("verify: stale timestamp (beyond window) rejected", verifySignedPayload({
    secrets: [{ secret: "secret-a" }],
    header: mk(t - SIGNATURE_MAX_AGE_SEC - 5, BODY),
    rawBody: BODY,
    nowMs: NOW,
  }).ok === false && (verifySignedPayload({ secrets: [{ secret: "secret-a" }], header: mk(t - SIGNATURE_MAX_AGE_SEC - 5, BODY), rawBody: BODY, nowMs: NOW }) as { reason?: string }).reason === "stale_timestamp");

  check("verify: future timestamp beyond window rejected", verifySignedPayload({
    secrets: [{ secret: "secret-a" }],
    header: mk(t + SIGNATURE_MAX_AGE_SEC + 5, BODY),
    rawBody: BODY,
    nowMs: NOW,
  }).ok === false);

  check("verify: within tolerance accepted (edge -)", verifySignedPayload({
    secrets: [{ secret: "secret-a" }],
    header: mk(t - SIGNATURE_MAX_AGE_SEC + 1, BODY),
    rawBody: BODY,
    nowMs: NOW,
  }).ok === true);

  check("verify: malformed header rejected", verifySignedPayload({
    secrets: [{ secret: "secret-a" }],
    header: "garbage",
    rawBody: BODY,
    nowMs: NOW,
  }).ok === false && (verifySignedPayload({ secrets: [{ secret: "secret-a" }], header: "garbage", rawBody: BODY, nowMs: NOW }) as { reason?: string }).reason === "malformed_header");
}

// ---------- rotation window ----------
{
  const t = Math.floor(NOW / 1000);
  const body = BODY;
  const current = "current-secret";
  const previous = "previous-secret";
  const rotatedAt = new Date(NOW - 3600 * 1000).toISOString(); // 1h ago

  check("rotation: current secret verifies", verifySignedPayload({
    secrets: [{ secret: current }, { secret: previous, isPrevious: true, rotatedAt }],
    header: buildSignatureHeader(current, body, t),
    rawBody: body,
    nowMs: NOW,
  }).ok === true);

  check("rotation: previous secret verifies inside window", verifySignedPayload({
    secrets: [{ secret: current }, { secret: previous, isPrevious: true, rotatedAt }],
    header: buildSignatureHeader(previous, body, t),
    rawBody: body,
    nowMs: NOW,
  }).ok === true);

  check("rotation: previous secret rejected after window", verifySignedPayload({
    secrets: [{ secret: current }, { secret: previous, isPrevious: true, rotatedAt: new Date(NOW - (ROTATION_WINDOW_HOURS + 1) * 3600 * 1000).toISOString() }],
    header: buildSignatureHeader(previous, body, t),
    rawBody: body,
    nowMs: NOW,
  }).ok === false);

  check("rotation: previous without rotatedAt skipped", verifySignedPayload({
    secrets: [{ secret: current }, { secret: previous, isPrevious: true, rotatedAt: null }],
    header: buildSignatureHeader(previous, body, t),
    rawBody: body,
    nowMs: NOW,
  }).ok === false);

  // a sender that already cut over to the new secret must never be
  // rejected because the old secret is tried second, not first
  check("rotation: order independent (previous first in list also ok)", verifySignedPayload({
    secrets: [{ secret: previous, isPrevious: true, rotatedAt }, { secret: current }],
    header: buildSignatureHeader(current, body, t),
    rawBody: body,
    nowMs: NOW,
  }).ok === true);
}

if (failures > 0) { console.error(`${failures} FAIL`); process.exit(1); }
console.log("CONNECTORS CRYPTO SUITE PASS");
