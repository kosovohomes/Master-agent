/**
 * Phase 3 (§11 P3) — the three built-in task handlers.
 *
 * 1. agent_dispatch — wraps the Phase 2 registry dispatch() as the first
 *    task executor (roadmap §312). The deterministic router is promoted to
 *    an explicit CLASSIFIER step (C-16): a FALLBACK route no longer silently
 *    runs marketing — inside tasks it becomes an ESCALATION with a human
 *    notification, unless the spawn explicitly allows the legacy fallback.
 *
 * 2. publishing_sweep — Workflow #1. Zero-duplicate publishing is enforced
 *    by content_publications.idempotency_key (UNIQUE, §88): the pending row
 *    is claimed BEFORE the external side effect, so two concurrent sweeps
 *    produce exactly one publish call per draft. The outbox is no longer
 *    written (write-stop, §205); it stays as archive.
 *
 * 3. send_notification — delivers a notifications row over the email
 *    publisher (Resend). Emits NO events (loop guard).
 *
 * Handler-level dependencies (LLM client, publish transport) are injectable
 * for tests via makeAgentDispatchHandler / makePublishingSweepHandler; the
 * production registrations happen in registerBuiltins() at import time.
 */
import type { LLMClient } from "../ai/types";
import type { GatewayClient } from "../ai/gateway";
import { ai as defaultLlm } from "../ai";
import { makeKnowledgeFetchHandler } from "../knowledge/tasks";
import { knowledgeFetcher } from "../knowledge/fetchers";
import { registerResearchHandlers } from "../research/tasks";
import { registerContentHandlers } from "../content/tasks";
import { registerSeoHandlers } from "../seo/tasks";
import { dispatch, getTenantConfig } from "../agents/dispatch";
import { routeAgent } from "../agents/core";
import type { AgentGoal } from "../agents/types";
import { getPublisher, type ChannelKind, type PublishInput } from "../agents/publishers/index";
import { decryptChannelToken } from "../channels";
import { markPosted, markFailed } from "../agents/approval";
import { query } from "../db";
import { registerTaskHandler } from "./handlers";
import type { TaskHandler, TaskHandlerInput } from "./types";
import { heartbeat } from "./queue";
import { emitEvent } from "./events";

/** Thrown by handlers to park a task as ESCALATED (human attention required). */
export class TaskEscalatedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TaskEscalatedError";
  }
}

/** Thrown by handlers when a cooperative cancellation lands mid-run. */
export class TaskCancelledError extends Error {
  constructor(message = "task cancelled") {
    super(message);
    this.name = "TaskCancelledError";
  }
}

/** Shared publication idempotency key: one draft → at most one publish. */
export function publicationKey(draftId: number): string {
  return `draft:${draftId}`;
}

/* ------------------------------------------------------------------ */
/* 1. agent_dispatch                                                   */
/* ------------------------------------------------------------------ */

export interface AgentDispatchPayload extends Partial<AgentGoal> {
  /** Legacy default (manual API): FALLBACK routes still run marketing. */
  allowFallback?: boolean;
}

