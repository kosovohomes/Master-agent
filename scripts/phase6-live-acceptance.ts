/**
 * Phase 6 LIVE ACCEPTANCE against production (https://masteragent-nine.vercel.app).
 * Owner-session driven: login → create connector → grant → signed deliveries
 * (heartbeat + content.sync) → tamper 401 → replay 409 → flag rollback drill →
 * regressions. Secrets are read from env, never printed.
 */
const BASE = "https://masteragent-nine.vercel.app";
const ADMIN_PASSWORD = process.env.OWNER_PASSWORD as string;
const EMAILS = [process.env.OWNER_EMAIL ?? "wakeelypro@gmail.com"];

let failures = 0;
function check(name: string, cond: boolean, detail = "") {
  console.log(`${cond ? "PASS" : "FAIL"} ${name}${detail ? " :: " + detail : ""}`);
  if (!cond) failures++;
}
import crypto from "node:crypto";

async function login(): Promise<string | null> {
  for (const email of EMAILS) {
    const res = await fetch(`${BASE}/api/auth/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email, password: ADMIN_PASSWORD }),
    });
    if (res.ok) {
      const cookie = (res.headers.get("set-cookie") ?? "").split(";")[0];
      console.log(`logged in as ${email}`);
      return cookie;
    }
  }
  return null;
}

function sign(secret: string, body: string): string {
  const t = Math.floor(Date.now() / 1000);
  const sig = crypto.createHmac("sha256", secret).update(`${t}.${body}`).digest("hex");
  return `t=${t},v1=${sig}`;
}

async function deliver(siteId: number, secret: string, body: string, deliveryId: string, tamper = false): Promise<Response> {
  return fetch(`${BASE}/api/integrations/${siteId}/events`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-AgentOS-Signature": sign(secret, body) + (tamper ? "00" : ""),
      "X-AgentOS-Delivery": deliveryId,
    },
    body,
  });
}

async function main() {
  const cookie = await login();
  check("owner login", cookie != null);
  if (!cookie) process.exit(1);
  const auth = { Cookie: cookie };

  // websites
  const wr = await fetch(`${BASE}/api/admin/websites`, { headers: auth });
  const wj = await wr.json() as { data?: { id: number; name: string; domain: string | null; status: string }[] };
  const sites = (wj.data ?? []).filter((s) => s.status === "active");
  check("websites visible", sites.length > 0, JSON.stringify(sites.map((s) => ({ id: s.id, name: s.name }))));
  const site = sites[0];

  // create connector
  const cr = await fetch(`${BASE}/api/admin/connectors`, {
    method: "POST", headers: { ...auth, "Content-Type": "application/json" },
    body: JSON.stringify({ websiteId: site.id, displayName: "Phase 6 live acceptance webhook" }),
  });
  const cj = await cr.json() as { data?: { connector: { id: number }; signingSecret: string }; errors?: { code?: string; detail?: string }[] };
  let secret = cj.data?.signingSecret ?? "";
  if (cr.status === 400 && cj.errors?.[0]?.code === "CONNECTOR_EXISTS") {
    console.log("connector already exists — rotating to obtain a fresh secret");
    const list = await (await fetch(`${BASE}/api/admin/connectors`, { headers: auth })).json() as { data?: { connectors: { id: number; websiteId: number }[] } };
    const existing = (list.data?.connectors ?? []).find((c) => c.websiteId === site.id)!;
    const rot = await fetch(`${BASE}/api/admin/connectors/${existing.id}`, { method: "POST", headers: auth });
    const rotj = await rot.json() as { data?: { signingSecret: string } };
    secret = rotj.data?.signingSecret ?? "";
    check("rotate for live run", secret !== "");
    var connectorId = existing.id;
  } else {
    check("connector created (secret shown once)", cr.status === 201 && secret.length >= 40, `status=${cr.status}`);
    var connectorId = cj.data!.connector.id;
  }
  console.log(`connector #${connectorId} on website #${site.id} (${site.name})`);

  // grant READ_CONTENT
  const gr = await fetch(`${BASE}/api/admin/connectors/${connectorId}/capabilities`, {
    method: "PUT", headers: { ...auth, "Content-Type": "application/json" },
    body: JSON.stringify({ capability: "READ_CONTENT", enabled: true }),
  });
  check("READ_CONTENT granted", gr.status === 200);

  // heartbeat (no capability required)
  const hbBody = JSON.stringify({ type: "heartbeat", sentAt: new Date().toISOString() });
  const hb = await deliver(site.id, secret, hbBody, `live-hb-${Date.now()}`);
  const hbj = await hb.json() as any;
  check("signed heartbeat → 202 heartbeat", hb.status === 202 && hbj.data?.action === "heartbeat", JSON.stringify(hbj).slice(0, 120));

  // content.sync (the Phase 5 machinery handoff)
  const sitemapUrl = site.domain ? `https://${site.domain}/sitemap.xml` : `https://live-acceptance-${Date.now()}.example/sitemap.xml`;
  const syncBody = JSON.stringify({ type: "content.sync", data: { sitemapUrl } });
  const dlv = `live-sync-${Date.now()}`;
  const sync = await deliver(site.id, secret, syncBody, dlv);
  const sj = await sync.json() as any;
  check("signed content.sync → 202 with task", sync.status === 202 && sj.data?.action === "sync" && typeof sj.data?.taskId === "number", JSON.stringify(sj).slice(0, 160));
  console.log(`sync sourceIds=${JSON.stringify(sj.data?.sourceIds)} taskId=${sj.data?.taskId} sitemap=${sitemapUrl}`);

  // tamper → 401
  const tam = await deliver(site.id, secret, syncBody, `live-tamper-${Date.now()}`, true);
  check("tampered delivery → 401", tam.status === 401, `status=${tam.status}`);

  // replay → 409
  const rep = await deliver(site.id, secret, syncBody, dlv);
  check("replayed delivery → 409 DELIVERY_REPLAY", rep.status === 409 && (await rep.json()).errors?.[0]?.code === "DELIVERY_REPLAY");

  // delivery receipt visible
  const dr = await fetch(`${BASE}/api/admin/connectors/${connectorId}/deliveries?limit=10`, { headers: auth });
  const dj = await dr.json() as { data?: { deliveries: { deliveryId: string; status: string; signatureValid: boolean; taskId: number | null }[] } };
  const accepted = (dj.data?.deliveries ?? []).find((d) => d.deliveryId === dlv);
  check("receipt log: accepted row with task link", accepted?.status === "accepted" && accepted?.signatureValid === true && accepted?.taskId != null, JSON.stringify(accepted));

  // flag rollback drill
  const off = await fetch(`${BASE}/api/admin/settings`, {
    method: "PUT", headers: { ...auth, "Content-Type": "application/json" },
    body: JSON.stringify({ flags: [{ key: "connectors", enabled: false }] }),
  });
  check("flag OFF persisted", off.status === 200);
  const offRes = await deliver(site.id, secret, hbBody, `live-off-${Date.now()}`);
  check("flag OFF → endpoint 404", offRes.status === 404);
  await fetch(`${BASE}/api/admin/settings`, {
    method: "PUT", headers: { ...auth, "Content-Type": "application/json" },
    body: JSON.stringify({ flags: [{ key: "connectors", enabled: true }] }),
  });
  const onRes = await deliver(site.id, secret, hbBody, `live-on-${Date.now()}`);
  check("flag ON → endpoint restored (202)", onRes.status === 202);

  // audit: connector.create present, secret absent
  const ar = await fetch(`${BASE}/api/admin/audit?action=connector.create&limit=5`, { headers: auth });
  const aj = await ar.json() as { data?: { entries?: { action: string; metadata: Record<string, unknown> }[] } };
  const auditText = JSON.stringify(aj.data ?? {});
  check("audit: connector.create recorded, secret never logged", auditText.includes("connector.create") && !auditText.includes(secret));

  // regressions
  for (const path of ["/", "/login"]) {
    const res = await fetch(`${BASE}${path}`);
    check(`regression GET ${path} → 200`, res.status === 200, `status=${res.status}`);
  }
  for (const path of ["/dashboard", "/connectors", "/knowledge", "/gateway", "/operations"]) {
    const res = await fetch(`${BASE}${path}`, { headers: auth, redirect: "manual" });
    check(`regression GET ${path} → 200`, res.status === 200, `status=${res.status}`);
  }

  console.log(failures === 0 ? "LIVE ACCEPTANCE: ALL PASS" : `LIVE ACCEPTANCE: ${failures} FAIL`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => { console.error(e); process.exit(1); });
