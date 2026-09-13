export {};
/**
 * Phase 9 LIVE ACCEPTANCE against production (https://masteragent-nine.vercel.app).
 * Owner-session driven: login → unauthenticated 401 → surface + flag state →
 * spawn seo_scan (durable task) → engine tick processes it → keywords stored
 * (harvested from research/competitor material) → recommendations stored with
 * MANDATORY evidence → approval flags (approve → done; dismiss terminal) →
 * illegal transition rejected → flag drill (OFF → handler skips; ON) → audit
 * hygiene → screen sweep. Secrets are read from env, never printed.
 */
const P9_BASE = "https://masteragent-nine.vercel.app";
const P9_PASSWORD = process.env.OWNER_PASSWORD as string;
const P9_EMAIL = process.env.OWNER_EMAIL ?? "wakeelypro@gmail.com";

let p9Failures = 0;
function ok9(name: string, cond: boolean, detail = "") {
  console.log(`${cond ? "PASS" : "FAIL"} ${name}${detail ? " :: " + detail : ""}`);
  if (!cond) p9Failures++;
}

async function p9Login(): Promise<string | null> {
  const res = await fetch(`${P9_BASE}/api/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email: P9_EMAIL, password: P9_PASSWORD }),
  });
  if (!res.ok) return null;
  return (res.headers.get("set-cookie") ?? "").split(";")[0];
}

async function p9Fetch(auth: Record<string, string>, path: string, init?: RequestInit): Promise<{ status: number; body: any }> {
  const res = await fetch(`${P9_BASE}${path}`, { ...init, headers: { ...auth, ...(init?.headers ?? {}) } });
  let body: any = null;
  try { body = await res.json(); } catch { /* non-JSON */ }
  return { status: res.status, body };
}

async function p9Tick(cronSecret: string): Promise<void> {
  await fetch(`${P9_BASE}/api/agents/engine/tick`, { headers: { "x-cron-secret": cronSecret }, method: "POST" }).catch(() => null);
}

const P9_CREATED = { keywordIds: [] as number[], recIds: [] as number[] };

async function p9Main() {
  const cronSecret = process.env.CRON_SECRET as string;
  const cookie = await p9Login();
  ok9("owner login", cookie != null);
  if (!cookie) process.exit(1);
  const auth = { cookie };

  // ---------- 1. fail-closed + surface ----------
  const anon = await fetch(`${P9_BASE}/api/admin/seo`, { redirect: "manual" });
  ok9("unauthenticated GET /api/admin/seo → 401", anon.status === 401, `status=${anon.status}`);

  const g0 = await p9Fetch(auth, "/api/admin/seo");
  ok9("seo surface reachable (200)", g0.status === 200);
  ok9("seo flag ON", g0.body?.data?.flag === true, JSON.stringify(g0.body?.data?.flag));
  const statsBefore = g0.body?.data?.stats;
  ok9("stats shape present", typeof statsBefore?.keywordsActive === "number", JSON.stringify(statsBefore));

  // ---------- 2. spawn a scan (durable task) ----------
  const s1 = await p9Fetch(auth, "/api/admin/seo", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ businessUnitId: 1 }),
  });
  const taskId = s1.body?.data?.taskId as number | undefined;
  ok9("scan spawned as durable task", s1.status === 200 && typeof taskId === "number", JSON.stringify(s1.body?.errors ?? s1.status));

  // ---------- 3. run the engine until the scan settles ----------
  let scanSteps: string[] = [];
  let scanStatus = "";
  let scanResult: Record<string, unknown> = {};
  for (let i = 0; i < 10 && scanStatus !== "succeeded" && scanStatus !== "failed"; i++) {
    await p9Tick(cronSecret);
    await new Promise((r) => setTimeout(r, 1500));
    const t = await p9Fetch(auth, `/api/admin/tasks/${taskId}`);
    scanStatus = t.body?.data?.task?.status ?? "";
    scanSteps = (t.body?.data?.steps ?? []).map((x: any) => x.name);
    scanResult = t.body?.data?.task?.result ?? {};
  }
  ok9("scan task SUCCEEDED", scanStatus === "succeeded", `status=${scanStatus}`);
  ok9("scan steps recorded (context→keywords→analysis→recommendations)",
    ["context", "keywords", "analysis", "recommendations"].every((s) => scanSteps.includes(s)),
    scanSteps.join(","));
  const degraded = scanResult.degraded === true;
  ok9("scan mode coherent (LLM leg ran OR degraded with reason)",
    scanResult.llmAnalysis === true || (degraded && typeof scanResult.degradeReason === "string"),
    JSON.stringify({ llmAnalysis: scanResult.llmAnalysis, degraded, reason: scanResult.degradeReason }));

  // ---------- 4. artifacts: keywords + recommendations ----------
  const g1 = await p9Fetch(auth, "/api/admin/seo");
  const kws = g1.body?.data?.keywords ?? [];
  const recs = g1.body?.data?.recommendations ?? [];
  ok9("keyword store populated", kws.length > 0, `n=${kws.length}`);
  ok9("keywords carry intent + source", kws.every((k: any) => k.intent && k.source), "");
  const harvestedFromResearch = kws.some((k: any) => k.source === "research");
  ok9("research-harvested keyword present", harvestedFromResearch, "");
  ok9("recommendations recorded", recs.length > 0, `n=${recs.length}`);
  const withEvidence = recs.filter((r: any) => Array.isArray(r.evidence) && r.evidence.length > 0);
  ok9("EVERY recommendation carries evidence", recs.length > 0 && withEvidence.length === recs.length, `${withEvidence.length}/${recs.length}`);
  const evidenceWellFormed = recs.every((r: any) => r.evidence.every((e: any) => typeof e.label === "string" && e.label.trim() !== "" && typeof e.note === "string" && e.note.trim() !== ""));
  ok9("evidence entries are label+note", evidenceWellFormed, "");
  ok9("attribution: agent seo + task linked", recs.every((r: any) => r.agentSlug === "seo" && r.taskId != null), "");
  ok9("stats: evidence coverage 100%", g1.body?.data?.stats?.withEvidencePct === 100, String(g1.body?.data?.stats?.withEvidencePct));

  // ---------- 5. approval flags ----------
  const target = recs[0];
  if (!target) {
    ok9("recommendations available for review", false, "no recommendations stored — cannot exercise approval flags");
    console.log(`\nP9 SUMMARY: ${p9Failures} FAILURES (degradedMode=${degraded})`);
    process.exit(1);
  }
  const bad = await p9Fetch(auth, `/api/admin/seo/recommendations/${target.id}`, {
    method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action: "complete" }),
  });
  ok9("illegal transition open→complete rejected 400", bad.status === 400, `status=${bad.status}`);

  const ap = await p9Fetch(auth, `/api/admin/seo/recommendations/${target.id}`, {
    method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action: "approve" }),
  });
  ok9("approve: open → approved", ap.status === 200 && ap.body?.data?.recommendation?.status === "approved", JSON.stringify(ap.body?.errors ?? ""));
  ok9("approve: reviewer identity stamped", ap.body?.data?.recommendation?.reviewedBy != null && ap.body?.data?.recommendation?.reviewedAt != null, "");

  const dn = await p9Fetch(auth, `/api/admin/seo/recommendations/${target.id}`, {
    method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action: "complete" }),
  });
  ok9("complete: approved → done", dn.status === 200 && dn.body?.data?.recommendation?.status === "done", "");

  const afterDone = await p9Fetch(auth, `/api/admin/seo/recommendations/${target.id}`, {
    method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action: "approve" }),
  });
  ok9("done is terminal (re-approve 400)", afterDone.status === 400, `status=${afterDone.status}`);

  if (recs[1]) {
    const ds = await p9Fetch(auth, `/api/admin/seo/recommendations/${recs[1].id}`, {
      method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action: "dismiss" }),
    });
    ok9("dismiss: open → dismissed (terminal)", ds.status === 200 && ds.body?.data?.recommendation?.status === "dismissed", "");
    P9_CREATED.recIds.push(recs[1].id);
  }

  // ---------- 6. flag drill (rollback path) ----------
  const flagOff = await p9Fetch(auth, "/api/admin/settings", {
    method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ flags: [{ key: "seo", enabled: false }] }),
  });
  ok9("flag drill: seo → OFF", flagOff.status === 200, `status=${flagOff.status}`);

  const s2 = await p9Fetch(auth, "/api/admin/seo", {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ businessUnitId: 1 }),
  });
  const taskId2 = s2.body?.data?.taskId as number | undefined;
  let skipReason = "";
  if (taskId2) {
    for (let i = 0; i < 8; i++) {
      await p9Tick(cronSecret);
      await new Promise((r) => setTimeout(r, 1500));
      const t = await p9Fetch(auth, `/api/admin/tasks/${taskId2}`);
      const st = t.body?.data?.task?.status ?? "";
      const res = t.body?.data?.task?.result ?? {};
      if (st === "succeeded" || st === "failed") { skipReason = JSON.stringify(res); break; }
    }
  }
  ok9("flag OFF: scan task skips fail-closed (seo_flag_off)", skipReason.includes("seo_flag_off"), skipReason.slice(0, 120));

  const flagOn = await p9Fetch(auth, "/api/admin/settings", {
    method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ flags: [{ key: "seo", enabled: true }] }),
  });
  ok9("flag drill: seo → ON restored", flagOn.status === 200, `status=${flagOn.status}`);

  // ---------- 7. audit hygiene ----------
  const aud = await p9Fetch(auth, "/api/admin/audit?limit=40");
  const actions = (aud.body?.data ?? []).map((x: any) => x.action ?? "");
  const wanted = ["seo.scan.spawn", "seo.recommendation.approve", "seo.recommendation.complete", "seo.recommendation.dismiss"];
  const found = wanted.filter((w) => actions.some((a: string) => a === w));
  ok9("audit rows for scan + decisions", found.length >= 3, `found=${found.join(",")}`);
  const auditBlob = JSON.stringify(aud.body);
  ok9("audit hygiene: no secrets in audit rows",
    !auditBlob.includes(P9_PASSWORD) && !/Bearer [A-Za-z0-9_-]{20,}/.test(auditBlob), "");

  // ---------- 8. screen sweep ----------
  for (const path of ["/seo", "/operations", "/research", "/content", "/gateway", "/dashboard"]) {
    const r = await fetch(`${P9_BASE}${path}`, { headers: auth, redirect: "manual" });
    ok9(`screen ${path} → 200`, r.status === 200, `status=${r.status}`);
  }

  // ---------- 9. regression: widget + legacy ----------
  const widget = await fetch(`${P9_BASE}/api/v1/widget/config?tenant=acme-homes`);
  ok9("widget regression: config 200", widget.status === 200, `status=${widget.status}`);

  console.log(`\nP9 SUMMARY: ${p9Failures === 0 ? "ALL PASS" : p9Failures + " FAILURES"} (degradedMode=${degraded})`);
  process.exit(p9Failures === 0 ? 0 : 1);
}

void p9Main().catch((e) => { console.error("FATAL", e); process.exit(1); });
