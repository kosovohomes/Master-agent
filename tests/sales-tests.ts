/**
 * Phase 12 — sales + customer workforce against real Postgres: inquiry FSM
 * (row-locked; terminal states refuse), lead FSM + score-ratchet upsert
 * (dedup on (bu, lower(email)); scores never regress; stages never demoted
 * by automation), conversation persistence + transcript sanitization (§65),
 * classification pipeline (deterministic floor + LLM leg incl. garbage
 * degradation + honest band derivation), escalation law (high urgency /
 * hot lead → escalated + events), chat pipeline conversation isolation
 * (§101), and site-key resolution (widget = website-registered connector).
 */
import { query } from "../lib/db";
import {
  createConversation,
  appendMessage,
  getMessages,
  closeConversation,
  createInquiry,
  getInquiry,
  transitionInquiry,
  updateInquiryClassification,
  upsertLead,
  transitionLead,
  updateLeadActions,
  resolveSiteKey,
  salesSummary,
} from "../lib/sales/service";
import {
  SalesServiceError,
  canTransitionInquiry,
  canTransitionLead,
  bandFor,
  clampScore,
  requiresEscalation,
} from "../lib/sales/types";
import {
  deterministicClassification,
  deterministicScore,
  classifyInquiryWithLLM,
  scoreLeadWithLLM,
  INQUIRY_DEFAULT_PROMPT,
  LEAD_DEFAULT_PROMPT,
} from "../lib/sales/pipeline";
import { processInquiry } from "../lib/sales/tasks";
import { handleChatAnswer } from "../lib/sales/chat-pipeline";
import { registerTaskHandler, getTaskHandler } from "../lib/tasks/handlers";
import { registerSalesHandlers } from "../lib/sales/tasks";
import type { LLMClient } from "../lib/ai/types";

let failures = 0;
function check(name: string, cond: boolean, detail = "") {
  console.log(`${cond ? "PASS" : "FAIL"} ${name}${detail ? " :: " + detail + "" : ""}`);
  if (!cond) failures++;
}

async function expectError(name: string, p: () => Promise<unknown>, code: string) {
  try {
    await p();
    check(name, false, `expected ${code}, no error thrown`);
  } catch (e) {
    const ok = e instanceof SalesServiceError && e.code === code;
    check(name, ok, ok ? "" : `expected ${code}, got ${e instanceof Error ? e.message : String(e)}`);
  }
}

const stamp = Date.now();

async function setupBu(name: string): Promise<number> {
  const [bu] = await query<{ id: number }>(
    `INSERT INTO business_units (slug, name) VALUES ($1, $2) RETURNING id`,
    [`sales-${name}-${stamp}`, `Sales BU ${name}`]
  );
  return bu.id;
}

async function setupSite(buId: number, slug: string, siteKey: string | null): Promise<number> {
  const [w] = await query<{ id: number }>(
    `INSERT INTO websites (business_unit_id, slug, name, domain) VALUES ($1, $2, $3, $4) RETURNING id`,
    [buId, `sales-site-${slug}-${stamp}`, `Sales Site ${slug}`, `https://${slug}.example.com`]
  );
  if (siteKey) {
    await query(
      `INSERT INTO website_integrations (website_id, integration_type, status, config)
       VALUES ($1, 'widget', 'active', $2::jsonb)`,
      [w.id, JSON.stringify({ siteKey })]
    );
  }
  return w.id;
}

async function setFlag(enabled: boolean) {
  await query(
    `INSERT INTO feature_flags (key, enabled, emergency, description)
     VALUES ('sales', $1, false, 'test') ON CONFLICT (key) DO UPDATE SET enabled = $1`,
    [enabled]
  );
}

const buA = await setupBu("a");
const buB = await setupBu("b");

