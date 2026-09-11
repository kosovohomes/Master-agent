/**
 * Route guards (Phase 1 M1 — Phase 0.5 §12.6).
 *
 * Every mutating route declares its required permission; authorization is
 * enforced server-side here, never in the UI. Denials are 401 (no/invalid
 * credentials) or 403 (valid credentials, missing permission).
 *
 * Transition support (SEC-C1/C4, §12.4): sessionOrLegacyBearer() accepts a
 * legacy ADMIN_PASSWORD/OPS_TOKEN bearer in place of a session while the
 * `legacy_bearer_auth` feature flag is on (Phase 1 default ON; the final
 * bearer cutover is a flag flip, not a code change). The dashboard itself
 * never sees or stores a password — that pattern is deleted in Phase 1.
 */
import { NextResponse } from "next/server";
import { authorizeOpsOrAdmin } from "../admin";
import { isFlagEnabled } from "../settings";
import { getSessionByToken, sessionTokenFrom, type SessionUser } from "./sessions";
import { clientIp } from "../security/ratelimit";

export interface AuthContext {
  via: "session" | "legacy-bearer";
  user: SessionUser | null;
  sessionId: number | null;
  ip: string;
}

export type Gate = { ok: true; ctx: AuthContext } | { ok: false; response: NextResponse };

function unauthorized(code = "UNAUTHORIZED"): NextResponse {
  return NextResponse.json({ errors: [{ code }] }, { status: 401 });
}

function forbidden(code = "FORBIDDEN"): NextResponse {
  return NextResponse.json({ errors: [{ code }] }, { status: 403 });
}

/** Valid session required (any permission). */
export async function requireSession(req: Request): Promise<Gate> {
  const session = await getSessionByToken(sessionTokenFrom(req));
  if (!session) return { ok: false, response: unauthorized() };
  return {
    ok: true,
    ctx: { via: "session", user: session.user, sessionId: session.sessionId, ip: clientIp(req) },
  };
}

/** Valid session holding the required permission. */
export async function requirePermission(req: Request, permission: string): Promise<Gate> {
  const gate = await requireSession(req);
  if (!gate.ok) return gate;
  if (!gate.ctx.user!.permissions.includes(permission)) return { ok: false, response: forbidden() };
  return gate;
}

/** Valid session holding ANY of the required permissions. */
export async function requireAnyPermission(req: Request, permissions: string[]): Promise<Gate> {
  const gate = await requireSession(req);
  if (!gate.ok) return gate;
  const held = gate.ctx.user!.permissions;
  if (!permissions.some((p) => held.includes(p))) return { ok: false, response: forbidden() };
  return gate;
}

/**
 * Session with `permission` — or, while the transition flag is on, a legacy
 * ops/admin bearer token. Legacy admission is marked via ctx.via so call
 * sites can audit it distinctly.
 */
export async function sessionOrLegacyBearer(req: Request, permission: string): Promise<Gate> {
  const session = await getSessionByToken(sessionTokenFrom(req));
  if (session) {
    if (!session.user.permissions.includes(permission)) return { ok: false, response: forbidden() };
    return { ok: true, ctx: { via: "session", user: session.user, sessionId: session.sessionId, ip: clientIp(req) } };
  }
  const legacyAllowed = await isFlagEnabled("legacy_bearer_auth", true);
  if (legacyAllowed) {
    const token = req.headers.get("authorization")?.replace(/^Bearer\s+/i, "") ?? null;
    if (authorizeOpsOrAdmin(token)) {
      return { ok: true, ctx: { via: "legacy-bearer", user: null, sessionId: null, ip: clientIp(req) } };
    }
  }
  return { ok: false, response: unauthorized() };
}

/**
 * Session or flag-gated legacy bearer WITHOUT a per-request permission —
 * for routes whose required permission depends on the (not-yet-parsed) body,
 * e.g. the drafts action route where approve/reject vs schedule demand
 * different permissions. Callers must enforce the action-specific permission
 * themselves and MUST NOT treat legacy admission as carrying any permission.
 */
export async function sessionOrLegacyBearerAny(req: Request): Promise<Gate> {
  const session = await getSessionByToken(sessionTokenFrom(req));
  if (session) {
    return { ok: true, ctx: { via: "session", user: session.user, sessionId: session.sessionId, ip: clientIp(req) } };
  }
  const legacyAllowed = await isFlagEnabled("legacy_bearer_auth", true);
  if (legacyAllowed) {
    const token = req.headers.get("authorization")?.replace(/^Bearer\s+/i, "") ?? null;
    if (authorizeOpsOrAdmin(token)) {
      return { ok: true, ctx: { via: "legacy-bearer", user: null, sessionId: null, ip: clientIp(req) } };
    }
  }
  return { ok: false, response: unauthorized() };
}

export { unauthorized, forbidden };
