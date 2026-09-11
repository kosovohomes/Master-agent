/**
 * Server-side sessions (Phase 1 M1 — SEC-C4; Phase 0.5 §12.5).
 *
 * - Opaque 256-bit session token (crypto.randomBytes(32), base64url)
 * - Only the SHA-256 hash of the token is stored; the raw token exists only
 *   in the cookie and never in the database or logs
 * - Cookie: httpOnly; Secure; SameSite=Lax; Path=/; Max-Age=7d
 * - Sliding expiry: each authenticated lookup extends the window back to the
 *   full 7 days (throttled to at most one write per hour per session)
 * - Logout deletes the session row; disabling a user destroys all sessions
 *
 * Implemented against the raw Request (cookie header parse + Set-Cookie
 * string) rather than next/headers so the same code runs in route handlers
 * AND in direct-invocation test suites. Server components use
 * requireSessionUser() from lib/auth/server.ts, which wraps next/headers.
 */
import crypto from "node:crypto";
import { query } from "../db";
import { permissionsForUser, roleKeysForUser } from "./rbac";

export const SESSION_COOKIE = "agentos_session";
export const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000;
/** renew the sliding window when less than this much validity remains */
const RENEW_THRESHOLD_MS = SESSION_TTL_MS - 60 * 60 * 1000;

export interface SessionUser {
  id: number;
  email: string;
  displayName: string | null;
  status: string;
  roles: string[];
  permissions: string[];
}

export interface LiveSession {
  sessionId: number;
  expiresAt: Date;
  user: SessionUser;
}

export function hashToken(token: string): string {
  return crypto.createHash("sha256").update(token).digest("hex");
}

export interface CreateSessionParams {
  ip?: string | null;
  userAgent?: string | null;
}

export async function createSession(userId: number, p: CreateSessionParams = {}): Promise<{ token: string; expiresAt: Date }> {
  const token = crypto.randomBytes(32).toString("base64url"); // 256-bit opaque token
  const expiresAt = new Date(Date.now() + SESSION_TTL_MS);
  await query(
    `INSERT INTO sessions (user_id, token_hash, expires_at, ip, user_agent)
     VALUES ($1, $2, $3, $4, $5)`,
    [userId, hashToken(token), expiresAt, p.ip ?? null, (p.userAgent ?? "").slice(0, 300) || null]
  );
  return { token, expiresAt };
}

/** Resolves a raw session token to a live session (user must be active). */
export async function getSessionByToken(token: string | null | undefined): Promise<LiveSession | null> {
  if (!token) return null;
  const rows = await query<{
    session_id: number; expires_at: Date; user_id: number; email: string;
    display_name: string | null; status: string;
  }>(
    `SELECT s.id AS session_id, s.expires_at, u.id AS user_id, u.email, u.display_name, u.status
     FROM sessions s JOIN users u ON u.id = s.user_id
     WHERE s.token_hash = $1 AND s.expires_at > now()`,
    [hashToken(token)]
  );
  if (rows.length === 0) return null;
  const r = rows[0];
  if (r.status !== "active") return null;

  const user: SessionUser = {
    id: r.user_id,
    email: r.email,
    displayName: r.display_name,
    status: r.status,
    roles: await roleKeysForUser(r.user_id),
    permissions: await permissionsForUser(r.user_id),
  };

  // Sliding expiry (throttled): extend back to the full TTL when the session
  // is within RENEW_THRESHOLD_MS of expiring.
  const remaining = new Date(r.expires_at).getTime() - Date.now();
  if (remaining < RENEW_THRESHOLD_MS) {
    const newExpiry = new Date(Date.now() + SESSION_TTL_MS);
    await query("UPDATE sessions SET expires_at = $2, last_seen_at = now() WHERE id = $1", [r.session_id, newExpiry]);
    return { sessionId: r.session_id, expiresAt: newExpiry, user };
  }
  await query("UPDATE sessions SET last_seen_at = now() WHERE id = $1", [r.session_id]);
  return { sessionId: r.session_id, expiresAt: new Date(r.expires_at), user };
}

export async function destroySession(token: string | null | undefined): Promise<void> {
  if (!token) return;
  await query("DELETE FROM sessions WHERE token_hash = $1", [hashToken(token)]);
}

export async function destroySessionsForUser(userId: number): Promise<void> {
  await query("DELETE FROM sessions WHERE user_id = $1", [userId]);
}

// ---------- cookie plumbing (framework-free, test-friendly) ----------

export function parseCookies(req: Request): Record<string, string> {
  const header = req.headers.get("cookie");
  const out: Record<string, string> = {};
  if (!header) return out;
  for (const part of header.split(";")) {
    const idx = part.indexOf("=");
    if (idx <= 0) continue;
    const k = part.slice(0, idx).trim();
    const v = part.slice(idx + 1).trim();
    if (k) out[k] = decodeURIComponent(v);
  }
  return out;
}

export function sessionTokenFrom(req: Request): string | null {
  return parseCookies(req)[SESSION_COOKIE] ?? null;
}

export function cookieHeaderFor(token: string): string {
  const maxAge = Math.floor(SESSION_TTL_MS / 1000);
  return `${SESSION_COOKIE}=${encodeURIComponent(token)}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${maxAge}`;
}

export function clearCookieHeader(): string {
  return `${SESSION_COOKIE}=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0`;
}