export function makeAgentDispatchHandler(deps: {
  llm: LLMClient;
}): TaskHandler {
  return async ({ task, step, cancelled }: TaskHandlerInput) => {
    const payload = task.payload as AgentDispatchPayload;
    const goal: AgentGoal = {
      tenantId: Number(payload.tenantId),
      topic: String(payload.topic ?? ""),
      channel: String(payload.channel ?? ""),
      context: payload.context,
    };

    // Step 1 — classify (C-16: the router is now an explicit classifier).
    let routeReason = "";
    let routeAgentSlug = "";
    let fellBack = false;
    await step("classify", async () => {
      const route = routeAgent(goal);
      routeReason = route.reason;
      routeAgentSlug = route.agent;
      fellBack = route.fallback;
      if (route.fallback && !payload.allowFallback) {
        throw new TaskEscalatedError(
          `topic "${goal.topic.slice(0, 120)}" matched no worker agent (classifier fallback to marketing suppressed inside the task engine)`
        );
      }
      return { agent: route.agent, reason: route.reason, fallback: route.fallback };
    });

    if (await cancelled()) throw new TaskCancelledError();

    // Step 2 — execute via the registry-driven dispatch (unchanged Phase 2
    // code; Phase 4 passes the task id so LLM spend attributes to the task
    // and per-task budget ceilings enforce).
    let draftId: number | null = null;
    let runId: number | null = null;
    await step("execute", async () => {
      const result = await dispatch(
        { llm: deps.llm, getConfig: getTenantConfig, attribution: { taskId: task.id } },
        goal
      );
      draftId = result.draftId;
      runId = result.runId;
      return { runId: result.runId, agent: result.agent, draftId: result.draftId };
    });

    await step("record", async () => {
      // Link the run ledger row (agent_runs) back to the durable task.
      if (runId != null) {
        await query("UPDATE tasks SET run_id = $2 WHERE id = $1", [task.id, runId]);
      }
      return { draftId, runId };
    });

    return { draftId, runId, agent: routeAgentSlug, routeReason, fallback: fellBack };
  };
}

/* ------------------------------------------------------------------ */
/* 2. publishing_sweep (Workflow #1)                                   */
/* ------------------------------------------------------------------ */

export interface SweepResult {
  due: number;
  posted: number;
  failed: number;
  skipped_draft_only: number;
  duplicates_prevented: number;
  publications: Array<{ draftId: number; status: string; externalId?: string }>;
}

export function makePublishingSweepHandler(deps: {
  publish(p: PublishInput & { tokenEncrypted: string }): Promise<{ externalId: string }>;
}): TaskHandler {
  return async ({ task, step, cancelled }: TaskHandlerInput) => {
    const result: SweepResult = {
      due: 0, posted: 0, failed: 0, skipped_draft_only: 0, duplicates_prevented: 0,
      publications: [],
    };

    await step("select_due", async () => {
      const due = await query<{ id: number; tenant_id: number; channel: ChannelKind; business_unit_id: number | null }>(
        `SELECT d.id, d.tenant_id, d.channel, b.id AS business_unit_id
         FROM drafts d
         LEFT JOIN business_units b ON b.legacy_tenant_id = d.tenant_id
         WHERE d.status = 'scheduled'
         ORDER BY d.id`
      );
      result.due = due.length;
      return { due: due.length, draftIds: due.map((d) => d.id) };
    });

    const due = await query<{ id: number; tenant_id: number; channel: ChannelKind; business_unit_id: number | null }>(
      `SELECT d.id, d.tenant_id, d.channel, b.id AS business_unit_id
       FROM drafts d
       LEFT JOIN business_units b ON b.legacy_tenant_id = d.tenant_id
       WHERE d.status = 'scheduled'
       ORDER BY d.id`
    );

    for (const d of due) {
      if (await cancelled()) throw new TaskCancelledError();
      await heartbeat(task.id);
      if (d.channel === ("instagram" as ChannelKind) || d.channel === ("tiktok" as ChannelKind)) {
        // Draft-only channels never auto-post (legacy invariant preserved).
        result.skipped_draft_only++;
        continue;
      }

      // THE IDEMPOTENCY CLAIM (§88): pending row inserted BEFORE the side
      // effect. Concurrent sweeps: only the insert that wins the UNIQUE
      // constraint proceeds to publish — the loser counts a prevented
      // duplicate and moves on. Zero duplicate posts, by construction.
      const claim = await query<{ id: number }>(
        `INSERT INTO content_publications (draft_id, business_unit_id, tenant_id, channel, idempotency_key, status, attempted_at)
         VALUES ($1, $2, $3, $4, $5, 'pending', now())
         ON CONFLICT (idempotency_key) DO NOTHING
         RETURNING id`,
        [d.id, d.business_unit_id ?? null, d.tenant_id, d.channel, publicationKey(d.id)]
      );
      if (claim.length === 0) {
        result.duplicates_prevented++;
        continue;
      }

      const chan = await query<{ token_encrypted: string; status: string; kind: string; target?: string | null }>(
        "SELECT token_encrypted, status FROM channels WHERE tenant_id = $1 AND kind = $2",
        [d.tenant_id, d.channel]
      );
      if (chan.length === 0 || chan[0].status === "unhealthy") {
        await query("UPDATE content_publications SET status = 'failed', error = $2 WHERE id = $1", [claim[0].id, "channel missing or unhealthy"]);
        await markFailed(d.id, "channel missing or unhealthy");
        result.failed++;
        result.publications.push({ draftId: d.id, status: "failed" });
        continue;
      }

      try {
        const { externalId } = await deps.publish({
          channel: d.channel,
          content: (await query<{ content: string }>("SELECT content FROM drafts WHERE id = $1", [d.id]))[0].content,
          token: chan[0].token_encrypted,
          tokenEncrypted: chan[0].token_encrypted,
        });
        await markPosted(d.id, externalId);
        result.posted++;
        result.publications.push({ draftId: d.id, status: "published", externalId });
      } catch (e) {
        const msg = (e instanceof Error ? e.message : String(e)).slice(0, 2000);
        await query("UPDATE content_publications SET status = 'failed', error = $2 WHERE id = $1", [claim[0].id, msg]);
        await markFailed(d.id, msg);
        await query("UPDATE channels SET status = 'unhealthy' WHERE tenant_id = $1 AND kind = $2", [d.tenant_id, d.channel]);
        result.failed++;
        result.publications.push({ draftId: d.id, status: "failed" });
        await emitEvent(d.business_unit_id ?? null, "publish.failed", {
          draftId: d.id, channel: d.channel, error: msg, taskId: task.id,
        });
      }
    }
    return { ...result };
  };
}

