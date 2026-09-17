import { NextResponse } from "next/server";
import { BudgetExceededError } from "@/lib/ai";
import { buIdForLegacyTenant } from "@/lib/agents/registry";
import { createInquiry, resolveSiteKey } from "@/lib/sales/service";
import { processInquiry } from "@/lib/sales/tasks";
import { rateLimit, clientIp, hitDailyLlmCap } from "@/lib/security/ratelimit";
import { isFlagEnabled } from "@/lib/settings";
import { writeAudit, requestIdFor } from "@/lib/audit";
import { emitEvent } from "@/lib/tasks/events";

export const runtime = "nodejs";

/**
 * POST /api/v1/inquiries — public inquiry intake (§139 MVP use case #3).
 *
 * The widget's "request follow-up" affordance posts here (and email/manual
 * sources land via the admin API). The record is classified IMMEDIATELY
 * (§55): LLM leg when the `sales` flag is ON (degrading to the deterministic
 * floor on any gateway failure — intake never blocks on the LLM), scored
 * into a lead when a dedupable email exists, and ESCALATED when urgency is
 * high or the lead is hot — the escalation event pages ops (RULES).
 *
 * Security envelope (SEC-C3, mirrors the chat route): per-IP rate limit
 * (tighter — this endpoint creates records), per-tenant daily LLM cap,
 * stop_all_agents, site-key resolution (§13 connector #1), input length
 * caps, honeypot discard, denied results audited.
 */
