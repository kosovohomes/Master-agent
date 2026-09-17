import { NextResponse } from "next/server";
import { ai, BudgetExceededError } from "@/lib/ai";
import { retrieve } from "@/lib/rag/retrieve";
import { hybridRetrieve } from "@/lib/knowledge/retrieve";
import { buIdForLegacyTenant } from "@/lib/agents/registry";
import { handleChatAnswer } from "@/lib/sales/chat-pipeline";
import { resolveSiteKey } from "@/lib/sales/service";
import { SalesServiceError } from "@/lib/sales/types";
import { rateLimit, clientIp, hitDailyLlmCap } from "@/lib/security/ratelimit";
import { isFlagEnabled } from "@/lib/settings";
import { writeAudit, requestIdFor } from "@/lib/audit";

export const runtime = "nodejs";

/**
 * POST /api/v1/chat — public widget chat.
 *
 * Phase 12 (§909): the route is now a thin FAÇADE over the task-machinery
 * implementation `handleChatAnswer` (lib/sales/chat-pipeline.ts — the same
 * function the `chat_answer` task handler runs). What the façade adds over
 * Phase 1:
 *  - conversation persistence: every turn is stored (conversations +
 *    messages); the widget can pass conversationId to continue a thread
 *    and receives it back for subsequent turns
 *  - site registration (§13 connector #1): a presented x-agentos-site-key
 *    resolves to its website via resolveSiteKey — conversations bind to
 *    the WEBSITE that emitted them, not just the tenant (§101 isolation);
 *    tenant-less embeds may authenticate by key alone
 *  - visitor_id accepted (client-generated random UUID, never a
 *    fingerprint — SEC-C3)
 *
 * Unchanged security envelope (SEC-C3, Phase 1 M0): per-IP rate limit,
 * per-tenant daily LLM cap, stop_all_agents emergency flag, gateway
 * attribution + budget enforcement on every LLM call, denied results
 * audited (successes are not — public endpoint volume).
 */