/* ---------------- pure helpers ---------------- */
check("fsm: inquiry new→classified legal", canTransitionInquiry("new", "classified"));
check("fsm: inquiry new→escalated legal", canTransitionInquiry("new", "escalated"));
check("fsm: inquiry classified→escalated legal", canTransitionInquiry("classified", "escalated"));
check("fsm: inquiry escalated→resolved legal", canTransitionInquiry("escalated", "resolved"));
check("fsm: inquiry resolved terminal", !canTransitionInquiry("resolved", "new") && !canTransitionInquiry("resolved", "escalated"));
check("fsm: inquiry dismissed terminal", !canTransitionInquiry("dismissed", "classified"));
check("fsm: lead funnel forward", canTransitionLead("new", "qualified") && canTransitionLead("engaged", "proposal") && canTransitionLead("proposal", "won"));
check("fsm: lead skip illegal", !canTransitionLead("new", "engaged") && !canTransitionLead("qualified", "won"));
check("fsm: lead won/lost terminal", !canTransitionLead("won", "new") && !canTransitionLead("lost", "qualified"));
check("band: boundaries", bandFor(0) === "cold" && bandFor(39) === "cold" && bandFor(40) === "warm" && bandFor(69) === "warm" && bandFor(70) === "hot" && bandFor(100) === "hot");
check("clamp: NaN→0, bounds", clampScore(Number.NaN) === 0 && clampScore(-5) === 0 && clampScore(150) === 100 && clampScore(66.6) === 67);
check("escalation: high urgency", requiresEscalation({ urgency: "high", classification: "support" }, null));
check("escalation: hot band", requiresEscalation({ urgency: "low", classification: "sales" }, { band: "hot" }));
check("escalation: quiet otherwise", !requiresEscalation({ urgency: "low", classification: "general" }, { band: "cold" }));

/* ---------------- deterministic classification (honesty floor) ---------------- */
const salesDet = deterministicClassification({ body: "We want a quote for pricing on your homes — can you send a proposal?" });
check("det: sales classified", salesDet.classification === "sales" && salesDet.isLead === true && salesDet.degraded === true);
const supportDet = deterministicClassification({ body: "There is a bug — the contact form is broken and I need help." });
check("det: support classified", supportDet.classification === "support" && supportDet.isLead === false);
const spamDet = deterministicClassification({ body: "buy backlinks http://a.com http://b.com http://c.com http://d.com" });
check("det: link-stuffed spam", spamDet.classification === "spam");
const severeDet = deterministicClassification({ body: "URGENT: the site is down, this is impacting our business immediately." });
check("det: severe words → high urgency", severeDet.urgency === "high");
check("det: summary is truncation not invention", deterministicClassification({ body: "x".repeat(200) }).summary.length === 140);

/* ---------------- deterministic scoring (signal arithmetic) ---------------- */
const hotScore = deterministicScore({ body: "We need pricing and a contract with a timeline of this month.", contactEmail: "cto@acme.com", company: "Acme Ltd" });
check("det-score: email+company+intent → hot", hotScore.leadScore >= 70 && hotScore.band === "hot");
const coldScore = deterministicScore({ body: "hello" });
check("det-score: no signals → cold", coldScore.leadScore === 0 && coldScore.band === "cold");
check("det-score: bounded 0-100", deterministicScore({ body: "pricing quote contract budget demo purchase buy timeline urgent", contactEmail: "a@b.co", company: "X", contactPhone: "+12345678901" }).leadScore <= 100);

/* ---------------- conversations + §65 sanitization ---------------- */
const conv = await createConversation({ businessUnitId: buA, visitorId: "v-test-123" });
check("conv: created active widget", conv.id > 0 && conv.status === "active" && conv.channel === "widget" && conv.visitor_id === "v-test-123");
await appendMessage({ conversationId: conv.id, role: "visitor", content: "Do you build homes in Kosovo?" });
await appendMessage({ conversationId: conv.id, role: "assistant", content: "Yes — here are our service areas.", citations: [{ title: "Service areas", documentId: 1 }] });
const msgs = await getMessages(conv.id);
check("conv: transcript visitor/assistant only", msgs.length === 2 && msgs[0].role === "visitor" && msgs[1].role === "assistant");
check("conv: citations persisted", Array.isArray(msgs[1].citations) && (msgs[1].citations as Array<{ title: string }>)[0].title === "Service areas");
const closed = await closeConversation(conv.id);
check("conv: close active→closed", closed.status === "closed");
await expectError("conv: double close refused", () => closeConversation(conv.id), "NOT_FOUND");

