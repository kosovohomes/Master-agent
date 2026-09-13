/**
 * Phase 7 LIVE ACCEPTANCE against production (https://masteragent-nine.vercel.app).
 * Owner-session driven: login → schedule + competitor registry → run-now
 * (real web_search + real fetch_url; the LLM leg degrades while the OpenAI
 * key is unfunded → 'unprocessed' material stored, task still succeeds) →
 * reprocess → review transitions → flag rollback drill → audit hygiene →
 * screen sweep → cleanup. Secrets are read from env, never printed.
 *
 * The production search provider seam is DuckDuckGo (no key required);
 * BRAVE_SEARCH_API_KEY can replace it via env without a deploy.
 */
const BASE = "https://masteragent-nine.vercel.app";
const ADMIN_PASSWORD = process.env.OWNER_PASSWORD as string;
const EMAILS = [process.env.OWNER_EMAIL ?? "wakeelypro@gmail.com"];

let failures = 0;
function check(name: string, cond: boolean, detail = "") {
  console.log(`${cond ? "PASS" : "FAIL"} ${name}${detail ? " :: " + detail : ""}`);
  if (!cond) failures++;
}

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

async function jfetch(auth: Record<string, string>, path: string, init?: RequestInit): Promise<{ status: number; body: any }> {
  const res = await fetch(`${BASE}${path}`, { ...init, headers: { ...auth, ...(init?.headers ?? {}) } });
  let body: any = null;
  try { body = await res.json(); } catch { /* non-JSON */ }
  return { status: res.status, body };
}

const stamp = Date.now();
const created = { scheduleId: 0, competitorId: 0, itemIds: [] as number[], taskIds: [] as number[] };

