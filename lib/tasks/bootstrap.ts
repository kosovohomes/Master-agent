/**
 * Phase 3 — registration bootstrap for serverless entry points.
 *
 * Serverless functions are cold-started independently; the built-in task
 * handlers must be registered before ANY entry point validates kinds or
 * runs work. Importing the engine registers builtins via tick()'s
 * ensureBuiltins(); routes that never tick (admin GET/POST) call
 * ensureRegisteredForApi() instead. Idempotent by construction.
 */
import { registerBuiltins } from "./executors";

let done = false;
export function ensureRegisteredForApi(): void {
  if (!done) {
    registerBuiltins();
    done = true;
  }
}