/** Production transport: publisher + channel token decryption. */
async function realPublish(p: PublishInput & { tokenEncrypted: string }) {
  const plain = decryptChannelToken(p.tokenEncrypted);
  return getPublisher(p.channel).publish({ env: process.env as NodeJS.ProcessEnv }, {
    channel: p.channel, content: p.content, token: plain, target: p.target,
  });
}

/* ------------------------------------------------------------------ */
/* 3. send_notification                                                */
/* ------------------------------------------------------------------ */

export interface NotificationPayload {
  notificationId: number;
}

export type EmailSender = (p: { target: string; subject: string; body: string }) => Promise<void>;

/** Production transport: Resend via the existing email publisher. */
export const resendEmailSender: EmailSender = async ({ target, subject, body }) => {
  const email = getPublisher("email");
  const content = `Subject: ${subject}\n${body}`;
  await email.publish({ env: process.env as NodeJS.ProcessEnv }, {
    channel: "email", content, token: "", target,
  });
};

export function makeSendNotificationHandler(deps: { sendEmail: EmailSender }): TaskHandler {
  return async ({ task, step }: TaskHandlerInput) => {
    const notificationId = Number((task.payload as unknown as NotificationPayload).notificationId);
    let target = "";
    let skipped = false;

    await step("load", async () => {
      if (!Number.isInteger(notificationId)) throw new Error("send_notification: missing notificationId");
      const rows = await query<{ status: string }>("SELECT status FROM notifications WHERE id = $1", [notificationId]);
      if (rows.length === 0) throw new Error(`notification not found: ${notificationId}`);
      if (rows[0].status !== "pending") { skipped = true; return { skipped: true, status: rows[0].status }; }
      const det = await query<{ target: string | null; subject: string | null; body: string | null }>(
        "SELECT target, subject, body FROM notifications WHERE id = $1", [notificationId]
      );
      target = det[0].target ?? "";
      return { target };
    });

    if (skipped) return { skipped: true };

    await step("deliver", async () => {
      const det = await query<{ subject: string | null; body: string | null }>(
        "SELECT subject, body FROM notifications WHERE id = $1", [notificationId]
      );
      await deps.sendEmail({
        target,
        subject: det[0].subject ?? "AgentOS notification",
        body: det[0].body ?? "",
      });
      await query(
        "UPDATE notifications SET status = 'sent', sent_at = now(), attempts = attempts + 1 WHERE id = $1",
        [notificationId]
      );
      return { target };
    });
    return { sent: true };
  };
}

