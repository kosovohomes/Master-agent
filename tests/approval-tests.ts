import assert from "node:assert";
import {
  STATUS_FLOW, canTransition, createDraft, approveDraft, rejectDraft,
  scheduleDraft, markPosted, markFailed, listDraftsByTenant,
} from "../lib/agents/approval";
import type { DraftStatus } from "../lib/agents/approval";
import { query } from "../lib/db";

let failures = 0;
function check(name: string, cond: boolean, detail = "") {
  console.log(`${cond ? "PASS" : "FAIL"} ${name}${detail ? " :: " + detail : ""}`);
  if (!cond) failures++;
}

// --- pure FSM: every documented legal path is open, every illegal path is closed ---
const legal: Array<[DraftStatus, DraftStatus]> = [
  ["pending", "approved"], ["pending", "rejected"], ["approved", "scheduled"],
  ["scheduled", "posted"], ["scheduled", "failed"],
];
for (const [from, to] of legal) check(`legal ${from}->${to}`, canTransition(from, to) === true);

const illegal: Array<[DraftStatus, DraftStatus]> = [
  ["pending", "posted"], ["rejected", "approved"], ["posted", "scheduled"], ["approved", "posted"], ["rejected", "scheduled"],
];
for (const [from, to] of illegal) check(`illegal ${from}->${to}`, canTransition(from, to) === false);

check("STATUS_FLOW covers all 6 statuses, no self-loops",
  Object.keys(STATUS_FLOW).length === 6 &&
  (Object.keys(STATUS_FLOW) as DraftStatus[]).every((k) => !STATUS_FLOW[k as DraftStatus].includes(k as DraftStatus)));

// --- end-to-end against live DB with isolated test tenants (cleaned up in finally) ---
const slugA = `t5-approval-${Date.now()}`;
const slugB = `t5-approval-scope-${Date.now()}`;
let tenantId: number | undefined;
let tidB: number | undefined;
try {
  const t = await query<{ id: number }>(`INSERT INTO tenants (slug, name) VALUES ($1, $2) RETURNING id`, [slugA, "Approval Test"]);
  tenantId = t[0].id;

  // happy path
  const { draftId } = await createDraft({ tenantId, agent: "marketing", channel: "x", content: "hello world" });
  await approveDraft(draftId);
  await scheduleDraft(draftId);
  await markPosted(draftId, "ext-1");
  const rows = await listDraftsByTenant(tenantId);
  check("happy path ends posted", rows.length >= 1 && rows.find((r) => r.id === draftId)?.status === "posted");
  const out = await query<{ channel: string }>("SELECT channel FROM outbox WHERE draft_id = $1", [draftId]);
  check("outbox row written", out.length === 1 && out[0].channel === "x");
  check("createDraft returns numeric id", typeof draftId === "number" && Number.isInteger(draftId));

  // reject path persists review notes + approvals audit row
  const { draftId: d2 } = await createDraft({ tenantId, agent: "sales", channel: "email", content: "pitch" });
  await rejectDraft(d2, "wrong tone");
  const r2 = await listDraftsByTenant(tenantId, "rejected");
  const d2row = r2.find((r) => r.id === d2);
  check("reject path persists comment", d2row?.status === "rejected" && d2row?.review_notes === "wrong tone");
  const apr = await query<{ decision: string; comment: string }>("SELECT decision, comment FROM approvals WHERE draft_id = $1", [d2]);
  check("approval row recorded", apr.length === 1 && apr[0].decision === "rejected" && apr[0].comment === "wrong tone");

  // API-level FSM enforcement: illegal calls must throw and leave state untouched
  const { draftId: d3 } = await createDraft({ tenantId, agent: "marketing", channel: "x", content: "never should post" });
  let ePostFromPending = "";
  try { await markPosted(d3, "nope"); } catch (e) { ePostFromPending = (e as Error).message; }
  check("publish before approved rejected", ePostFromPending.includes("illegal"), ePostFromPending);
  let eSchedFromPending = "";
  try { await scheduleDraft(d3); } catch (e) { eSchedFromPending = (e as Error).message; }
  check("schedule from pending rejected", eSchedFromPending.includes("illegal"), eSchedFromPending);
  check("draft still pending after illegal calls",
    (await listDraftsByTenant(tenantId, "pending")).find((r) => r.id === d3)?.status === "pending");

  await approveDraft(d3);
  let eDoubleApprove = "";
  try { await approveDraft(d3); } catch (e) { eDoubleApprove = (e as Error).message; }
  check("double approve rejected", eDoubleApprove.includes("illegal"), eDoubleApprove);
  check("double approve wrote no extra approval row",
    (await query<{ n: string }>("SELECT count(*)::text AS n FROM approvals WHERE draft_id = $1", [d3]))[0].n === "1");

  const { draftId: d4 } = await createDraft({ tenantId, agent: "sales", channel: "email", content: "rejected then abused" });
  await rejectDraft(d4, "no");
  let eApproveAfterReject = "";
  try { await approveDraft(d4); } catch (e) { eApproveAfterReject = (e as Error).message; }
  check("approve after reject rejected", eApproveAfterReject.includes("illegal"), eApproveAfterReject);
  let ePostAfterReject = "";
  try { await markPosted(d4, "sneaky"); } catch (e) { ePostAfterReject = (e as Error).message; }
  check("publish after reject rejected", ePostAfterReject.includes("illegal"), ePostAfterReject);
  check("rejected draft cannot be resurrected",
    (await listDraftsByTenant(tenantId, "rejected")).find((r) => r.id === d4)?.status === "rejected");

  // failed path: scheduled -> failed writes a failed outbox row
  const { draftId: d5 } = await createDraft({ tenantId, agent: "marketing", channel: "linkedin", content: "will fail" });
  await approveDraft(d5);
  await scheduleDraft(d5);
  await markFailed(d5, "channel auth expired");
  const d5row = (await listDraftsByTenant(tenantId, "failed")).find((r) => r.id === d5);
  check("failed path: draft marked failed",
    d5row?.status === "failed" &&
    (await query<{ status: string }>("SELECT status FROM outbox WHERE draft_id = $1", [d5]))[0].status === "failed");

  // tenant scoping: tenant A must never see tenant B's drafts
  const tb = await query<{ id: number }>(`INSERT INTO tenants (slug, name) VALUES ($1, $2) RETURNING id`, [slugB, "Scope Test B"]);
  tidB = tb[0].id;
  await createDraft({ tenantId: tidB, agent: "marketing", channel: "x", content: "tenant B secret" });
  const bIds = new Set((await query<{ id: number }>("SELECT id FROM drafts WHERE tenant_id = $1", [tidB])).map((r) => r.id));
  check("tenant A never sees tenant B drafts",
    bIds.size === 1 && (await listDraftsByTenant(tenantId)).every((r) => !bIds.has(r.id)) &&
    (await listDraftsByTenant(tenantId, "pending")).every((r) => !bIds.has(r.id)));
  check("tenant B list contains only its own drafts",
    (await listDraftsByTenant(tidB)).every((r) => r.tenant_id === tidB));
} finally {
  if (tenantId !== undefined) await query("DELETE FROM tenants WHERE id = $1", [tenantId]);
  if (tidB !== undefined) await query("DELETE FROM tenants WHERE id = $1", [tidB]);
}

if (failures > 0) { console.error(`${failures} FAIL`); process.exit(1); }
console.log("APPROVAL SUITE PASS");