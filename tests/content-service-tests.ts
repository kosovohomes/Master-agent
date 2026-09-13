/**
 * Phase 8 — content service against real Postgres: never-overwrite
 * versioning (§61), the transactional FSM (§60, incl. the concurrent-
 * decision double-click guard), approval center v2 (immutable §72 decision
 * rows + approval_actions trail), manual edits, history reads, and BU
 * isolation.
 */
import crypto from "node:crypto";
import { query, transaction } from "../lib/db";
import {
  createItem,
  getItem,
  listItems,
  appendVersion,
  listVersions,
  getVersion,
  transitionItem,
  submitForReview,
  decideItem,
  addManualVersion,
  listApprovalsForItem,
  listActionsForItem,
  stats,
  ContentServiceError,
} from "../lib/content/service";

let failures = 0;
function check(name: string, cond: boolean, detail = "") {
  console.log(`${cond ? "PASS" : "FAIL"} ${name}${detail ? " :: " + detail : ""}`);
  if (!cond) failures++;
}

const stamp = Date.now();

async function setupBu(name: string): Promise<number> {
  const [bu] = await query<{ id: number }>(
    `INSERT INTO business_units (slug, name) VALUES ($1, $2) RETURNING id`,
    [`cnt-${name}-${stamp}`, `Content BU ${name}`]
  );
  return bu.id;
}

const buA = await setupBu("a");
const buB = await setupBu("b");

// ---------- creation ----------
const item = await createItem({ businessUnitId: buA, type: "article", title: "Housing market brief", brief: { text: "Write about housing" } });
check("create: starts at IDEA", item.lifecycle === "IDEA");
check("create: no version yet", item.currentVersionId === null);

const withBody = await createItem({ businessUnitId: buA, type: "email", body: "x".repeat(60), title: "Newsletter v1" });
check("create: body → DRAFT + version 1", withBody.lifecycle === "DRAFT" && withBody.currentVersionId !== null);

// ---------- never-overwrite versioning (§61) ----------
const v1 = await appendVersion(item.id, { title: "Housing market brief", body: "First draft of the brief.", changeNote: "chain v1" });
check("version: first is v1", v1.version === 1);
const v2 = await appendVersion(item.id, { title: "Housing market brief (rev)", body: "Second draft with more sources [1].", changeNote: "rework" });
check("version: appends to v2", v2.version === 2);
check("version: current pointer moved", (await getItem(item.id))?.currentVersionId === v2.id);
const v1After = await getVersion(item.id, 1);
check("version: v1 body UNCHANGED (never-overwrite)", v1After?.body === "First draft of the brief.");
check("version: rows are immutable records", (await listVersions(item.id)).length === 2);

// illegal: body required handled by caller; unique constraint backstop
let dupRejected = false;
try {
  await query(
    `INSERT INTO content_versions (content_item_id, version, body) VALUES ($1, 1, 'conflict')`,
    [item.id]
  );
} catch {
  dupRejected = true;
}
check("version: UNIQUE (item, version) backstop holds", dupRejected);

// ---------- transactional FSM (§60) ----------
const fsm = await createItem({ businessUnitId: buA, type: "article", title: "FSM item", brief: {} });
const fsmItem = await transitionItem(fsm.id, "RESEARCHING", { actorLabel: "test" });
check("fsm: IDEA → RESEARCHING ok", fsmItem.lifecycle === "RESEARCHING");
let illegal = false;
try { await transitionItem(fsm.id, "APPROVED"); } catch (e) { illegal = e instanceof ContentServiceError && e.code === "ILLEGAL_TRANSITION"; }
check("fsm: illegal jump rejected", illegal);
check("fsm: state unchanged after rejection", (await getItem(fsm.id))?.lifecycle === "RESEARCHING");

// concurrent double-transition: two parallel REVIEW→APPROVED, exactly one wins
const race = await createItem({ businessUnitId: buA, type: "article", title: "Race item", brief: {} });
await transitionItem(race.id, "RESEARCHING");
await transitionItem(race.id, "DRAFT");
await transitionItem(race.id, "REVIEW");
const results = await Promise.allSettled([
  transitionItem(race.id, "APPROVED", { actorLabel: "op1" }),
  transitionItem(race.id, "APPROVED", { actorLabel: "op2" }),
]);
const won = results.filter((r) => r.status === "fulfilled").length;
const lost = results.filter((r) => r.status === "rejected").length;
check("fsm: concurrent decision — exactly one wins", won === 1 && lost === 1, `won=${won} lost=${lost}`);
check("fsm: item APPROVED once", (await getItem(race.id))?.lifecycle === "APPROVED");

// ---------- approval center v2 (§72) ----------
const review = await createItem({ businessUnitId: buA, type: "social_post", title: "Review item", body: "y".repeat(80) });
await transitionItem(review.id, "REVIEW");
await submitForReview(review.id, { riskLevel: "medium", requestedAction: "publish", actorLabel: "chain" });
check("review: submit records risk on brief", ((await getItem(review.id))?.brief as { riskLevel?: string }).riskLevel === "medium");
const submitActions = await listActionsForItem(review.id);
check("review: submit lands in approval_actions", submitActions.some((a) => a.action === "submit"));

