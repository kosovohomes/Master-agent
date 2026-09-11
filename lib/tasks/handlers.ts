/**
 * Phase 3 (§11 P3) — task handler registry.
 *
 * Kept as its own module so that executors.ts (which registers handlers)
 * and engine.ts (which consumes them) never import each other — no cycle.
 * Phase 3 ships three kinds:
 *   agent_dispatch      — dispatch() wrapped as the FIRST task executor
 *   publishing_sweep    — Workflow #1: the scheduled publishing sweep
 *   send_notification   — event-bus notification delivery (email v1)
 */
import type { TaskHandler } from "./types";

const REGISTRY = new Map<string, TaskHandler>();

export function registerTaskHandler(kind: string, handler: TaskHandler): void {
  REGISTRY.set(kind, handler);
}

export function getTaskHandler(kind: string): TaskHandler | undefined {
  return REGISTRY.get(kind);
}

export function knownTaskKinds(): string[] {
  return [...REGISTRY.keys()];
}
