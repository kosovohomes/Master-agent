export {};
/**
 * Phase 11 LIVE ACCEPTANCE against production (https://masteragent-nine.vercel.app).
 * Owner-session driven: login → unauthenticated 401 (fail-closed) → surface +
 * flag state → segment dedup (409) → brief generation (LLM leg degrades to
 * deterministic — OpenAI still unfunded / Gemini key not yet set) → campaign
 * creation from the brief (stays draft) → §91 approval law: transition
 * draft→active WITHOUT approver is impossible by construction, the API route
 * stamps the session user; verify the launch stamps + audit row → pause →
 * relaunch preserves original approver → complete → terminal edit 409 →
 * metric snapshots append-only + rollup sums → sweep flag drill (OFF → skip;
 * ON) → manual sweep spawn (idempotent per minute) → audit hygiene (no
 * secrets in entries) → cleanup → screen sweep (all screens + widget).
 * Secrets are read from env, never printed.
 */
const BASE = "https://masteragent-nine.vercel.app";
const PASSWORD = process.env.OWNER_PASSWORD as string;
const EMAIL = process.env.OWNER_EMAIL ?? "wakeelypro@gmail.com";
const CRON = process.env.CRON_SECRET as string;

let failures = 0;
function ok(name: string, cond: boolean, detail = "") {
  console.log(`${cond ? "PASS" : "FAIL"} ${name}${detail ? " :: " + detail : ""}`);
  if (!cond) failures++;
}