// service tolerates a missing comment (the ROUTE enforces reason-required
// for reject/request_changes) — verify no service-level validation error:
const noCommentItem = await createItem({ businessUnitId: buA, type: "article", title: "No-comment item", body: "n".repeat(80) });
await transitionItem(noCommentItem.id, "REVIEW");
const noCommented = await decideItem(noCommentItem.id, { decision: "reject", reviewerLabel: "owner@test" });
check("review: service-level reject tolerates null comment", noCommented.lifecycle === "ARCHIVED");

const approved = await decideItem(review.id, { decision: "approve", comment: "ship it", reviewerLabel: "owner@test" });
check("review: approve → APPROVED", approved.lifecycle === "APPROVED");
const approvals = await listApprovalsForItem(review.id);
check("review: immutable decision row written", approvals.length === 1 && approvals[0].decision === "approved");
check("review: risk + action recorded on decision", approvals[0].riskLevel === "medium" && approvals[0].requestedAction === "publish");
const decActions = await listActionsForItem(review.id);
check("review: approve lands in approval_actions", decActions.some((a) => a.action === "approve"));
check("review: reviewed_by stamped", (await getItem(review.id))?.reviewedBy === "owner@test");

// decision on non-REVIEW item → 409-equivalent
let notInReview = false;
try { await decideItem(review.id, { decision: "approve" }); } catch (e) { notInReview = e instanceof ContentServiceError && e.code === "NOT_IN_REVIEW"; }
check("review: second decision rejected (NOT_IN_REVIEW)", notInReview);

// request_changes → DRAFT rework loop
const rework = await createItem({ businessUnitId: buA, type: "article", title: "Rework item", body: "z".repeat(80) });
await transitionItem(rework.id, "REVIEW");
await submitForReview(rework.id, { riskLevel: "low", actorLabel: "chain" });
const reworked = await decideItem(rework.id, { decision: "request_changes", comment: "tighten the intro", reviewerLabel: "owner@test" });
check("review: request_changes → DRAFT (rework)", reworked.lifecycle === "DRAFT");
check("review: rejected decision row immutably stored", (await listApprovalsForItem(rework.id))[0].decision === "rejected");

// reject → ARCHIVED terminal
const killed = await createItem({ businessUnitId: buA, type: "article", title: "Kill item", body: "k".repeat(80) });
await transitionItem(killed.id, "REVIEW");
const archived = await decideItem(killed.id, { decision: "reject", comment: "wrong angle", reviewerLabel: "owner@test" });
check("review: reject → ARCHIVED", archived.lifecycle === "ARCHIVED");
let fromArchived = false;
try { await transitionItem(killed.id, "DRAFT"); } catch (e) { fromArchived = e instanceof ContentServiceError && e.code === "ILLEGAL_TRANSITION"; }
check("review: ARCHIVED is terminal", fromArchived);

// ---------- manual edit-before-approve ----------
const editable = await createItem({ businessUnitId: buA, type: "article", title: "Editable", body: "original body text".repeat(5) });
const manual = await addManualVersion(editable.id, { body: "human-edited body text".repeat(5), changeNote: "editor pass", actorLabel: "editor@test" });
check("edit: manual version appended", manual.version === 2 && manual.createdByAgent === "human");
check("edit: edit action recorded", (await listActionsForItem(editable.id)).some((a) => a.action === "edit" && a.actorLabel === "editor@test"));

// ---------- BU isolation ----------
const secret = await createItem({ businessUnitId: buB, type: "article", title: "BU B secret", body: "s".repeat(60) });
const inA = await listItems({ businessUnitId: buA, limit: 200 });
check("isolation: BU A list has no BU B items", inA.every((i) => i.businessUnitId === buA));
let crossBu = false;
try { await appendVersion(secret.id, { body: "cross-bu write attempt that is long enough to matter" }); crossBu = true; } catch { crossBu = false; }
check("isolation: cross-BU item still writable by id (DB-level scope is route-enforced)", crossBu); // documented: routes scope reads; writes are id-based like drafts

// ---------- stats ----------
const statRows = await stats(buA);
check("stats: per-lifecycle counts", statRows.length > 0 && statRows.every((s) => typeof s.n === "number"));

// ---------- transaction helper sanity (used by appendVersion) ----------
const txOk = await transaction(async (q) => {
  const rows = await q<{ n: number }>("SELECT 1 AS n");
  return rows[0].n === 1;
});
check("db: transaction helper healthy", txOk === true);

// cleanup lineage: nothing (rows stay for the report; BU rows are test-local)
void crypto;

if (failures > 0) {
  console.error(`\n${failures} content service check(s) FAILED`);
  process.exit(1);
}
console.log("\nAll content service checks passed.");