/* ---------------- inquiries FSM ---------------- */
const inq = await createInquiry({ businessUnitId: buA, conversationId: conv.id, name: "Rana", email: `rana-${stamp}@acme.com`, body: "We want pricing for a full-home project.", source: "manual" });
check("inquiry: created new", inq.id > 0 && inq.status === "new" && inq.classification === null);
await expectError("inquiry: BU mismatch on conversation link", () => createInquiry({ businessUnitId: buB, conversationId: conv.id, body: "x" }), "BU_MISMATCH");
await expectError("inquiry: missing conversation link", () => createInquiry({ businessUnitId: buA, conversationId: 999999, body: "x" }), "CONVERSATION_NOT_FOUND");
const classified = await transitionInquiry(inq.id, "classified", { classification: "sales", urgency: "low", summary: "pricing ask", classifiedBy: "deterministic" });
check("inquiry: new→classified stamps fields", classified.classification === "sales" && classified.classified_by === "deterministic");
const escalated = await transitionInquiry(inq.id, "escalated", {});
check("inquiry: classified→escalated", escalated.status === "escalated");
const resolved = await transitionInquiry(inq.id, "resolved", {});
check("inquiry: escalated→resolved terminal", resolved.status === "resolved");
await expectError("inquiry: terminal refuses", () => transitionInquiry(inq.id, "classified", {}), "BAD_TRANSITION");
await expectError("inquiry: unknown id", () => transitionInquiry(999999, "resolved", {}), "NOT_FOUND");
const reclassTarget = await createInquiry({ businessUnitId: buA, body: "another ask" });
await transitionInquiry(reclassTarget.id, "classified", { classification: "general", classifiedBy: "deterministic" });
const re = await updateInquiryClassification(reclassTarget.id, { classification: "support", classifiedBy: "llm", metadata: { reclassified: true } });
check("inquiry: same-state refresh works", re.classification === "support" && re.classified_by === "llm");
await transitionInquiry(reclassTarget.id, "resolved", {});
await expectError("inquiry: refresh after terminal BAD_STATE", () => updateInquiryClassification(reclassTarget.id, { classification: "sales" }), "BAD_STATE");