async function main() {
  const cookie = await login();
  check("owner login", cookie != null);
  if (!cookie) process.exit(1);
  const auth = { Cookie: cookie };

  // ---------- baseline ----------
  const g0 = await jfetch(auth, "/api/admin/research");
  check("research surface reachable (200)", g0.status === 200);
  check("research flag ON", g0.body?.data?.flag === true, JSON.stringify(g0.body?.data?.flag));
  check("research.manage held by owner", g0.status !== 403);

  // BU context (use the first BU)
  const br = await jfetch(auth, "/api/admin/business-units");
  const bus = (br.body?.data ?? []) as { id: number; name: string }[];
  check("business units visible", bus.length > 0);
  const bu = bus[0];

  // ---------- competitor registry ----------
  const c1 = await jfetch(auth, "/api/admin/competitors", {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ businessUnitId: bu.id, name: `OpenAI (acceptance ${stamp})`, url: "https://openai.com/news/" }),
  });
  check("competitor created", c1.status === 201 || c1.status === 200, JSON.stringify(c1.body));
  created.competitorId = c1.body?.data?.competitor?.id ?? 0;
  const cDup = await jfetch(auth, "/api/admin/competitors", {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ businessUnitId: bu.id, name: `openai (ACCEPTANCE ${stamp})` }),
  });
  check("competitor duplicate (case-insensitive) rejected 409", cDup.status === 409, JSON.stringify(cDup.body?.errors));

  // ---------- schedule + run-now ----------
  const s1 = await jfetch(auth, "/api/admin/research", {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      businessUnitId: bu.id, agentSlug: "research", name: `AI intelligence daily (acceptance ${stamp})`,
      topic: "latest AI industry news {{date}}", cadence: "daily",
    }),
  });
  check("schedule created", s1.status === 201 || s1.status === 200, JSON.stringify(s1.body));
  created.scheduleId = s1.body?.data?.schedule?.id ?? 0;

  const badS = await jfetch(auth, "/api/admin/research", {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ businessUnitId: bu.id, name: "x", topic: "", cadence: "yearly" }),
  });
  check("invalid schedule rejected 400", badS.status === 400, JSON.stringify(badS.body?.errors));

  const run1 = await jfetch(auth, `/api/admin/research/schedules/${created.scheduleId}/run`, { method: "POST" });
  check("run-now spawns task", run1.status === 200 && Number.isInteger(run1.body?.data?.taskId), JSON.stringify(run1.body));
  const taskId = run1.body?.data?.taskId as number;
  created.taskIds.push(taskId);

  // poll the durable task (search + fetch + analyze can take ~30-60s)
  let task: any = null;
  for (let i = 0; i < 30; i++) {
    await new Promise((r) => setTimeout(r, 5000));
    const tr = await jfetch(auth, `/api/admin/tasks?limit=200`);
    const rows = (tr.body?.data?.tasks ?? []) as any[];
    task = rows.find((t) => t.id === taskId) ?? null;
    if (task && ["succeeded", "failed", "escalated"].includes(task.status)) break;
  }
  check("research_run task succeeded", task?.status === "succeeded", JSON.stringify(task?.status));
  check("task result reports degraded mode (LLM unfunded)",
    task?.result?.degraded === true && typeof task?.result?.degradeReason === "string",
    JSON.stringify(task?.result));
  check("real web_search executed (searched >= 1)", (task?.result?.searched ?? 0) >= 1, JSON.stringify(task?.result));
  check("real fetch executed or contained", (task?.result?.collected ?? 0) >= 1, JSON.stringify(task?.result));
  check("material stored as unprocessed", (task?.result?.unprocessed ?? 0) >= 1, JSON.stringify(task?.result));

  // ---------- the unprocessed item: sources + reprocess + review ----------
  const g1 = await jfetch(auth, "/api/admin/research");
  const items = (g1.body?.data?.items ?? []) as any[];
  const un = items.find((i) => i.status === "unprocessed");
  check("unprocessed item visible on the surface", un != null);
  if (un) {
    created.itemIds.push(un.id);
    check("item carries real fetched sources", (un.sources ?? []).length >= 1 && (un.sources ?? []).some((s: any) => (s.url ?? "").startsWith("http")), JSON.stringify((un.sources ?? []).slice(0, 2).map((s: any) => s.url)));
    check("item title names the degrade reason", (un.title ?? "").includes("LLM unavailable"), un.title);
    const rep = await jfetch(auth, `/api/admin/research/items/${un.id}`, {
      method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action: "process" }),
    });
    check("reprocess spawns (LLM still unfunded → also degraded)", rep.status === 200 && Number.isInteger(rep.body?.data?.taskId), JSON.stringify(rep.body));
    if (rep.body?.data?.taskId) created.taskIds.push(rep.body.data.taskId);
    const arc = await jfetch(auth, `/api/admin/research/items/${un.id}`, {
      method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action: "archive" }),
    });
    check("review action archive works from unprocessed", arc.status === 200 && arc.body?.data?.item?.status === "archived", JSON.stringify(arc.body?.data?.item?.status));
    const bad = await jfetch(auth, `/api/admin/research/items/${un.id}`, {
      method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action: "verify" }),
    });
    check("invalid review action rejected 400", bad.status === 400, JSON.stringify(bad.body?.errors));
  }

  // ---------- flag rollback drill ----------
  const fr = await jfetch(auth, "/api/admin/settings", {
    method: "PUT", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ flags: [{ key: "research", enabled: false }] }),
  });
  check("flag flip OFF accepted", fr.status === 200, JSON.stringify(fr.body?.errors));
  const runOff = await jfetch(auth, `/api/admin/research/schedules/${created.scheduleId}/run`, { method: "POST" });
  check("run-now while flag OFF → 409 RESEARCH_DISABLED", runOff.status === 409 && runOff.body?.errors?.[0]?.code === "RESEARCH_DISABLED", JSON.stringify(runOff.body));
  const fr2 = await jfetch(auth, "/api/admin/settings", {
    method: "PUT", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ flags: [{ key: "research", enabled: true }] }),
  });
  check("flag restored ON", fr2.status === 200);
  const runOn = await jfetch(auth, `/api/admin/research/schedules/${created.scheduleId}/run`, { method: "POST" });
  check("run-now restored", runOn.status === 200, JSON.stringify(runOn.body));
  if (runOn.body?.data?.taskId) created.taskIds.push(runOn.body.data.taskId);

  // ---------- audit hygiene ----------
  const ar = await jfetch(auth, "/api/admin/audit?limit=100");
  const audits = (ar.body?.data?.entries ?? ar.body?.data ?? []) as any[];
  const hasCreate = audits.some((a) => a.action === "research.schedule.create" && a.result === "success");
  const hasRun = audits.some((a) => a.action === "research.schedule.run");
  check("audit records schedule.create + run", hasCreate && hasRun, JSON.stringify(audits.slice(0, 3).map((a) => a.action)));
  check("audit never stores secrets", !JSON.stringify(audits).toLowerCase().includes("signingsecret"));

  // ---------- screen sweep ----------
  for (const p of ["/research", "/dashboard", "/operations", "/knowledge", "/connectors", "/settings"]) {
    const res = await fetch(`${BASE}${p}`, { headers: auth, redirect: "manual" });
    check(`screen ${p} 200`, res.status === 200, `status=${res.status}`);
  }

  // ---------- cleanup (leave production pristine) ----------
  if (created.scheduleId) {
    const d = await jfetch(auth, `/api/admin/research/schedules/${created.scheduleId}`, { method: "DELETE" });
    check("cleanup: schedule deleted", d.status === 200);
  }
  if (created.competitorId) {
    const d = await jfetch(auth, `/api/admin/competitors/${created.competitorId}`, { method: "DELETE" });
    check("cleanup: competitor deleted", d.status === 200);
  }
  for (const id of created.itemIds) {
    await jfetch(auth, `/api/admin/research/items/${id}`, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action: "archive" }) }).catch(() => null);
  }

  console.log(failures === 0 ? "PHASE 7 LIVE ACCEPTANCE: ALL PASS" : `PHASE 7 LIVE ACCEPTANCE: ${failures} FAILURE(S)`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => { console.error("acceptance crashed:", e); process.exit(1); });
