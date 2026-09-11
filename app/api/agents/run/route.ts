import { NextResponse } from "next/server";
import { dispatch, getTenantConfig } from "@/lib/agents/dispatch";
import { llm } from "@/lib/llm";
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

  const rl = rateLimit(`agents-run:${ip}`, 5, 60 * 1000);
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
    const result = await dispatch({ llm, getConfig: getTenantConfig }, {
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
  } catch {
    await writeAudit({ actorType: gate.ctx.user ? "user" : "system", actorId: gate.ctx.user?.id ?? null, action: "agents.run", resource: "agent_runs", result: "failure", requestId, ip, metadata: { tenantId: body.tenantId } });
    return NextResponse.json({ errors: [{ code: "DISPATCH_FAILED", detail: "internal error" }] }, { status: 500 });
  }
}