export async function POST(req: Request) {
  const requestId = requestIdFor(req);
  const ip = clientIp(req);

  const rl = await rateLimit(`chat:${ip}`, 10, 60 * 1000);
  if (!rl.allowed) {
    await writeAudit({ actorType: "anonymous", actorLabel: "ip", action: "chat.answer", resource: "chat", result: "denied", requestId, ip, metadata: { reason: "rate_limited" } });
    return NextResponse.json({ errors: [{ code: "RATE_LIMITED" }] }, { status: 429, headers: { "Retry-After": String(rl.retryAfterSec) } });
  }

  let body: {
    tenantId?: number;
    question?: string;
    siteKey?: string;
    conversationId?: number;
    visitorId?: string;
  };
  try {
    body = (await req.json()) as typeof body;
  } catch {
    return NextResponse.json({ errors: [{ code: "INVALID_JSON" }] }, { status: 400 });
  }
  if (
    (!Number.isInteger(body.tenantId) && typeof body.siteKey !== "string") ||
    typeof body.question !== "string" ||
    body.question.trim() === ""
  ) {
    return NextResponse.json({ errors: [{ code: "INVALID_CHAT_INPUT" }] }, { status: 400 });
  }
  if (body.conversationId !== undefined && (!Number.isInteger(body.conversationId) || (body.conversationId as number) <= 0)) {
    return NextResponse.json({ errors: [{ code: "INVALID_CHAT_INPUT", detail: "conversationId" }] }, { status: 400 });
  }
  if (body.visitorId !== undefined && (typeof body.visitorId !== "string" || body.visitorId.length > 64)) {
    return NextResponse.json({ errors: [{ code: "INVALID_CHAT_INPUT", detail: "visitorId" }] }, { status: 400 });
  }

  // --- site registration (§13 connector #1) ---
  // A presented site key must resolve to an active widget integration on an
  // active website. Absent keys remain accepted during the transition
  // (legacy embeds predate keys). When the key resolves, it is authoritative:
  // tenantId must agree with it (or be absent — key-only embeds), and the
  // conversation binds to the exact website.
  const siteKey = req.headers.get("x-agentos-site-key") ?? (typeof body.siteKey === "string" ? body.siteKey : null);
  let websiteId: number | null = null;
  let tenantId = Number.isInteger(body.tenantId) ? (body.tenantId as number) : null;
  if (siteKey) {
    const site = await resolveSiteKey(siteKey).catch(() => null);
    if (!site || (tenantId !== null && site.legacyTenantId !== tenantId)) {
      await writeAudit({ actorType: "anonymous", actorLabel: "ip", action: "chat.answer", resource: "chat", result: "denied", requestId, ip, metadata: { reason: "invalid_site_key", tenantId: body.tenantId ?? null } });
      return NextResponse.json({ errors: [{ code: "INVALID_SITE_KEY" }] }, { status: 401 });
    }
    websiteId = site.websiteId;
    tenantId = site.legacyTenantId;
  }
  if (tenantId === null) {
    return NextResponse.json({ errors: [{ code: "INVALID_CHAT_INPUT" }] }, { status: 400 });
  }

  if (await isFlagEnabled("stop_all_agents", false)) {
    await writeAudit({ actorType: "anonymous", actorLabel: "ip", action: "chat.answer", resource: "chat", result: "denied", requestId, ip, metadata: { reason: "stop_all_agents", tenantId } });
    return NextResponse.json({ errors: [{ code: "AGENTS_STOPPED" }] }, { status: 503 });
  }

  const cap = await hitDailyLlmCap(tenantId);
  if (!cap.allowed) {
    await writeAudit({ actorType: "anonymous", actorLabel: "ip", action: "chat.answer", resource: "chat", result: "denied", requestId, ip, metadata: { reason: "daily_llm_cap", tenantId, used: cap.used, cap: cap.cap } });
    return NextResponse.json({ errors: [{ code: "DAILY_LLM_CAP_REACHED" }] }, { status: 429, headers: { "Retry-After": "3600" } });
  }

  try {
    const buId = await buIdForLegacyTenant(tenantId).catch(() => null);
    // Phase 4: the widget path rides the gateway with BU attribution — chat
    // answers AND retrieval embeddings are ledgered and budget-enforced.
    const chatLlm = ai.withAttribution({ businessUnitId: buId, purpose: "chat_answer" });
    // Phase 5: knowledge_v2 ON → scoped hybrid retrieval (GLOBAL/BU/WEBSITE/
    // JURISDICTION/AGENT enforced, public-only for this anonymous caller,
    // keyword leg survives provider outages). OFF → legacy tenant-only path.
    const knowledgeV2 = await isFlagEnabled("knowledge_v2", false);
    const result = await handleChatAnswer(
      {
        tenantId,
        question: body.question,
        businessUnitId: buId,
        websiteId,
        conversationId: body.conversationId ?? null,
        visitorId: body.visitorId ?? null,
      },
      {
        llm: chatLlm,
        retrieve: knowledgeV2
          ? (p) =>
              hybridRetrieve(chatLlm, {
                scope: {
                  businessUnitId: buId,
                  agentSlug: "customer_support",
                  publicOnly: true,
                },
                query: p.query,
                topK: p.topK,
              })
          : (p) => retrieve({ embed: (texts) => chatLlm.embed(texts) }, p),
      }
    );
    return NextResponse.json({
      data: {
        answer: result.answer,
        sources: result.sources,
        conversationId: result.conversationId,
      },
      meta: { ts: new Date().toISOString(), requestId },
    });
  } catch (e) {
    if (e instanceof BudgetExceededError) {
      // Public endpoint: a hard-stop is a capacity signal, not an internal error.
      await writeAudit({ actorType: "anonymous", actorLabel: "ip", action: "chat.answer", resource: "chat", result: "denied", requestId, ip, metadata: { reason: "budget_exceeded", tenantId, scope: `${e.scopeType}#${e.scopeId}` } });
      return NextResponse.json({ errors: [{ code: "BUDGET_EXCEEDED" }] }, { status: 429 });
    }
    if (e instanceof SalesServiceError) {
      // Conversation isolation violations are audited (they are probing
      // signals), ordinary not-found/UX cases are not (public volume).
      if (e.code === "CONVERSATION_FORBIDDEN") {
        await writeAudit({ actorType: "anonymous", actorLabel: "ip", action: "chat.answer", resource: "chat", result: "denied", requestId, ip, metadata: { reason: "conversation_forbidden", tenantId } });
        return NextResponse.json({ errors: [{ code: "CONVERSATION_FORBIDDEN" }] }, { status: e.httpStatus });
      }
      if (e.code === "CONVERSATION_NOT_FOUND") {
        return NextResponse.json({ errors: [{ code: "CONVERSATION_NOT_FOUND" }] }, { status: e.httpStatus });
      }
    }
    return NextResponse.json({ errors: [{ code: "CHAT_FAILED", detail: "internal error" }] }, { status: 500 });
  }
}
