/**
 * Administrative audit logging (Phase 1 M0 — SEC-C5; Master Arch §72).
 *
 * Every administrative mutation writes an audit record: actor, action,
 * resource, resource id, timestamp, result, request/correlation id, and
 * non-secret metadata. Audit values must NEVER contain passwords, API keys,
 * tokens, or channel credentials — writeAudit() strips key-shaped fields
 * defensively, and call sites are reviewed against that rule.
 *
 * Audit writes are best-effort with respect to the business operation: a
 * failing audit insert is logged loudly but does not fail the request it
 * observes. (The alternative — failing writes to protect audit completeness —
 * is revisited with the Phase 3 event bus.)
 */
import crypto from "node:crypto";
import { query } from "./db";

export type ActorType = "user" | "system" | "agent" | "anonymous";
export type AuditResult = "success" | "failure" | "denied";

export interface AuditEntry {
  actorType: ActorType;
  /** users.id for actorType="user" */
  actorId?: number | null;
  /** human-readable actor when no user row exists, e.g. "ops:bearer", "cron", "anonymous" */
  actorLabel?: string | null;
  action: string;
  resource?: string | null;
  resourceId?: string | number | null;
  result?: AuditResult;
  requestId?: string | null;
  ip?: string | null;
  metadata?: Record<string, unknown> | null;
}

const SECRET_KEY_PATTERN = /(password|passwd|secret|token|api[_-]?key|authorization|cookie|credential)/i;

/** Recursively strips key-shaped fields; values are never logged, only shapes. */
export function sanitizeMetadata(meta: Record<string, unknown> | null | undefined): Record<string, unknown> | null {
  if (!meta) return null;
  const clean = (value: unknown, depth: number): unknown => {
    if (depth > 4) return "[depth-limit]";
    if (Array.isArray(value)) return value.slice(0, 20).map((v) => clean(v, depth + 1));
    if (value && typeof value === "object") {
      const out: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
        out[k] = SECRET_KEY_PATTERN.test(k) ? "[redacted]" : clean(v, depth + 1);
      }
      return out;
    }
    return value;
  };
  return clean(meta, 0) as Record<string, unknown>;
}

export async function writeAudit(entry: AuditEntry): Promise<void> {
  try {
    await query(
      `INSERT INTO audit_logs
         (actor_type, actor_id, actor_label, action, resource, resource_id, result, request_id, ip, metadata)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10::jsonb)`,
      [
        entry.actorType,
        entry.actorId ?? null,
        entry.actorLabel ?? null,
        entry.action,
        entry.resource ?? null,
        entry.resourceId != null ? String(entry.resourceId) : null,
        entry.result ?? "success",
        entry.requestId ?? null,
        entry.ip ?? null,
        JSON.stringify(sanitizeMetadata(entry.metadata)),
      ]
    );
  } catch (e) {
    // Audit must never take the request down, but the failure must be visible.
    console.error("[audit] write failed:", e instanceof Error ? e.message : e);
  }
}

/** Correlation id for a request: honors an inbound x-request-id, else mints one. */
export function requestIdFor(req: Request): string {
  return req.headers.get("x-request-id")?.trim() || crypto.randomUUID();
}