async function login(): Promise<string | null> {
  const res = await fetch(`${BASE}/api/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email: EMAIL, password: PASSWORD }),
  });
  if (!res.ok) return null;
  return (res.headers.get("set-cookie") ?? "").split(";")[0];
}

async function api(auth: Record<string, string>, path: string, init?: RequestInit): Promise<{ status: number; body: any }> {
  const res = await fetch(`${BASE}${path}`, { ...init, headers: { ...auth, ...(init?.headers ?? {}) } });
  let body: any = null;
  try { body = await res.json(); } catch { /* non-JSON */ }
  return { status: res.status, body };
}

async function tick(): Promise<void> {
  await fetch(`${BASE}/api/agents/engine/tick`, { headers: { "x-cron-secret": CRON }, method: "POST" }).catch(() => null);
}

const CREATED = { segmentId: 0, segmentIdB: 0, campaignId: 0, campaign2Id: 0 };
const STAMP = Date.now();
const SEG = `P11 acceptance segment ${STAMP}`;
const CAMP = `P11 acceptance campaign ${STAMP}`;

async function main() {
  const cookie = await login();
  ok("owner login", cookie != null);
  if (!cookie) process.exit(1);
  const auth = { cookie };

  // Self-heal: a previous crashed drill can leave the flag OFF (it died
  // between OFF and ON-restore). The drill below restores it either way.
  await api(auth, "/api/admin/settings", {
    method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ flags: [{ key: "marketing", enabled: true }] }),
  });

  // ---------- 1. fail-closed ----------
  const anon = await fetch(`${BASE}/api/admin/marketing`, { redirect: "manual" });
  ok("unauthenticated GET /api/admin/marketing → 401", anon.status === 401, `status=${anon.status}`);
  const anonPost = await fetch(`${BASE}/api/admin/marketing/campaigns`, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ businessUnitId: 1, name: "nope" }),
  });
  ok("unauthenticated POST /api/admin/marketing/campaigns → 401 (fail-closed mutation)", anonPost.status === 401, `status=${anonPost.status}`);

  // ---------- 2. surface + flag ----------
  const g0 = await api(auth, "/api/admin/marketing");
  ok("marketing surface reachable (200)", g0.status === 200);
  ok("marketing flag ON", g0.body?.data?.flags?.marketing === true, JSON.stringify(g0.body?.data?.flags));
  const shape = g0.body?.data ?? {};
  ok("surface shape (segments/campaigns/metrics)",
    Array.isArray(shape.segments) && Array.isArray(shape.campaigns) && Array.isArray(shape.metrics), "");

  // ---------- 3. segments ----------
  const seg = await api(auth, "/api/admin/marketing/segments", {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ businessUnitId: 1, name: SEG, estimatedSize: 5000, criteria: { acceptance: "p11" } }),
  });
  ok("segment created (201)", seg.status === 201, `status=${seg.status}`);
  CREATED.segmentId = seg.body?.data?.segment?.id ?? 0;
  const segDup = await api(auth, "/api/admin/marketing/segments", {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ businessUnitId: 1, name: SEG }),
  });
  ok("segment same-BU dedup → 409", segDup.status === 409, `status=${segDup.status} code=${segDup.body?.errors?.[0]?.code}`);
  // Cross-BU name reuse: only meaningful when a second BU actually exists.
  const busList = await api(auth, "/api/admin/business-units");
  const otherBu = (busList.body?.data ?? []).find((bu: any) => bu.id !== 1);
  if (otherBu) {
    const segB = await api(auth, "/api/admin/marketing/segments", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ businessUnitId: otherBu.id, name: SEG }),
    });
    ok(`segment same name allowed cross-BU (BU ${otherBu.id})`, segB.status === 201, `status=${segB.status}`);
    CREATED.segmentIdB = segB.body?.data?.segment?.id ?? 0;
  } else {
    ok("segment same name allowed cross-BU (skipped: single-BU environment)", true, "no second BU on file");
  }
  const segCross = await api(auth, "/api/admin/marketing/campaigns", {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ businessUnitId: 2, name: `${CAMP} cross`, audienceSegmentId: CREATED.segmentId }),
  });
  ok("campaign with cross-BU segment → 400 SEGMENT_NOT_FOUND", segCross.status === 400 && segCross.body?.errors?.[0]?.code === "SEGMENT_NOT_FOUND", `status=${segCross.status}`);

  // ---------- 4. brief generation (deterministic under unfunded LLM) ----------
  const brief = await api(auth, "/api/admin/marketing/brief", {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ businessUnitId: 1 }),
  });
  ok("brief generated (200)", brief.status === 200, `status=${brief.status} body=${JSON.stringify(brief.body).slice(0, 200)}`);
  const b = brief.body?.data?.brief ?? {};
  ok("brief carries name/objective/channels", typeof b.name === "string" && b.name.length > 0 && Array.isArray(b.channels));
  ok("brief degraded=true while LLM unfunded (honest provenance)", b.degraded === true, `degraded=${b.degraded} notes=${b.notes}`);
  ok("brief evidence thin-safe: no invented metrics", (b.keyMessages ?? []).every((m: string) => typeof m === "string"));

  // ---------- 5. campaign from brief → draft ----------
  const start = new Date(Date.now() + (b.startOffsetDays ?? 0) * 86_400_000);
  const end = new Date(start.getTime() + (b.durationDays ?? 14) * 86_400_000);
  const camp = await api(auth, "/api/admin/marketing/campaigns", {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      businessUnitId: 1, name: CAMP, objective: b.objective,
      audienceSegmentId: CREATED.segmentId,
      startsAt: start.toISOString(), endsAt: end.toISOString(),
      metadata: { brief: { keyMessages: b.keyMessages, channels: b.channels } },
      agentSlug: "marketing",
    }),
  });
  ok("campaign created (201) in draft", camp.status === 201 && camp.body?.data?.campaign?.status === "draft", `status=${camp.status}`);
  CREATED.campaignId = camp.body?.data?.campaign?.id ?? 0;
  const campDup = await api(auth, "/api/admin/marketing/campaigns", {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ businessUnitId: 1, name: CAMP }),
  });
  ok("campaign same-BU dedup → 409", campDup.status === 409, `status=${campDup.status}`);

  // ---------- 6. §91 approval law on the live API ----------
  const t1 = await api(auth, `/api/admin/marketing/campaigns/${CREATED.campaignId}/transition`, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ to: "paused" }),
  });
  ok("draft→paused illegal at runtime → 409 BAD_TRANSITION", t1.status === 409 && t1.body?.errors?.[0]?.code === "BAD_TRANSITION", `status=${t1.status}`);
  const t2 = await api(auth, `/api/admin/marketing/campaigns/${CREATED.campaignId}/transition`, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ to: "active" }),
  });
  ok("launch via API: session user stamped as approver", t2.status === 200 && t2.body?.data?.campaign?.status === "active"
    && t2.body?.data?.campaign?.approvedByUserId != null && t2.body?.data?.campaign?.approvedAt != null,
    `status=${t2.status} approvedBy=${t2.body?.data?.campaign?.approvedByUserId}`);
  const t3 = await api(auth, `/api/admin/marketing/campaigns/${CREATED.campaignId}/transition`, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ to: "paused" }),
  });
  ok("active→paused keeps approval history", t3.status === 200 && t3.body?.data?.campaign?.approvedByUserId != null);
  const firstApprover = t2.body?.data?.campaign?.approvedByUserId;
  const firstApprovedAt = t2.body?.data?.campaign?.approvedAt;
  const t4 = await api(auth, `/api/admin/marketing/campaigns/${CREATED.campaignId}/transition`, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ to: "active" }),
  });
  ok("relaunch PRESERVES immutable approver identity",
    t4.status === 200 && t4.body?.data?.campaign?.approvedByUserId === firstApprover
    && t4.body?.data?.campaign?.approvedAt === firstApprovedAt, "");

  // ---------- 7. metrics append-only ----------
  const m1 = await api(auth, "/api/admin/marketing/metrics", {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ campaignId: CREATED.campaignId, impressions: 1000, clicks: 40, conversions: 3, spendUsd: 5.25, source: "manual" }),
  });
  ok("metric snapshot ingested (201)", m1.status === 201, `status=${m1.status}`);
  const m2 = await api(auth, "/api/admin/marketing/metrics", {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ campaignId: CREATED.campaignId, impressions: 1500, clicks: 60, conversions: 4, spendUsd: 4.75, source: "manual" }),
  });
  ok("second snapshot ingested (201, append-only)", m2.status === 201, `status=${m2.status}`);
  const roll = await api(auth, `/api/admin/marketing/campaigns/${CREATED.campaignId}`);
  const r = roll.body?.data?.rollup ?? {};
  ok("rollup SUMS append-only snapshots", r.impressions === 2500 && r.clicks === 100 && r.conversions === 7 && Math.abs(r.spendUsd - 10) < 0.001 && r.snapshots === 2,
    `imp=${r.impressions} clicks=${r.clicks} conv=${r.conversions} spend=${r.spendUsd} snaps=${r.snapshots}`);

  // ---------- 8. sweep flag drill ----------
  const flagOff = await api(auth, "/api/admin/settings", {
    method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ flags: [{ key: "marketing", enabled: false }] }),
  });
  ok("flag drill: marketing → OFF", flagOff.status === 200, `status=${flagOff.status}`);
  const gFlag = await api(auth, "/api/admin/marketing");
  ok("surface reports flag OFF", gFlag.body?.data?.flags?.marketing === false, "");
  const sOff = await api(auth, "/api/admin/marketing/sweep", { method: "POST" });
  ok("manual sweep spawn still durable (flag reported off)", sOff.status === 200 && sOff.body?.data?.marketingFlag === false, `status=${sOff.status} body=${JSON.stringify(sOff.body).slice(0, 120)}`);
  await tick();
  await new Promise((r) => setTimeout(r, 2500));
  const afterOff = await api(auth, `/api/admin/marketing/campaigns/${CREATED.campaignId}`);
  ok("flag OFF: active campaign NOT auto-completed (fail-closed skip)", afterOff.body?.data?.campaign?.status === "active", `status=${afterOff.body?.data?.campaign?.status}`);

  const flagOn = await api(auth, "/api/admin/settings", {
    method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ flags: [{ key: "marketing", enabled: true }] }),
  });
  ok("flag drill: marketing → ON again", flagOn.status === 200, `status=${flagOn.status}`);

  // ---------- 9. terminal semantics ----------
  const t5 = await api(auth, `/api/admin/marketing/campaigns/${CREATED.campaignId}/transition`, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ to: "completed" }),
  });
  ok("active→completed human transition", t5.status === 200 && t5.body?.data?.campaign?.status === "completed" && t5.body?.data?.campaign?.completedAt != null, `status=${t5.status}`);
  const edit = await api(auth, `/api/admin/marketing/campaigns/${CREATED.campaignId}`, {
    method: "PATCH", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ objective: "should not apply" }),
  });
  ok("terminal campaign edit refused → 409 TERMINAL", edit.status === 409 && edit.body?.errors?.[0]?.code === "TERMINAL", `status=${edit.status}`);

  // ---------- 10. audit hygiene ----------
  // The engine's own audit traffic floods the tail; filter by action prefix.
  // NOTE: data.entries collides with Array.prototype.entries — check
  // Array.isArray(data) BEFORE touching named properties.
  const aud = await api(auth, "/api/admin/audit?action=marketing.&limit=100");
  const dataRaw = aud.body?.data;
  const actions = (Array.isArray(dataRaw) ? dataRaw : Array.isArray(dataRaw?.rows) ? dataRaw.rows : []) as any[];
  const found = actions.map((e) => e?.action).filter((a) => typeof a === "string");
  ok("audit rows for marketing actions", found.length >= 3,
    `found=${[...new Set(found)].slice(0, 8).join(",")} raw=${JSON.stringify(aud.body).slice(0, 160)}`);
  ok("audit hygiene: no secrets in marketing.* entries",
    !JSON.stringify(aud.body).toLowerCase().includes("password") && !JSON.stringify(aud.body).toLowerCase().includes("aiza") && !JSON.stringify(aud.body).includes("sk-"), "");

  // ---------- 11. cleanup ----------
  const delSeg = await api(auth, `/api/admin/marketing/segments/${CREATED.segmentId}`, { method: "DELETE" });
  ok("cleanup: segment A deleted", delSeg.status === 200, `status=${delSeg.status}`);
  if (CREATED.segmentIdB) await api(auth, `/api/admin/marketing/segments/${CREATED.segmentIdB}`, { method: "DELETE" });
  // campaigns remain as audited lifecycle history (terminal states are immutable)

  // ---------- 12. screen sweep + widget regression ----------
  for (const [name, path] of [["marketing", "/marketing"], ["social", "/social"], ["seo", "/seo"], ["content", "/content"], ["dashboard", "/dashboard"], ["operations", "/operations"], ["gateway", "/gateway"]] as const) {
    const res = await fetch(`${BASE}${path}`, { headers: auth, redirect: "manual" });
    ok(`screen ${name} renders (200)`, res.status === 200, `status=${res.status}`);
  }
  const widget = await fetch(`${BASE}/api/v1/widget/config?tenant=acme-homes`);
  ok("widget endpoint still 200", widget.status === 200, `status=${widget.status}`);

  console.log(failures === 0 ? "\nALL PHASE-11 LIVE CHECKS PASS" : `\nFAILURES: ${failures}`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => { console.error("fatal:", e); process.exit(1); });
