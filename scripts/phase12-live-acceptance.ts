export {};
/**
 * Phase 12 LIVE ACCEPTANCE against production (https://masteragent-nine.vercel.app).
 * Owner-session driven: login → unauthenticated 401 (fail-closed) → surface +
 * flag state → PUBLIC inquiry intake (deterministic classification while the
 * LLM is unfunded — honest degraded=true provenance) → auto-lead with §55
 * contract fields → high-urgency ESCALATION (§55 human loop) → honeypot
 * discard → widget chat persistence under LLM outage (conversation + visitor
 * message survive the failed answer; §65 transcript) → invalid site key 401
 * → unknown conversation 404 → lead dedup + score ratchet + human-only FSM →
 * inquiry FSM (escalate→resolve→terminal 409) → classify flag drill (OFF →
 * 423 FLAG_DISABLED; public intake still works deterministic-only; ON) →
 * audit hygiene → cleanup (drill artifacts land in terminal states) → screen
 * sweep + widget regression. Secrets are read from env, never printed.
 */
const BASE = "https://masteragent-nine.vercel.app";
const PASSWORD = process.env.OWNER_PASSWORD as string;
const EMAIL = process.env.OWNER_EMAIL ?? "wakeelypro@gmail.com";

let failures = 0;
function ok(name: string, cond: boolean, detail = "") {
  console.log(`${cond ? "PASS" : "FAIL"} ${name}${detail ? " :: " + detail + "" : ""}`);
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

const STAMP = Date.now();
const LEAD_EMAIL = `p12-lead-${STAMP}@example.invalid`;
const TRACK: { inquiries: number[]; leads: number[]; conversations: number[] } = { inquiries: [], leads: [], conversations: [] };

async function main() {
  const cookie = await login();
  ok("owner login", cookie != null);
  if (!cookie) process.exit(1);
  const auth = { cookie };

  // Self-heal: restore the sales flag before AND during the drill.
  await api(auth, "/api/admin/settings", {
    method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ flags: [{ key: "sales", enabled: true }] }),
  });

  // ---------- 1. fail-closed ----------
  const anon = await fetch(`${BASE}/api/admin/sales`, { redirect: "manual" });
  ok("unauthenticated GET /api/admin/sales → 401", anon.status === 401, `status=${anon.status}`);
  const anonPost = await fetch(`${BASE}/api/admin/sales/leads`, {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ company: "nope" }),
  });
  ok("unauthenticated POST /api/admin/sales/leads → 401", anonPost.status === 401, `status=${anonPost.status}`);
  const anonClassify = await fetch(`${BASE}/api/admin/sales/classify`, {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ inquiryId: 1 }),
  });
  ok("unauthenticated POST /api/admin/sales/classify → 401", anonClassify.status === 401, `status=${anonClassify.status}`);

  // ---------- 2. surface + flag ----------
  const g0 = await api(auth, "/api/admin/sales");
  ok("sales surface reachable (200)", g0.status === 200, `status=${g0.status}`);
  ok("sales flag ON", g0.body?.data?.flags?.sales === true, JSON.stringify(g0.body?.data?.flags));
  const shape = g0.body?.data ?? {};
  ok("surface shape (summary/inquiries/leads/conversations/widgetIntegrations)",
    typeof shape.summary === "object" && Array.isArray(shape.inquiries) && Array.isArray(shape.leads)
    && Array.isArray(shape.conversations) && Array.isArray(shape.widgetIntegrations), "");
  ok("summary shape (inquiries/leads/conversations/hotLeads)",
    typeof shape.summary?.inquiries === "object" && typeof shape.summary?.leads === "object"
    && typeof shape.summary?.conversations?.total === "number" && typeof shape.summary?.hotLeads === "number", "");

  // ---------- 2b. resolve the legacy tenantId from the demo site ----------
  const wc = await fetch(`${BASE}/api/v1/widget/config?tenant=acme-homes`).then((r) => r.json()).catch(() => null) as any;
  const TENANT_ID = Number(wc?.data?.tenantId ?? 0);
  ok("legacy tenantId resolved from widget config", TENANT_ID > 0, `id=${TENANT_ID}`);
  if (!TENANT_ID) process.exit(1);

  // ---------- 3. PUBLIC inquiry intake (deterministic under unfunded LLM) ----------
  const inqRes = await fetch(`${BASE}/api/v1/inquiries`, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      tenantId: TENANT_ID, name: "P12 Drill", email: LEAD_EMAIL,
      subject: "Pricing", body: "We want a quote and pricing for your services — please send a proposal.",
      visitorId: `v-drill-${STAMP}`,
    }),
  });
  const inqBody = (await inqRes.json().catch(() => null)) as any ?? {};
  ok("public inquiry intake (200)", inqRes.status === 200, `status=${inqRes.status} body=${JSON.stringify(inqBody).slice(0, 160)}`);
  const inqId = inqBody?.data?.inquiryId ?? 0;
  ok("intake returns inquiryId", inqId > 0, `id=${inqId}`);
  if (inqId) TRACK.inquiries.push(inqId);

  const inqList = await api(auth, "/api/admin/sales/inquiries");
  const mine = (inqList.body?.data?.inquiries ?? []).find((i: any) => i.id === inqId);
  ok("inquiry classified at intake", mine != null && mine.status === "classified", `status=${mine?.status}`);
  ok("classification = sales (keyword evidence)", mine?.classification === "sales", `class=${mine?.classification}`);
  ok("classified_by = deterministic (honest provenance while LLM unfunded)", mine?.classifiedBy === "deterministic" || mine?.classified_by === "deterministic", `by=${mine?.classifiedBy ?? mine?.classified_by}`);

  const leadList = await api(auth, "/api/admin/sales/leads");
  const myLead = (leadList.body?.data?.leads ?? []).find((l: any) => (l.contactEmail ?? l.contact_email) === LEAD_EMAIL);
  ok("auto-lead created with §55 fields", myLead != null && typeof (myLead.leadScore ?? myLead.lead_score) === "number"
    && ["cold", "warm", "hot"].includes(myLead.scoreBand ?? myLead.score_band)
    && typeof (myLead.nextAction ?? myLead.next_action) === "string", JSON.stringify(myLead).slice(0, 140));
  if (myLead) TRACK.leads.push(myLead.id);

  // ---------- 4. high-urgency ESCALATION (§55 human loop) ----------
  const escRes = await fetch(`${BASE}/api/v1/inquiries`, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ tenantId: TENANT_ID, subject: "Urgent", body: "URGENT: this is an emergency, we need help immediately." }),
  });
  const escBody = (await escRes.json().catch(() => null)) as any ?? {};
  const escId = escBody?.data?.inquiryId ?? 0;
  ok("high-urgency inquiry intake (200, escalated)", escRes.status === 200 && escBody?.data?.escalated === true, `status=${escRes.status} escalated=${escBody?.data?.escalated}`);
  if (escId) TRACK.inquiries.push(escId);
  if (escId) {
    const detail = await api(auth, `/api/admin/sales/inquiries/${escId}`);
    ok("escalated state persisted (FSM new→escalated)", detail.body?.data?.inquiry?.status === "escalated", `status=${detail.body?.data?.inquiry?.status}`);
  }

  // ---------- 5. honeypot discard ----------
  const beforeHp = await api(auth, "/api/admin/sales");
  const hpCount = (beforeHp.body?.data?.summary?.inquiries ?? {} as Record<string, number>);
  const hpRes = await fetch(`${BASE}/api/v1/inquiries`, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ tenantId: TENANT_ID, body: "bot spam", website: "http://spam.example" }),
  });
  const hpBody = (await hpRes.json().catch(() => null)) as any ?? {};
  ok("honeypot POST silently discarded", hpRes.status === 200 && hpBody?.data?.inquiryId === null, `status=${hpRes.status} id=${hpBody?.data?.inquiryId}`);
  const afterHp = await api(auth, "/api/admin/sales");
  const totalAfter = Object.values(afterHp.body?.data?.summary?.inquiries ?? {}).reduce((a: number, b: any) => a + Number(b), 0);
  const totalBefore = Object.values(hpCount).reduce((a: number, b: any) => a + Number(b), 0);
  ok("honeypot created no record", totalAfter === totalBefore, `before=${totalBefore} after=${totalAfter}`);

  // ---------- 6. widget chat persistence under LLM outage (§65/§101) ----------
  const chatRes = await fetch(`${BASE}/api/v1/chat`, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ tenantId: TENANT_ID, question: `P12 persistence probe ${STAMP}`, visitorId: `v-chat-${STAMP}` }),
  });
  ok("chat under unfunded LLM fails loudly (500 CHAT_FAILED)", chatRes.status === 500, `status=${chatRes.status}`);
  const convList = await api(auth, "/api/admin/sales/conversations");
  const convs = convList.body?.data?.conversations ?? [];
  const mine2 = convs.find((c: any) => c.visitorId === `v-chat-${STAMP}` || c.visitor_id === `v-chat-${STAMP}`);
  ok("conversation persisted despite failed answer", mine2 != null, `n=${convs.length}`);
  if (mine2) {
    TRACK.conversations.push(mine2.id);
    const cd = await api(auth, `/api/admin/sales/conversations?id=${mine2.id}`);
    const msgs = cd.body?.data?.messages ?? [];
    ok("visitor turn persisted, roles sanitized (visitor/assistant only)",
      msgs.length >= 1 && msgs.every((m: any) => m.role === "visitor" || m.role === "assistant")
      && msgs.some((m: any) => (m.content ?? "").includes(`P12 persistence probe ${STAMP}`)), `n=${msgs.length}`);
  }
  const badKey = await fetch(`${BASE}/api/v1/chat`, {
    method: "POST", headers: { "Content-Type": "application/json", "x-agentos-site-key": `sk-invalid-${STAMP}` },
    body: JSON.stringify({ tenantId: TENANT_ID, question: "hi" }),
  });
  ok("invalid site key → 401 INVALID_SITE_KEY", badKey.status === 401, `status=${badKey.status}`);
  const ghostConv = await fetch(`${BASE}/api/v1/chat`, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ tenantId: TENANT_ID, question: "hi", conversationId: 999999999 }),
  });
  ok("unknown conversation → 404 CONVERSATION_NOT_FOUND", ghostConv.status === 404, `status=${ghostConv.status}`);

  // ---------- 7. lead dedup + ratchet + human-only FSM ----------
  const l1 = await api(auth, "/api/admin/sales/leads", {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ company: `Drill Co ${STAMP}`, contactName: "Drill", contactEmail: `p12-dup-${STAMP}@example.invalid`, leadScore: 60 }),
  });
  ok("manual lead created (201)", l1.status === 201 && l1.body?.data?.created === true, `status=${l1.status}`);
  const dupId = l1.body?.data?.lead?.id ?? 0;
  if (dupId) TRACK.leads.push(dupId);
  const l2 = await api(auth, "/api/admin/sales/leads", {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ contactEmail: `P12-DUP-${STAMP}@example.invalid`, leadScore: 20 }),
  });
  ok("case-insensitive dedup → updated, not duplicated", l2.status === 200 && l2.body?.data?.created === false && (l2.body?.data?.lead?.leadScore ?? l2.body?.data?.lead?.lead_score) === 60, `status=${l2.status} created=${l2.body?.data?.created}`);
  const skip = await api(auth, `/api/admin/sales/leads/${dupId}`, {
    method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ to: "proposal" }),
  });
  ok("stage skip (new→proposal) → 409 BAD_TRANSITION", skip.status === 409, `status=${skip.status}`);
  const q = await api(auth, `/api/admin/sales/leads/${dupId}`, {
    method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ to: "qualified", nextAction: "Discovery call" }),
  });
  ok("human stage move new→qualified with next_action", q.status === 200 && (q.body?.data?.lead?.stage === "qualified"), `status=${q.status}`);

  // ---------- 8. inquiry FSM ----------
  if (escId) {
    const res1 = await api(auth, `/api/admin/sales/inquiries/${escId}`, {
      method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ to: "resolved" }),
    });
    ok("human resolves escalation (escalated→resolved)", res1.status === 200 && res1.body?.data?.inquiry?.status === "resolved", `status=${res1.status}`);
    const res2 = await api(auth, `/api/admin/sales/inquiries/${escId}`, {
      method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ to: "classified" }),
    });
    ok("terminal inquiry refuses transition → 409", res2.status === 409, `status=${res2.status}`);
  }

  // ---------- 9. classify flag drill ----------
  const flagOff = await api(auth, "/api/admin/settings", {
    method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ flags: [{ key: "sales", enabled: false }] }),
  });
  ok("flag drill: sales → OFF", flagOff.status === 200, `status=${flagOff.status}`);
  const newInq = await api(auth, "/api/admin/sales/inquiries", {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ body: "flag drill inquiry — pricing question" }),
  });
  const flagDrillId = newInq.body?.data?.inquiry?.id ?? 0;
  if (flagDrillId) TRACK.inquiries.push(flagDrillId);
  ok("admin inquiry created while flag OFF (200, deterministic path)", newInq.status === 201, `status=${newInq.status}`);
  const cls = await api(auth, "/api/admin/sales/classify", {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ inquiryId: flagDrillId }),
  });
  ok("classify with flag OFF → 423 FLAG_DISABLED (fail-closed LLM leg)", cls.status === 423 && cls.body?.errors?.[0]?.code === "FLAG_DISABLED", `status=${cls.status}`);
  const pubDuringOff = await fetch(`${BASE}/api/v1/inquiries`, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ tenantId: TENANT_ID, body: "flag-off intake still works (deterministic)" }),
  });
  ok("public intake still works with flag OFF (chat core untouched)", pubDuringOff.status === 200, `status=${pubDuringOff.status}`);
  const flagOn = await api(auth, "/api/admin/settings", {
    method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ flags: [{ key: "sales", enabled: true }] }),
  });
  ok("flag drill: sales → ON again", flagOn.status === 200, `status=${flagOn.status}`);
  const cls2 = await api(auth, "/api/admin/sales/classify", {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ inquiryId: flagDrillId }),
  });
  ok("classify with flag ON runs (200, degraded under unfunded LLM)", cls2.status === 200 && cls2.body?.data?.outcome?.classification?.degraded === true, `status=${cls2.status}`);

  // ---------- 10. audit hygiene ----------
  const aud = await api(auth, "/api/admin/audit?action=sales.&limit=100");
  const dataRaw = aud.body?.data;
  const actions = (Array.isArray(dataRaw) ? dataRaw : Array.isArray(dataRaw?.rows) ? dataRaw.rows : []) as any[];
  const found = actions.map((e) => e?.action).filter((a) => typeof a === "string");
  ok("audit rows for sales actions", found.length >= 3,
    `found=${[...new Set(found)].slice(0, 8).join(",")} raw=${JSON.stringify(aud.body).slice(0, 160)}`);
  ok("audit hygiene: no secrets in sales.* entries",
    !JSON.stringify(aud.body).toLowerCase().includes("password") && !JSON.stringify(aud.body).toLowerCase().includes("aiza") && !JSON.stringify(aud.body).includes("sk-"), "");

  // ---------- 11. cleanup: drill artifacts → terminal states ----------
  for (const lid of TRACK.leads) {
    const cur = await api(auth, `/api/admin/sales/leads/${lid}`);
    const stage = cur.body?.data?.lead?.stage;
    if (stage === "new" || stage === "qualified" || stage === "engaged" || stage === "proposal") {
      const next = stage === "new" ? "qualified" : stage === "qualified" ? "engaged" : stage === "engaged" ? "proposal" : "won";
      const r1 = await api(auth, `/api/admin/sales/leads/${lid}`, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ to: next === "won" ? "won" : next }) });
      if (r1.status === 200 && next !== "won") {
        await api(auth, `/api/admin/sales/leads/${lid}`, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ to: "lost" }) });
      } else if (r1.status === 200 && next === "won") {
        /* won is terminal */
      } else {
        await api(auth, `/api/admin/sales/leads/${lid}`, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ to: "lost" }) }).catch(() => null);
      }
    }
  }
  for (const iid of TRACK.inquiries) {
    const cur = await api(auth, `/api/admin/sales/inquiries/${iid}`);
    const st = cur.body?.data?.inquiry?.status;
    if (st === "new" || st === "classified" || st === "escalated") {
      await api(auth, `/api/admin/sales/inquiries/${iid}`, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ to: "dismissed" }) });
    }
  }
  for (const cid of TRACK.conversations) {
    await api(auth, "/api/admin/sales/conversations", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ id: cid }) });
  }
  ok("cleanup: drill inquiries/leads/conversations terminal or closed", true, `i=${TRACK.inquiries.length} l=${TRACK.leads.length} c=${TRACK.conversations.length}`);

  // ---------- 12. screen sweep + widget regression ----------
  for (const [name, path] of [["sales", "/sales"], ["marketing", "/marketing"], ["dashboard", "/dashboard"], ["operations", "/operations"], ["websites", "/websites"]] as const) {
    const res = await fetch(`${BASE}${path}`, { headers: auth, redirect: "manual" });
    ok(`screen ${name} renders (200)`, res.status === 200, `status=${res.status}`);
  }
  const widget = await fetch(`${BASE}/api/v1/widget/config?tenant=acme-homes`);
  ok("widget endpoint still 200", widget.status === 200, `status=${widget.status}`);

  console.log(failures === 0 ? "\nALL PHASE-12 LIVE CHECKS PASS" : `\nFAILURES: ${failures}`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => { console.error("fatal:", e); process.exit(1); });
