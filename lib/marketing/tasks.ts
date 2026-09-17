/**
 * Marketing workforce task handler (Phase 11).
 *
 * marketing_sweep — Workflow #3 (scheduled_marketing_sweep, M_040):
 *   flag gate (fail-closed skip, not error) → findExhaustedCampaigns
 *   (active + ends_at < now) → auto-complete each (time semantics —
 *   expiry is NOT a launch decision, so no approver is required; §91
 *   approval law applies to transitions INTO 'active' only) →
 *   marketing.campaign_completed events → marketing.sweep summary event.
 *
 * The sweep is deterministic machinery: NO LLM leg inside the sweep
 * (briefs are generated on-demand via the /brief API with gateway
 * attribution purpose="marketing"), mirroring the social sweep's shape.
 *
 * Concurrency: transitionCampaign() is row-locked (FOR UPDATE + FSM
 * check in ONE transaction), so two concurrent sweeps cannot both
 * "complete" the same campaign — the loser sees BAD_TRANSITION or
 * NOT_FOUND and simply counts it as already-transitioned.
 */
import { isFlagEnabled } from "../settings";
import { registerTaskHandler } from "../tasks/handlers";
import { TaskCancelledError } from "../tasks/types";
import { heartbeat } from "../tasks/queue";
import type { TaskHandler, TaskHandlerInput } from "../tasks/types";
import { emitEvent } from "../tasks/events";
import { findExhaustedCampaigns, transitionCampaign } from "./service";

export interface MarketingSweepResult {
  skipped?: boolean;
  reason?: string;
  exhausted: number;
  completed: number;
  alreadyTransitioned: number;
  campaigns: Array<{ campaignId: number; status: string }>;
}

export function makeMarketingSweepHandler(): TaskHandler {
  return async ({ task, cancelled }: TaskHandlerInput): Promise<Record<string, unknown>> => {
    const result: MarketingSweepResult = {
      exhausted: 0, completed: 0, alreadyTransitioned: 0, campaigns: [],
    };

    // Flag gate — fail-closed SKIP (a killed phase must not error-loop).
    if (!(await isFlagEnabled("marketing", false))) {
      return { skipped: true, reason: "marketing_flag_off" };
    }

    const exhausted = await findExhaustedCampaigns(100);
    result.exhausted = exhausted.length;

    for (const c of exhausted) {
      if (await cancelled()) throw new TaskCancelledError();
      await heartbeat(task.id);
      try {
        const done = await transitionCampaign(c.id, "completed");
        result.completed++;
        result.campaigns.push({ campaignId: c.id, status: done.status });
        await emitEvent(c.businessUnitId, "marketing.campaign_completed", {
          campaignId: c.id, name: c.name, via: "marketing_sweep",
        });
      } catch {
        // Another worker transitioned it first (or it vanished) — count and
        // move on; the sweep must never fail because one row was contended.
        result.alreadyTransitioned++;
      }
    }

    await emitEvent(null, "marketing.sweep", {
      exhausted: result.exhausted,
      completed: result.completed,
      alreadyTransitioned: result.alreadyTransitioned,
    });

    return result as unknown as Record<string, unknown>;
  };
}

export function registerMarketingHandlers(): void {
  registerTaskHandler("marketing_sweep", makeMarketingSweepHandler());
}