/* ---------------- leads: ratchet upsert + human-only FSM ---------------- */
const l1 = await upsertLead({ businessUnitId: buA, inquiryId: inq.id, company: "Acme Homes", contactName: "Rana", contactEmail: `rana-${stamp}@acme.com`, leadScore: 75, scoredBy: "llm", scoreRationale: "email+intent" });
check("lead: created hot", l1.created && l1.lead.lead_score === 75 && l1.lead.score_band === "hot" && l1.lead.stage === "new");
const l2 = await upsertLead({ businessUnitId: buA, company: "Acme Homes Group", contactEmail: `RANA-${stamp}@ACME.com`, leadScore: 30, scoredBy: "deterministic" });
check("lead: case-insensitive dedup (no second row)", !l2.created && l2.lead.id === l1.lead.id);
check("lead: score ratcheted up never down", l2.lead.lead_score === 75 && l2.lead.score_band === "hot");
check("lead: contact fields COALESCE-updated", l2.lead.company === "Acme Homes Group");
const l3 = await upsertLead({ businessUnitId: buA, contactEmail: `rana-${stamp}@acme.com`, leadScore: 90, nextAction: "Call today" });
check("lead: higher score ratchets", l3.lead.lead_score === 90 && l3.lead.next_action === "Call today");
await expectError("lead: skip-stage illegal", () => transitionLead(l1.lead.id, "proposal"), "BAD_TRANSITION");
const qualified = await transitionLead(l1.lead.id, "qualified", { nextAction: "Discovery call" });
check("lead: human transition legal", qualified.stage === "qualified" && qualified.next_action === "Discovery call");
const touched = await updateLeadActions(l1.lead.id, { nextAction: "Send proposal draft" });
check("lead: next_action update without stage move", touched.stage === "qualified" && touched.next_action === "Send proposal draft");
await transitionLead(l1.lead.id, "engaged");
await transitionLead(l1.lead.id, "proposal");
const won = await transitionLead(l1.lead.id, "won");
check("lead: full funnel to won", won.stage === "won");
await expectError("lead: won terminal", () => transitionLead(l1.lead.id, "engaged"), "BAD_TRANSITION");
// email-less leads are allowed (manual walk-ins) and unconstrained by the dedup index
const noEmail1 = await upsertLead({ businessUnitId: buA, contactName: "Walk-in A", leadScore: 10 });
const noEmail2 = await upsertLead({ businessUnitId: buA, contactName: "Walk-in B", leadScore: 20 });
check("lead: NULL-email rows both created", noEmail1.created && noEmail2.created && noEmail1.lead.id !== noEmail2.lead.id);

/* ---------------- LLM legs (stub) + degradation ---------------- */
type Msg = { role: string; content: string };
function stubLlm(payload: unknown, opts: { broken?: boolean } = {}): LLMClient {
  return {
    async complete(_messages: Msg[]) {
      if (opts.broken) throw new Error("gateway down");
      return JSON.stringify(payload);
    },
    async completeWithUsage(messages: Msg[]) {
      return { content: await (this as { complete: (m: Msg[]) => Promise<string> }).complete(messages), usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 } };
    },
    async embed() { throw new Error("no embeds in test"); },
    async embedWithUsage() { throw new Error("no embeds in test"); },
  } as unknown as LLMClient;
}

const goodCls = await classifyInquiryWithLLM(
  stubLlm({ classification: "sales", urgency: "medium", summary: "wants a quote", isLead: true, company: "Acme", contactName: "Rana", contactEmail: `rana-${stamp}@acme.com`, notes: "explicit pricing ask" }),
  { version: 1, systemPrompt: INQUIRY_DEFAULT_PROMPT },
  { inquiryId: inq.id, name: "Rana", email: null, subject: null, body: "quote please", transcript: [] }
);
check("llm: classification honored", goodCls.classification === "sales" && goodCls.isLead === true && goodCls.degraded === false && goodCls.company === "Acme");
const junkCls = await classifyInquiryWithLLM(
  stubLlm({ classification: "SPACE-STAR", urgency: "MAXIMUM" }),
  { version: 1, systemPrompt: INQUIRY_DEFAULT_PROMPT },
  { inquiryId: inq.id, name: null, email: null, subject: null, body: "hello", transcript: [] }
);
check("llm: out-of-enum clamped to safe defaults", junkCls.classification === "general" && junkCls.urgency === "low" && junkCls.degraded === false);
const goodScore = await scoreLeadWithLLM(
  stubLlm({ leadScore: 85, band: "hot", nextAction: "Sign them up", rationale: "budget stated" }),
  { version: 1, systemPrompt: LEAD_DEFAULT_PROMPT },
  { body: "quote please" }
);
check("llm: score honored + rationale", goodScore.leadScore === 85 && goodScore.band === "hot" && goodScore.rationale === "budget stated");
const mismatchScore = await scoreLeadWithLLM(
  stubLlm({ leadScore: 12, band: "hot", nextAction: "x" }),
  { version: 1, systemPrompt: LEAD_DEFAULT_PROMPT },
  { body: "meh" }
);
check("llm: band DERIVED from clamped score (no manufactured hot)", mismatchScore.leadScore === 12 && mismatchScore.band === "cold");