export async function POST(req: Request) {
  const requestId = requestIdFor(req);
  const ip = clientIp(req);

  const rl = await rateLimit(`inquiries:${ip}`, 5, 10 * 60 * 1000);
  if (!rl.allowed) {
    await writeAudit({ actorType: "anonymous", actorLabel: "ip", action: "sales.inquiry.create", resource: "inquiries", result: "denied", requestId, ip, metadata: { reason: "rate_limited" } });
    return NextResponse.json({ errors: [{ code: "RATE_LIMITED" }] }, { status: 429, headers: { "Retry-After": String(rl.retryAfterSec) } });
  }

  let body: {
    tenantId?: number;
    siteKey?: string;
    name?: string;
    email?: string;
    subject?: string;
    body?: string;
    conversationId?: number;
    visitorId?: string;
    website?: string; // honeypot — must stay empty
  };
  try {
    body = (await req.json()) as typeof body;
  } catch {
    return NextResponse.json({ errors: [{ code: "INVALID_JSON" }] }, { status: 400 });
  }
  if (typeof body.body !== "string" || body.body.trim() === "" || body.body.length > 5000) {
    return NextResponse.json({ errors: [{ code: "INVALID_INQUIRY_INPUT", detail: "body" }] }, { status: 400 });
  }
  if (body.email !== undefined && (typeof body.email !== "string" || body.email.length > 320 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(body.email))) {
    return NextResponse.json({ errors: [{ code: "INVALID_INQUIRY_INPUT", detail: "email" }] }, { status: 400 });
  }
  if (body.name !== undefined && (typeof body.name !== "string" || body.name.length > 200)) {
    return NextResponse.json({ errors: [{ code: "INVALID_INQUIRY_INPUT", detail: "name" }] }, { status: 400 });
  }
  if (body.subject !== undefined && (typeof body.subject !== "string" || body.subject.length > 300)) {
    return NextResponse.json({ errors: [{ code: "INVALID_INQUIRY_INPUT", detail: "subject" }] }, { status: 400 });
  }
  if (body.conversationId !== undefined && (!Number.isInteger(body.conversationId) || (body.conversationId as number) <= 0)) {
    return NextResponse.json({ errors: [{ code: "INVALID_INQUIRY_INPUT", detail: "conversationId" }] }, { status: 400 });
  }

  // Honeypot: real users never fill the hidden website field. Discard
  // silently (audited) — do not confirm bot detection to the client.
  if (typeof body.website === "string" && body.website.trim() !== "") {
    await writeAudit({ actorType: "anonymous", actorLabel: "ip", action: "sales.inquiry.create", resource: "inquiries", result: "denied", requestId, ip, metadata: { reason: "honeypot" } });
    return NextResponse.json({ data: { inquiryId: null }, meta: { ts: new Date().toISOString(), requestId } });
  }

  // Site registration (§13): key resolves to website+BU; legacy embeds pass
  // tenantId. One of the two must resolve to a business unit.
  const siteKey = req.headers.get("x-agentos-site-key") ?? (typeof body.siteKey === "string" ? body.siteKey : null);
  let websiteId: number | null = null;
  let tenantId = Number.isInteger(body.tenantId) ? (body.tenantId as number) : null;
  if (siteKey) {
    const site = await resolveSiteKey(siteKey).catch(() => null);
    if (!site || (tenantId !== null && site.legacyTenantId !== tenantId)) {
      await writeAudit({ actorType: "anonymous", actorLabel: "ip", action: "sales.inquiry.create", resource: "inquiries", result: "denied", requestId, ip, metadata: { reason: "invalid_site_key", tenantId: body.tenantId ?? null } });
      return NextResponse.json({ errors: [{ code: "INVALID_SITE_KEY" }] }, { status: 401 });
    }
    websiteId = site.websiteId;
    tenantId = site.legacyTenantId;
  }
  if (tenantId === null) {
    return NextResponse.json({ errors: [{ code: "INVALID_INQUIRY_INPUT" }] }, { status: 400 });
  }
  const buId = await buIdForLegacyTenant(tenantId).catch(() => null);
  if (buId === null) {
    return NextResponse.json({ errors: [{ code: "INVALID_TENANT" }] }, { status: 400 });
  }

  if (await isFlagEnabled("stop_all_agents", false)) {
    await writeAudit({ actorType: "anonymous", actorLabel: "ip", action: "sales.inquiry.create", resource: "inquiries", result: "denied", requestId, ip, metadata: { reason: "stop_all_agents", tenantId } });
    return NextResponse.json({ errors: [{ code: "AGENTS_STOPPED" }] }, { status: 503 });
  }

  const cap = await hitDailyLlmCap(tenantId);
  if (!cap.allowed) {
    await writeAudit({ actorType: "anonymous", actorLabel: "ip", action: "sales.inquiry.create", resource: "inquiries", result: "denied", requestId, ip, metadata: { reason: "daily_llm_cap", tenantId } });
    return NextResponse.json({ errors: [{ code: "DAILY_LLM_CAP_REACHED" }] }, { status: 429, headers: { "Retry-After": "3600" } });
  }

  try {
    const inquiry = await createInquiry({
      businessUnitId: buId,
      conversationId: body.conversationId ?? null,
      websiteId,
      name: body.name ?? null,
      email: body.email ?? null,
      subject: body.subject ?? null,
      body: body.body.trim(),
      source: "widget",
      metadata: { visitorId: body.visitorId?.slice(0, 64) ?? null, ip_hash: undefined },
    });
    await emitEvent(buId, "sales.inquiry_created", {
      inquiryId: inquiry.id,
      source: "widget",
      websiteId,
    });

    // Immediate §55 classification (LLM leg flag-gated; degrades inside).
    // Gateway attribution purpose="sales" — ledgered + budget-enforced.
    const allowLlm = await isFlagEnabled("sales", false);
    let outcome: Awaited<ReturnType<typeof processInquiry>> | null = null;
    try {
      const { ai } = await import("@/lib/ai");
      const salesLlm = ai.withAttribution({ businessUnitId: buId, purpose: "sales" });
      outcome = await processInquiry(inquiry.id, { llm: salesLlm, allowLlm });
    } catch {
      /* classification is best-effort at intake; the classify API can re-run */
    }

    return NextResponse.json({
      data: {
        inquiryId: inquiry.id,
        status: outcome ? "classified" : inquiry.status,
        escalated: outcome?.escalated ?? false,
      },
      meta: { ts: new Date().toISOString(), requestId },
    });
  } catch (e) {
    if (e instanceof BudgetExceededError) {
      await writeAudit({ actorType: "anonymous", actorLabel: "ip", action: "sales.inquiry.create", resource: "inquiries", result: "denied", requestId, ip, metadata: { reason: "budget_exceeded", tenantId } });
      return NextResponse.json({ errors: [{ code: "BUDGET_EXCEEDED" }] }, { status: 429 });
    }
    return NextResponse.json({ errors: [{ code: "INQUIRY_FAILED", detail: "internal error" }] }, { status: 500 });
  }
}
