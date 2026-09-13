/**
 * Phase 8 — content lifecycle (pure, no DB): the §60 nine-state transition
 * table, the §5.1 drafts state map, the fact-check → risk mapping, and the
 * structured-output schemas. These are the invariants every DB suite and
 * route relies on.
 */
import {
  LIFECYCLE_STATES,
  LIFECYCLE_FLOW,
  canTransition,
  DRAFT_STATE_MAP,
  riskFromFactCheck,
  CONTENT_PLAN_SCHEMA,
  CONTENT_DRAFT_SCHEMA,
  FACT_CHECK_SCHEMA,
  type ContentLifecycle,
} from "../lib/content/types";

let failures = 0;
function check(name: string, cond: boolean, detail = "") {
  console.log(`${cond ? "PASS" : "FAIL"} ${name}${detail ? " :: " + detail : ""}`);
  if (!cond) failures++;
}

// ---------- §60: exactly nine states ----------
check("lifecycle: exactly 9 states", LIFECYCLE_STATES.length === 9);
check(
  "lifecycle: canonical order",
  LIFECYCLE_STATES.join(",") === "IDEA,RESEARCHING,DRAFT,FACT_CHECK,REVIEW,APPROVED,SCHEDULED,PUBLISHED,ARCHIVED"
);
check("lifecycle: flow covers every state", Object.keys(LIFECYCLE_FLOW).length === 9);

// ---------- forward paths ----------
check("lifecycle: happy path traverses", (() => {
  const path: ContentLifecycle[] = ["IDEA", "RESEARCHING", "DRAFT", "FACT_CHECK", "REVIEW", "APPROVED", "SCHEDULED", "PUBLISHED"];
  for (let i = 0; i < path.length - 1; i++) {
    if (!canTransition(path[i], path[i + 1])) return false;
  }
  return true;
})());
check("lifecycle: IDEA → RESEARCHING allowed", canTransition("IDEA", "RESEARCHING"));
check("lifecycle: DRAFT → REVIEW allowed (human-first path)", canTransition("DRAFT", "REVIEW"));
check("lifecycle: FACT_CHECK → REVIEW allowed", canTransition("FACT_CHECK", "REVIEW"));
check("lifecycle: FACT_CHECK → DRAFT allowed (rework)", canTransition("FACT_CHECK", "DRAFT"));
check("lifecycle: REVIEW → APPROVED allowed", canTransition("REVIEW", "APPROVED"));
check("lifecycle: REVIEW → DRAFT allowed (request changes)", canTransition("REVIEW", "DRAFT"));
check("lifecycle: APPROVED → SCHEDULED/PUBLISHED allowed", canTransition("APPROVED", "SCHEDULED") && canTransition("APPROVED", "PUBLISHED"));
check("lifecycle: PUBLISHED → ARCHIVED allowed", canTransition("PUBLISHED", "ARCHIVED"));

// ---------- guard rails ----------
check("lifecycle: skip states forbidden (IDEA → DRAFT)", !canTransition("IDEA", "DRAFT"));
check("lifecycle: skip states forbidden (DRAFT → APPROVED)", !canTransition("DRAFT", "APPROVED"));
check("lifecycle: skip states forbidden (REVIEW → PUBLISHED)", !canTransition("REVIEW", "PUBLISHED"));
check("lifecycle: APPROVED cannot go back to DRAFT", !canTransition("APPROVED", "DRAFT"));
check("lifecycle: PUBLISHED cannot restart", !canTransition("PUBLISHED", "DRAFT"));
check("lifecycle: ARCHIVED is terminal", LIFECYCLE_FLOW.ARCHIVED.length === 0 && !canTransition("ARCHIVED", "IDEA"));
check("lifecycle: every state can archive (except ARCHIVED itself)", LIFECYCLE_STATES.filter((s) => s !== "ARCHIVED").every((s) => canTransition(s, "ARCHIVED")));
check("lifecycle: no self-transitions", LIFECYCLE_STATES.every((s) => !canTransition(s, s)));
check("lifecycle: unknown state safe", !canTransition("NOPE" as ContentLifecycle, "DRAFT"));

// ---------- §5.1 drafts state map (documented mapping) ----------
check("state map: pending→DRAFT", DRAFT_STATE_MAP.pending === "DRAFT");
check("state map: approved→APPROVED", DRAFT_STATE_MAP.approved === "APPROVED");
check("state map: scheduled→SCHEDULED", DRAFT_STATE_MAP.scheduled === "SCHEDULED");
check("state map: posted→PUBLISHED", DRAFT_STATE_MAP.posted === "PUBLISHED");
check("state map: failed→PUBLISHED (failure recorded in publications ledger)", DRAFT_STATE_MAP.failed === "PUBLISHED");
check("state map: rejected→REVIEW", DRAFT_STATE_MAP.rejected === "REVIEW");
check("state map: every legacy status mapped", Object.keys(DRAFT_STATE_MAP).length === 6);

// ---------- fact-check → risk mapping ----------
check("risk: pass → low", riskFromFactCheck("pass") === "low");
check("risk: warnings → medium", riskFromFactCheck("warnings") === "medium");
check("risk: fail → high", riskFromFactCheck("fail") === "high");

// ---------- schemas ----------
check("schema: plan requires angle/audience/keyMessages/outline/ambiguous", JSON.stringify((CONTENT_PLAN_SCHEMA as { required: string[] }).required) === JSON.stringify(["angle", "audience", "keyMessages", "outline", "ambiguous"]));
check("schema: draft requires title/body", JSON.stringify((CONTENT_DRAFT_SCHEMA as { required: string[] }).required) === JSON.stringify(["title", "body"]));
check("schema: fact-check requires status/claims/summary", JSON.stringify((FACT_CHECK_SCHEMA as { required: string[] }).required) === JSON.stringify(["status", "claims", "summary"]));
check("schema: fact-check status enum", ((FACT_CHECK_SCHEMA as { properties: { status: { enum: string[] } } }).properties.status.enum).join(",") === "pass,warnings,fail");
check("schema: verdict enum", ((FACT_CHECK_SCHEMA as { properties: { claims: { items: { properties: { verdict: { enum: string[] } } } } } }).properties.claims.items.properties.verdict.enum).join(",") === "supported,unsupported,contradicted,unverifiable");

if (failures > 0) {
  console.error(`\n${failures} lifecycle check(s) FAILED`);
  process.exit(1);
}
console.log("\nAll content lifecycle checks passed.");