/* ---------------- processInquiry orchestration ---------------- */
const fakeAi = stubLlm({ classification: "sales", urgency: "high", summary: "urgent bulk order", isLead: true, company: "BulkCo", contactName: "Bee", contactEmail: `bee-${stamp}@bulk.co`, notes: "urgent" });
const procInq = await createInquiry({ businessUnitId: buA, name: "Bee", email: `bee-${stamp}@bulk.co`, body: "URGENT bulk order pricing request" });
const procOutcome = await processInquiry(procInq.id, { llm: fakeAi, allowLlm: true });
check("proc: classified via llm", procOutcome.classification.degraded === false && procOutcome.classification.classification === "sales");
check("proc: lead created", procOutcome.leadCreated === true && procOutcome.leadId !== null);
check("proc: high urgency escalated", procOutcome.escalated === true);
const procRow = await getInquiry(procInq.id);
check("proc: inquiry escalated in DB", procRow?.status === "escalated");

// flag OFF → deterministic-only, no escalation from medium signals, still labeled
const proc2Inq = await createInquiry({ businessUnitId: buA, body: "just a question about opening hours" });
const proc2 = await processInquiry(proc2Inq.id, { llm: fakeAi, allowLlm: false });
check("proc: flag off → deterministic floor", proc2.classification.degraded === true);
check("proc: flag off → no escalation", proc2.escalated === false);
const proc2RowAfter = await getInquiry(proc2Inq.id);
check("proc: flag off → still classified + labeled", proc2RowAfter?.status === "classified" && proc2RowAfter?.classified_by === "deterministic");

// broken LLM → degrade, never block intake
const brokenInq = await createInquiry({ businessUnitId: buA, body: "sales question with email fallback", email: `broken-${stamp}@x.co` });
const proc3 = await processInquiry(brokenInq.id, { llm: stubLlm(null, { broken: true }), allowLlm: true });
check("proc: broken LLM degrades to deterministic", proc3.classification.degraded === true);
check("proc: deterministic sales still auto-leads", proc3.leadId !== null && proc3.score !== null && proc3.score.degraded === true);

// terminal state refuses classification
await expectError("proc: terminal inquiry refuses", () => processInquiry(reclassTarget.id, { llm: fakeAi, allowLlm: true }), "BAD_STATE");

/* ---------------- chat pipeline: persistence + isolation ---------------- */
registerSalesHandlers();
check("tasks: chat_answer registered", typeof getTaskHandler("chat_answer") === "function");

const chatLlm: LLMClient = stubLlm("Plain answer text");
const chat = await handleChatAnswer(
  { tenantId: -1, question: "what areas do you serve?", businessUnitId: buA, visitorId: "v-chat-1" },
  { llm: chatLlm, retrieve: async () => [{ chunkId: 1, documentId: 1, title: "Areas", content: "All of Kosovo." }] }
);
check("chat: created + answered + persisted", chat.created === true && chat.answer === "Plain answer text" && chat.conversationId > 0);
const chatMsgs = await getMessages(chat.conversationId);
check("chat: both turns persisted", chatMsgs.length === 2 && chatMsgs[0].content === "what areas do you serve?" && chatMsgs[1].role === "assistant");
check("chat: assistant turn carries citations", (chatMsgs[1].citations as Array<{ title: string }>)[0].title === "Areas");

const chat2 = await handleChatAnswer(
  { tenantId: -1, question: "and in Albania?", businessUnitId: buA, conversationId: chat.conversationId, visitorId: "v-chat-1" },
  { llm: chatLlm, retrieve: async () => [] }
);
check("chat: continues same conversation", chat2.created === false && chat2.conversationId === chat.conversationId);