/* ------------------------------------------------------------------ */
/* Registration                                                        */
/* ------------------------------------------------------------------ */

let emailSender: EmailSender = resendEmailSender;
export function setBuiltinEmailSender(sender: EmailSender): void {
  emailSender = sender;
}

export function registerBuiltins(): void {
  registerTaskHandler("agent_dispatch", makeAgentDispatchHandler({ llm: builtinLlm }));
  registerTaskHandler("publishing_sweep", makePublishingSweepHandler({ publish: realPublish }));
  registerTaskHandler("send_notification", makeSendNotificationHandler({ sendEmail: (...args) => emailSender(...args) }));
  // Phase 5: durable knowledge source refresh — embeddings ride the gateway
  // (budget-enforced, ledgered, BU-attributed purpose=knowledge_ingest).
  registerTaskHandler("knowledge_fetch", makeKnowledgeFetchHandler({
    fetcher: knowledgeFetcher,
    embedProvider: ({ businessUnitId, taskId }) => {
      const gateway = builtinLlm as LLMClient & Partial<GatewayClient>;
      if (typeof gateway.withAttribution === "function") {
        return gateway.withAttribution({ businessUnitId, taskId, purpose: "knowledge_ingest" });
      }
      return builtinLlm;
    },
  }));
  // Phase 7: research workforce — the analysis call rides the gateway with
  // per-task attribution (BU + task + agent, purpose="research") so budget
  // ceilings and the llm_requests ledger cover the workforce.
  registerResearchHandlers((task: { business_unit_id: number | null; id: number; payload: Record<string, unknown> }) => {
    const gateway = builtinLlm as LLMClient & Partial<GatewayClient>;
    if (typeof gateway.withAttribution === "function") {
      return gateway.withAttribution({
        businessUnitId: task.business_unit_id,
        taskId: task.id,
        agentSlug: (task.payload as { agentSlug?: string }).agentSlug ?? "research",
        purpose: "research",
      });
    }
    return builtinLlm;
  });
  // Phase 8: content workforce — strategy→content→fact_check rides the
  // gateway with per-task attribution (BU + task, purpose="content") so the
  // three-step chain is budgeted and ledgered like every other LLM leg.
  registerContentHandlers((task: { business_unit_id: number | null; id: number }) => {
    const gateway = builtinLlm as LLMClient & Partial<GatewayClient>;
    if (typeof gateway.withAttribution === "function") {
      return gateway.withAttribution({
        businessUnitId: task.business_unit_id,
        taskId: task.id,
        purpose: "content",
      });
    }
    return builtinLlm;
  });
  // Phase 9: SEO workforce — the analysis leg rides the gateway with
  // per-task attribution (BU + task, purpose="seo") so budget ceilings and
  // the llm_requests ledger cover the keyword/gap analysis like every other
  // workforce LLM leg.
  registerSeoHandlers((task: { business_unit_id: number | null; id: number }) => {
    const gateway = builtinLlm as LLMClient & Partial<GatewayClient>;
    if (typeof gateway.withAttribution === "function") {
      return gateway.withAttribution({
        businessUnitId: task.business_unit_id,
        taskId: task.id,
        purpose: "seo",
      });
    }
    return builtinLlm;
  });
}

// Test seam: override the LLM client used by the builtin agent_dispatch.
let builtinLlm: LLMClient = defaultLlm;
export function setBuiltinDispatchLlm(client: LLMClient): void {
  builtinLlm = client;
  registerTaskHandler("agent_dispatch", makeAgentDispatchHandler({ llm: builtinLlm }));
}
