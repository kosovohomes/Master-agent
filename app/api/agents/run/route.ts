import { NextResponse } from "next/server";
import { dispatch, getTenantConfig, AgentNotRunnableError } from "@/lib/agents/dispatch";
import { ai, BudgetExceededError, LlmProviderError, LlmRateLimitedError } from "@/lib/ai";
import { hybridRetrieve } from "@/lib/knowledge/retrieve";
import { sessionOrLegacyBearer } from "@/lib/auth/guards";
import { rateLimit, clientIp, hitDailyLlmCap } from "@/lib/security/ratelimit";
import { isFlagEnabled } from "@/lib/settings";
import { writeAudit, requestIdFor } from "@/lib/audit";
import type { AgentGoal } from "@/lib/agents/types";

export const runtime = "nodejs";

/**
 * POST /api/agents/run — agent execution trigger.
 *
 * Phase 1 M0 (SEC-C2): was unauthenticated (unbounded OpenAI spend +
 * approval-queue spam for any tenant). Now fail-closed: session holding
 * agents.run, or legacy bearer during the flag-gated transition window.
 * Layers: per-IP rate limit -> auth -> emergency stop_all_agents flag ->
 * per-tenant daily LLM cap -> execution. Every denial and success is audited.
 */
export async function POST(req: Request) {
  const requestId = requestIdFor(req);
  const ip = clientIp(req);

  const rl = await rateLimit(`agents-run:${ip}`, 5, 60 * 1000);
  if (!rl.allowed) {
    await writeAudit({ actorType: "anonymous", actorLabel: "ip", action: "agents.run", resource: "agent_runs", result: "denied", requestId, ip, metadata: { reason: "rate_limited" } });
    return NextResponse.json({ errors: [{ code: "RATE_LIMITED" }] }, { status: 429, headers: { "Retry-After": String(rl.retryAfterSec) } });
  }

  const gate = await sessionOrLegacyBearer(req, "agents.run");
  if (!gate.ok) {
    await writeAudit({ actorType: "anonymous", actorLabel: "ip", action: "agents.run", resource: "agent_runs", result: "denied", requestId, ip, metadata: { reason: "unauthorized" } });
    return gate.response;
  }

  let body: Partial<AgentGoal>;
  try {
    body = (await req.json()) as Partial<AgentGoal>;
  } catch {
    return NextResponse.json({ errors: [{ code: "INVALID_JSON" }] }, { status: 400 });
  }
  if (!Number.isInteger(body.tenantId)) {
    return NextResponse.json({ errors: [{ code: "INVALID_TENANT" }] }, { status: 400 });
  }

  if (await isFlagEnabled("stop_all_agents", false)) {
    await writeAudit({ actorType: gate.ctx.user ? "user" : "system", actorId: gate.ctx.user?.id ?? null, action: "agents.run", resource: "agent_runs", result: "denied", requestId, ip, metadata: { reason: "stop_all_agents", tenantId: body.tenantId } });
    return NextResponse.json({ errors: [{ code: "AGENTS_STOPPED" }] }, { status: 503 });
  }

  const cap = await hitDailyLlmCap(body.tenantId as number);
  if (!cap.allowed) {
    await writeAudit({ actorType: gate.ctx.user ? "user" : "system", actorId: gate.ctx.user?.id ?? null, action: "agents.run", resource: "agent_runs", result: "denied", requestId, ip, metadata: { reason: "daily_llm_cap", tenantId: body.tenantId, used: cap.used, cap: cap.cap } });
    return NextResponse.json({ errors: [{ code: "DAILY_LLM_CAP_REACHED" }] }, { status: 429, headers: { "Retry-After": "3600" } });
  }

  try {
    // Phase 5: knowledge_v2 ON → research runs ground their briefs in scoped
    // knowledge and the response + run row carry tier'd citations. OFF → the
    // retriever is not passed and dispatch behaves exactly as in Phase 4.
    const retrieveKnowledge = (await isFlagEnabled("knowledge_v2", false))
      ? (p: { businessUnitId: number | null; agentSlug: string; query: string; topK?: number }) =>
          hybridRetrieve(ai, { scope: p, query: p.query, topK: p.topK ?? 5 })
      : undefined;
    const result = await dispatch({ llm: ai, getConfig: getTenantConfig, retrieveKnowledge }, {
      tenantId: body.tenantId as number,
      topic: String(body.topic ?? ""),
      channel: String(body.channel ?? ""),
      context: body.context,
    });
    await writeAudit({
      actorType: gate.ctx.user ? "user" : "system",
      actorId: gate.ctx.user?.id ?? null,
      actorLabel: gate.ctx.user ? undefined : "ops:bearer",
      action: "agents.run",
      resource: "agent_runs",
      resourceId: result.runId,
      result: "success",
      requestId,
      ip,
      metadata: { tenantId: body.tenantId, agent: result.agent, via: gate.ctx.via },
    });
    return NextResponse.json({ data: result, meta: { ts: new Date().toISOString(), requestId } });
  } catch (e) {
    if (e instanceof AgentNotRunnableError) {
      // Registry refusal (disabled / BU-disabled / kill-switch / no executor):
      // an expected, audited 409 — not an internal error.
      await writeAudit({ actorType: gate.ctx.user ? "user" : "system", actorId: gate.ctx.user?.id ?? null, action: "agents.run", resource: "agent_runs", result: "denied", requestId, ip, metadata: { tenantId: body.tenantId, reason: e.code } });
      return NextResponse.json({ errors: [{ code: "AGENT_NOT_RUNNABLE", detail: e.code }] }, { status: 409 });
    }
    if (e instanceof BudgetExceededError) {
      // Phase 4 (SEC-L9): spend budget hard-stop — expected, audited 429.
      await writeAudit({ actorType: gate.ctx.user ? "user" : "system", actorId: gate.ctx.user?.id ?? null, action: "agents.run", resource: "agent_runs", result: "denied", requestId, ip, metadata: { tenantId: body.tenantId, reason: "budget_exceeded", scope: `${e.scopeType}#${e.scopeId}`, period: e.period, limitUsd: e.limitUsd, spentUsd: e.spentUsd } });
      return NextResponse.json({ errors: [{ code: "BUDGET_EXCEEDED", detail: { scope: `${e.scopeType}#${e.scopeId}`, period: e.period, limitUsd: e.limitUsd, spentUsd: e.spentUsd } }] }, { status: 429 });
    }
    if (e instanceof LlmRateLimitedError) {
      await writeAudit({ actorType: gate.ctx.user ? "user" : "system", actorId: gate.ctx.user?.id ?? null, action: "agents.run", resource: "agent_runs", result: "denied", requestId, ip, metadata: { tenantId: body.tenantId, reason: "llm_rate_limited" } });
      return NextResponse.json({ errors: [{ code: "LLM_RATE_LIMITED" }] }, { status: 429, headers: { "Retry-After": String(e.retryAfterSec) } });
    }
    if (e instanceof LlmProviderError) {
      // Every model attempt failed (incl. provider quota) — 502, ledgered in
      // llm_requests by the gateway; run recorded failed by dispatch.
      await writeAudit({ actorType: gate.ctx.user ? "user" : "system", actorId: gate.ctx.user?.id ?? null, action: "agents.run", resource: "agent_runs", result: "failure", requestId, ip, metadata: { tenantId: body.tenantId, reason: "provider_failed", attempts: e.attempts.length } });
      return NextResponse.json({ errors: [{ code: "PROVIDER_FAILED", detail: `all ${e.attempts.length} model attempt(s) failed` }] }, { status: 502 });
    }
    await writeAudit({ actorType: gate.ctx.user ? "user" : "system", actorId: gate.ctx.user?.id ?? null, action: "agents.run", resource: "agent_runs", result: "failure", requestId, ip, metadata: { tenantId: body.tenantId } });
    return NextResponse.json({ errors: [{ code: "DISPATCH_FAILED", detail: "internal error" }] }, { status: 500 });
  }
}
