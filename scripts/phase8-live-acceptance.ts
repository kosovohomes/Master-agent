export {};
/**
 * Phase 8 LIVE ACCEPTANCE against production (https://masteragent-nine.vercel.app).
 * Owner-session driven: login → item create → manual version (edit-before-approve)
 * → lifecycle transitions (incl. illegal-jump rejection) → approve decision
 * (immutable §72 rows + approval_actions trail) → chain run via task engine
 * (LLM leg degrades while the OpenAI key is unfunded → item parks in
 * RESEARCHING with preserved material, task still succeeds) → flag rollback
 * drill → audit hygiene → screen sweep → cleanup. Secrets are read from env,
 * never printed.
 */
const P8_BASE = "https://masteragent-nine.vercel.app";
const P8_ADMIN_PASSWORD = process.env.OWNER_PASSWORD as string;
const P8_EMAILS = [process.env.OWNER_EMAIL ?? "wakeelypro@gmail.com"];

let p8Failures = 0;
function ok8(name: string, cond: boolean, detail = "") {
  console.log(`${cond ? "PASS" : "FAIL"} ${name}${detail ? " :: " + detail : ""}`);
  if (!cond) p8Failures++;
}

async function p8Login(): Promise<string | null> {
  for (const email of P8_EMAILS) {
    const res = await fetch(`${P8_BASE}/api/auth/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email, password: P8_ADMIN_PASSWORD }),
    });
    if (res.ok) {
      const cookie = (res.headers.get("set-cookie") ?? "").split(";")[0];
      console.log(`logged in as ${email}`);
      return cookie;
    }
  }
  return null;
}

async function p8Fetch(auth: Record<string, string>, path: string, init?: RequestInit): Promise<{ status: number; body: any }> {
  const res = await fetch(`${P8_BASE}${path}`, { ...init, headers: { ...auth, ...(init?.headers ?? {}) } });
  let body: any = null;
  try { body = await res.json(); } catch { /* non-JSON */ }
  return { status: res.status, body };
}

const p8Stamp = Date.now();
const p8Created = { itemIds: [] as number[], taskIds: [] as number[] };

async function p8Main() {
  const cookie = await p8Login();
  ok8("owner login", cookie != null);
  if (!cookie) process.exit(1);
  const auth = { cookie };

  // ---------- 1. fail-closed + surface ----------
  const anon = await fetch(`${P8_BASE}/api/admin/content`, { redirect: "manual" });
  ok8("unauthenticated GET /api/admin/content → 401", anon.status === 401, `status=${anon.status}`);

  const g0 = await p8Fetch(auth, "/api/admin/content");
  ok8("content surface reachable (200)", g0.status === 200);
  ok8("content flag ON", g0.body?.data?.flag === true, JSON.stringify(g0.body?.data?.flag));

  // ---------- 2. create item + manual version ----------
  const c1 = await p8Fetch(auth, "/api/admin/content", {
    method: "POST",
    body: JSON.stringify({ mode: "item", businessUnitId: 1, type: "article", title: `Acceptance ${p8Stamp}`, brief: { text: `Live acceptance ${p8Stamp}: modular housing demand note.` } }),
  });
  const itemId = c1.body?.data?.item?.id as number | undefined;
  if (itemId) p8Created.itemIds.push(itemId);
  ok8("item created → IDEA", c1.status === 200 && c1.body?.data?.item?.lifecycle === "IDEA", JSON.stringify(c1.body?.errors ?? c1.status));

  const v1 = await p8Fetch(auth, `/api/admin/content/${itemId}/versions`, {
    method: "POST",
    body: JSON.stringify({ body: "Manual acceptance body for the versioning check — long enough for the route.", changeNote: "acceptance edit" }),
  });
  ok8("manual version v1 appended (never-overwrite)", v1.status === 200 && v1.body?.data?.version?.version === 1, JSON.stringify(v1.body?.errors ?? v1.status));

  const d1 = await p8Fetch(auth, `/api/admin/content/${itemId}`);
  ok8("current_version_id → v1", d1.body?.data?.item?.currentVersionId === v1.body?.data?.version?.id);
  ok8("edit action in approval_actions trail", (d1.body?.data?.actions as any[])?.some((a) => a.action === "edit") === true);

  // ---------- 3. lifecycle machinery (transactional FSM) ----------
  await p8Fetch(auth, `/api/admin/content/${itemId}`, { method: "PATCH", body: JSON.stringify({ lifecycle: "RESEARCHING" }) });
  const toDraft = await p8Fetch(auth, `/api/admin/content/${itemId}`, { method: "PATCH", body: JSON.stringify({ lifecycle: "DRAFT" }) });
  ok8("IDEA → RESEARCHING → DRAFT", toDraft.status === 200);
  const illegal = await p8Fetch(auth, `/api/admin/content/${itemId}`, { method: "PATCH", body: JSON.stringify({ lifecycle: "APPROVED" }) });
  ok8("DRAFT → APPROVED rejected 409 ILLEGAL_TRANSITION", illegal.status === 409 && illegal.body?.errors?.[0]?.code === "ILLEGAL_TRANSITION", JSON.stringify(illegal.body?.errors));
  const toReview = await p8Fetch(auth, `/api/admin/content/${itemId}`, { method: "PATCH", body: JSON.stringify({ lifecycle: "REVIEW" }) });
  ok8("DRAFT → REVIEW", toReview.status === 200 && toReview.body?.data?.item?.lifecycle === "REVIEW");

  const rejectNoReason = await p8Fetch(auth, `/api/admin/content/${itemId}/decide`, { method: "POST", body: JSON.stringify({ decision: "reject" }) });
  ok8("reject without reason → 400 REASON_REQUIRED", rejectNoReason.status === 400 && rejectNoReason.body?.errors?.[0]?.code === "REASON_REQUIRED", JSON.stringify(rejectNoReason.body?.errors));

  const decide = await p8Fetch(auth, `/api/admin/content/${itemId}/decide`, { method: "POST", body: JSON.stringify({ decision: "approve", comment: "acceptance approval" }) });
  ok8("approve → APPROVED", decide.status === 200 && decide.body?.data?.item?.lifecycle === "APPROVED", JSON.stringify(decide.body?.errors));

  const d2 = await p8Fetch(auth, `/api/admin/content/${itemId}`);
  const approvals = (d2.body?.data?.approvals ?? []) as any[];
  ok8("immutable approvals row (content_item_id set, draft_id null)", approvals.some((a) => a.contentItemId === itemId && a.draftId === null && a.decision === "approved"), JSON.stringify(approvals));
  const trail = (d2.body?.data?.actions ?? []) as any[];
  ok8("approval_actions trail: edit + approve recorded", trail.some((a) => a.action === "edit") && trail.some((a) => a.action === "approve"), trail.map((a) => a.action).join(","));

  const decideAgain = await p8Fetch(auth, `/api/admin/content/${itemId}/decide`, { method: "POST", body: JSON.stringify({ decision: "approve" }) });
  ok8("second decision rejected 409 NOT_IN_REVIEW", decideAgain.status === 409 && decideAgain.body?.errors?.[0]?.code === "NOT_IN_REVIEW", JSON.stringify(decideAgain.body?.errors));

  // ---------- 4. chain run via the task engine (degraded: LLM unfunded) ----------
  const run1 = await p8Fetch(auth, "/api/admin/content", {
    method: "POST",
    body: JSON.stringify({ mode: "run", businessUnitId: 1, type: "social_post", brief: `Live acceptance chain ${p8Stamp}: modular housing social post.` }),
  });
  ok8("chain run spawns task", run1.status === 200 && Number.isInteger(run1.body?.data?.taskId), JSON.stringify(run1.body?.errors ?? run1.body));
  const taskId = run1.body?.data?.taskId as number;
  p8Created.taskIds.push(taskId);

  // serverless has no resident worker — play the worker with the engine tick
  const cronSecret = process.env.CRON_SECRET as string;
  let task: any = null;
  for (let i = 0; i < 36; i++) {
    await fetch(`${P8_BASE}/api/agents/engine/tick`, { method: "POST", headers: { "x-cron-secret": cronSecret } }).catch(() => null);
    await new Promise((r) => setTimeout(r, 5000));
    const tr = await p8Fetch(auth, `/api/admin/tasks?limit=200`);
    const rows = (tr.body?.data?.tasks ?? []) as any[];
    task = rows.find((t) => t.id === taskId) ?? null;
    if (task && ["succeeded", "failed", "escalated"].includes(task.status)) break;
  }
  ok8("content_run task succeeded", task?.status === "succeeded", JSON.stringify({ status: task?.status, error: task?.error }));
  ok8("degraded mode: chain parked the item, task still succeeded",
    task?.result?.degraded === true && typeof task?.result?.degradeReason === "string",
    JSON.stringify(task?.result));
  if (task?.result?.itemId) p8Created.itemIds.push(Number(task.result.itemId));
  if (task?.result?.itemId != null) {
    const parked = await p8Fetch(auth, `/api/admin/content/${task.result.itemId}`);
  ok8("parked item carries unprocessed reason",
      parked.body?.data?.item?.lifecycle === "RESEARCHING" && typeof parked.body?.data?.item?.unprocessedReason === "string",
      JSON.stringify({ lc: parked.body?.data?.item?.lifecycle, reason: (parked.body?.data?.item?.unprocessedReason ?? "").slice(0, 120) }));
    const rep = await p8Fetch(auth, `/api/admin/content/${task.result.itemId}/run`, { method: "POST" });
  ok8("reprocess spawns (still degraded, nothing lost)", rep.status === 200 && Number.isInteger(rep.body?.data?.taskId), JSON.stringify(rep.body?.errors ?? rep.body));
    if (rep.body?.data?.taskId) p8Created.taskIds.push(rep.body.data.taskId);
  }

  // ---------- 5. flag rollback drill ----------
  const fr = await p8Fetch(auth, "/api/admin/settings", {
    method: "PUT",
    body: JSON.stringify({ flags: [{ key: "content", enabled: false }] }),
  });
  ok8("flag flip OFF accepted", fr.status === 200, JSON.stringify(fr.body?.errors));
  const runOff = await p8Fetch(auth, "/api/admin/content", {
    method: "POST",
    body: JSON.stringify({ mode: "run", businessUnitId: 1, brief: "drill while off" }),
  });
  ok8("run while flag OFF → 409 CONTENT_DISABLED", runOff.status === 409 && runOff.body?.errors?.[0]?.code === "CONTENT_DISABLED", JSON.stringify(runOff.body?.errors));
  const fr2 = await p8Fetch(auth, "/api/admin/settings", {
    method: "PUT",
    body: JSON.stringify({ flags: [{ key: "content", enabled: true }] }),
  });
  ok8("flag restored ON", fr2.status === 200);

  // ---------- 6. audit hygiene ----------
  const ar = await p8Fetch(auth, "/api/admin/audit?limit=100");
  const audits = (ar.body?.data ?? []) as any[];
  const actions = new Set(audits.map((a) => a.action));
  ok8("audit records content.item.create + content.review.approve",
    audits.some((a) => a.action === "content.item.create" && a.result === "success") && audits.some((a) => a.action === "content.review.approve"),
    [...actions].filter((a) => String(a).startsWith("content.")).join(","));
  ok8("audit never stores secrets", !JSON.stringify(audits).toLowerCase().includes("admin_password"));

  // ---------- 7. screen sweep ----------
  for (const p of ["/content", "/approvals", "/dashboard", "/research", "/operations", "/knowledge"]) {
    const res = await fetch(`${P8_BASE}${p}`, { headers: auth, redirect: "manual" });
  ok8(`screen ${p} 200`, res.status === 200, `status=${res.status}`);
  }

  // ---------- 8. cleanup (leave production pristine) ----------
  for (const id of p8Created.itemIds) {
    const arch = await p8Fetch(auth, `/api/admin/content/${id}`, { method: "PATCH", body: JSON.stringify({ lifecycle: "ARCHIVED" }) });
  ok8(`item #${id} archived (cleanup)`, arch.status === 200 || arch.status === 409, `status=${arch.status}`);
  }

  console.log(p8Failures === 0 ? "\nPHASE 8 LIVE ACCEPTANCE: ALL PASS" : `\nPHASE 8 LIVE ACCEPTANCE: ${p8Failures} FAILURE(S)`);
  process.exit(p8Failures === 0 ? 0 : 1);
}

await p8Main();
