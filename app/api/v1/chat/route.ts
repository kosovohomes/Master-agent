import { NextResponse } from "next/server";
import { ai, BudgetExceededError } from "@/lib/ai";
import { query } from "@/lib/db";
import { retrieve } from "@/lib/rag/retrieve";
import { getTenantConfig } from "@/lib/agents/dispatch";
import { buIdForLegacyTenant } from "@/lib/agents/registry";
import { answerChat } from "@/lib/agents/chat";
import { rateLimit, clientIp, hitDailyLlmCap } from "@/lib/security/ratelimit";
import { isFlagEnabled } from "@/lib/settings";
import { writeAudit, requestIdFor } from "@/lib/audit";

export const runtime = "nodejs";

/**
 * POST /api/v1/chat — public widget chat.
 *
 * Phase 1 M0 (SEC-C3): the widget is public by design, so this endpoint
 * cannot be auth-walled. Mitigations shipped now: per-IP rate limit,
 * per-tenant daily LLM cap, and the stop_all_agents emergency flag.
 * The x-agentos-site-key embed-token hook is accepted and verified when
 * present (site binding itself is the Phase 11 treatment). Answer-length and
 * depth caps live in answerChat; deny results are audited, successes are not
 * (public endpoint volume).
 */
export async function POST(req: Request) {
  const requestId = requestIdFor(req);
  const ip = clientIp(req);

  const rl = await rateLimit(`chat:${ip}`, 10, 60 * 1000);
  if (!rl.allowed) {
    await writeAudit({ actorType: "anonymous", actorLabel: "ip", action: "chat.answer", resource: "chat", result: "denied", requestId, ip, metadata: { reason: "rate_limited" } });
    return NextResponse.json({ errors: [{ code: "RATE_LIMITED" }] }, { status: 429, headers: { "Retry-After": String(rl.retryAfterSec) } });
  }

  let body: { tenantId?: number; question?: string; siteKey?: string };
  try {
    body = (await req.json()) as typeof body;
  } catch {
    return NextResponse.json({ errors: [{ code: "INVALID_JSON" }] }, { status: 400 });
  }
  if (!Number.isInteger(body.tenantId) || typeof body.question !== "string" || body.question.trim() === "") {
    return NextResponse.json({ errors: [{ code: "INVALID_CHAT_INPUT" }] }, { status: 400 });
  }

  // Embed-token verification hook: when a caller presents a site key it must
  // resolve to an active widget integration of this tenant's website. Absent
  // keys remain accepted during the transition (legacy embeds predate keys).
  const siteKey = req.headers.get("x-agentos-site-key") ?? (typeof body.siteKey === "string" ? body.siteKey : null);
  if (siteKey && !(await verifySiteKey(body.tenantId as number, siteKey))) {
    await writeAudit({ actorType: "anonymous", actorLabel: "ip", action: "chat.answer", resource: "chat", result: "denied", requestId, ip, metadata: { reason: "invalid_site_key", tenantId: body.tenantId } });
    return NextResponse.json({ errors: [{ code: "INVALID_SITE_KEY" }] }, { status: 401 });
  }

  if (await isFlagEnabled("stop_all_agents", false)) {
    await writeAudit({ actorType: "anonymous", actorLabel: "ip", action: "chat.answer", resource: "chat", result: "denied", requestId, ip, metadata: { reason: "stop_all_agents", tenantId: body.tenantId } });
    return NextResponse.json({ errors: [{ code: "AGENTS_STOPPED" }] }, { status: 503 });
  }

  const cap = await hitDailyLlmCap(body.tenantId as number);
  if (!cap.allowed) {
    await writeAudit({ actorType: "anonymous", actorLabel: "ip", action: "chat.answer", resource: "chat", result: "denied", requestId, ip, metadata: { reason: "daily_llm_cap", tenantId: body.tenantId, used: cap.used, cap: cap.cap } });
    return NextResponse.json({ errors: [{ code: "DAILY_LLM_CAP_REACHED" }] }, { status: 429, headers: { "Retry-After": "3600" } });
  }

  try {
    const config = await getTenantConfig(body.tenantId as number);
    // Phase 4: the widget path rides the gateway with BU attribution — chat
    // answers AND retrieval embeddings are ledgered and budget-enforced.
    const buId = await buIdForLegacyTenant(body.tenantId as number).catch(() => null);
    const chatLlm = ai.withAttribution({ businessUnitId: buId, purpose: "chat_answer" });
    const result = await answerChat({
      llm: chatLlm,
      retrieve: (p) => retrieve({ embed: (texts) => chatLlm.embed(texts) }, p),
    }, {
      tenantId: body.tenantId as number,
      question: body.question.trim(),
      config,
    });
    return NextResponse.json({ data: result, meta: { ts: new Date().toISOString(), requestId } });
  } catch (e) {
    if (e instanceof BudgetExceededError) {
      // Public endpoint: a hard-stop is a capacity signal, not an internal error.
      await writeAudit({ actorType: "anonymous", actorLabel: "ip", action: "chat.answer", resource: "chat", result: "denied", requestId, ip, metadata: { reason: "budget_exceeded", tenantId: body.tenantId, scope: `${e.scopeType}#${e.scopeId}` } });
      return NextResponse.json({ errors: [{ code: "BUDGET_EXCEEDED" }] }, { status: 429 });
    }
    return NextResponse.json({ errors: [{ code: "CHAT_FAILED", detail: "internal error" }] }, { status: 500 });
  }
}

/**
 * M0 hook: a presented site key must match an active widget integration for
 * one of the tenant's websites (via business_units.legacy_tenant_id).
 * Returns false only for keys that do NOT resolve; absent keys never reach
 * this check (handled by the caller). Full site binding is Phase 11.
 */
async function verifySiteKey(tenantId: number, siteKey: string): Promise<boolean> {
  try {
    const rows = await query<{ n: number }>(
      `SELECT count(*)::int AS n
       FROM website_integrations wi
       JOIN websites w ON w.id = wi.website_id
       JOIN business_units bu ON bu.id = w.business_unit_id
       WHERE bu.legacy_tenant_id = $1
         AND wi.integration_type = 'widget'
         AND wi.status = 'active'
         AND wi.config->>'siteKey' = $2`,
      [tenantId, siteKey]
    );
    return rows[0].n > 0;
  } catch {
    return false;
  }
}