await expectError("chat: cross-BU conversation forbidden", () =>
  handleChatAnswer(
    { tenantId: -1, question: "hijack", businessUnitId: buB, conversationId: chat.conversationId },
    { llm: chatLlm, retrieve: async () => [] }
  ), "CONVERSATION_FORBIDDEN");
await expectError("chat: unknown conversation", () =>
  handleChatAnswer(
    { tenantId: -1, question: "x", businessUnitId: buA, conversationId: 999999 },
    { llm: chatLlm, retrieve: async () => [] }
  ), "CONVERSATION_NOT_FOUND");

// closed conversation → fresh conversation (UX-friendly, not an error)
await closeConversation(chat2.conversationId);
const chat3 = await handleChatAnswer(
  { tenantId: -1, question: "new thread", businessUnitId: buA, conversationId: chat2.conversationId },
  { llm: chatLlm, retrieve: async () => [] }
);
check("chat: closed conversation starts fresh", chat3.created === true && chat3.conversationId !== chat2.conversationId);

/* ---------------- site-key resolution (connector #1) ---------------- */
const sk = `sk-test-${stamp}-abcd`;
const siteA = await setupSite(buA, "a", sk);
await setupSite(buB, "b", null);
const resolvedSite = await resolveSiteKey(sk);
check("sitekey: resolves to website+bu", resolvedSite !== null && resolvedSite.websiteId === siteA && resolvedSite.businessUnitId === buA);
check("sitekey: unknown → null", (await resolveSiteKey(`sk-nope-${stamp}`)) === null);
await query(`UPDATE website_integrations SET status = 'disabled' WHERE website_id = $1 AND integration_type = 'widget'`, [siteA]);
check("sitekey: disabled integration → null", (await resolveSiteKey(sk)) === null);
await query(`UPDATE website_integrations SET status = 'active' WHERE website_id = $1 AND integration_type = 'widget'`, [siteA]);

// chat with website binding: conversation inherits websiteId; wrong-website continuation refused
const chatW = await handleChatAnswer(
  { tenantId: -1, question: "hi", businessUnitId: buA, websiteId: siteA, visitorId: "v-site" },
  { llm: chatLlm, retrieve: async () => [] }
);
check("chat: website-bound conversation", chatW.created === true);
await expectError("chat: cross-website continuation forbidden", () =>
  handleChatAnswer(
    { tenantId: -1, question: "hijack site", businessUnitId: buA, websiteId: siteA + 1, conversationId: chatW.conversationId },
    { llm: chatLlm, retrieve: async () => [] }
  ), "CONVERSATION_FORBIDDEN");

/* ---------------- summary aggregate ---------------- */
const sumA = await salesSummary(buA);
check("summary: counts present", sumA.conversations.total >= 3 && (sumA.inquiries["escalated"] ?? 0) >= 1 && sumA.hotLeads >= 1);

/* ---------------- cleanup ---------------- */
await query(`DELETE FROM messages WHERE conversation_id IN (SELECT id FROM conversations WHERE business_unit_id IN ($1, $2))`, [buA, buB]);
await query(`DELETE FROM conversations WHERE business_unit_id IN ($1, $2)`, [buA, buB]);
await query(`DELETE FROM leads WHERE business_unit_id IN ($1, $2)`, [buA, buB]);
await query(`DELETE FROM inquiries WHERE business_unit_id IN ($1, $2)`, [buA, buB]);
await query(`DELETE FROM website_integrations WHERE website_id IN (SELECT id FROM websites WHERE business_unit_id IN ($1, $2))`, [buA, buB]);
await query(`DELETE FROM websites WHERE business_unit_id IN ($1, $2)`, [buA, buB]);
await query(`DELETE FROM business_units WHERE id IN ($1, $2)`, [buA, buB]);
await query(`DELETE FROM feature_flags WHERE key = 'sales'`);

console.log(failures === 0 ? "ALL SALES CHECKS PASS" : `FAILURES: ${failures}`);
process.exit(failures === 0 ? 0 : 1);
