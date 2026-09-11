import { NextResponse } from "next/server";
import { query } from "@/lib/db";
import { verifyPassword } from "@/lib/auth/password";
import { createSession, cookieHeaderFor, SESSION_TTL_MS } from "@/lib/auth/sessions";
import { rateLimit, clientIp } from "@/lib/security/ratelimit";
import { writeAudit, requestIdFor } from "@/lib/audit";

export const runtime = "nodejs";

const MAX_FAILURES = 5;
const LOCKOUT_MINUTES = 15;

/**
 * POST /api/auth/login — email + password → server-side session cookie.
 * (Phase 1 M1 — SEC-C4. Replaces the shared ADMIN_PASSWORD sessionStorage
 * model, which is deleted; the dashboard never handles a password after
 * this call and the password is never stored in browser storage.)
 *
 * Protections: per-IP rate limit (10 / 5 min), per-account failed-login
 * lockout (5 failures → 15 min), generic LOGIN_FAILED for unknown email or
 * wrong password (no account enumeration), audit on every attempt.
 */
export async function POST(req: Request) {
  const requestId = requestIdFor(req);
  const ip = clientIp(req);

  const rl = rateLimit(`login:${ip}`, 10, 5 * 60 * 1000);
  if (!rl.allowed) {
    await writeAudit({ actorType: "anonymous", actorLabel: "ip", action: "auth.login", resource: "sessions", result: "denied", requestId, ip, metadata: { reason: "rate_limited" } });
    return NextResponse.json({ errors: [{ code: "RATE_LIMITED" }] }, { status: 429, headers: { "Retry-After": String(rl.retryAfterSec) } });
  }

  let body: { email?: string; password?: string };
  try {
    body = (await req.json()) as typeof body;
  } catch {
    return NextResponse.json({ errors: [{ code: "INVALID_JSON" }] }, { status: 400 });
  }
  const email = typeof body.email === "string" ? body.email.trim().toLowerCase() : "";
  const password = typeof body.password === "string" ? body.password : "";
  if (!email || !password) {
    return NextResponse.json({ errors: [{ code: "INVALID_CREDENTIALS" }] }, { status: 400 });
  }

  const users = await query<{
    id: number; email: string; display_name: string | null; password_hash: string;
    status: string; failed_login_count: number; locked_until: Date | null;
  }>(
    "SELECT id, email, display_name, password_hash, status, failed_login_count, locked_until FROM users WHERE email = $1",
    [email]
  );
  const user = users[0];

  if (!user || user.status !== "active") {
    await writeAudit({ actorType: "anonymous", actorLabel: email, action: "auth.login", resource: "sessions", result: "denied", requestId, ip, metadata: { reason: user ? "disabled" : "unknown_email" } });
    return NextResponse.json({ errors: [{ code: "LOGIN_FAILED" }] }, { status: 401 });
  }

  if (user.locked_until && new Date(user.locked_until).getTime() > Date.now()) {
    await writeAudit({ actorType: "anonymous", actorLabel: email, action: "auth.login", resource: "sessions", result: "denied", requestId, ip, metadata: { reason: "locked" } });
    return NextResponse.json({ errors: [{ code: "ACCOUNT_LOCKED" }] }, { status: 423 });
  }

  const ok = await verifyPassword(password, user.password_hash);
  if (!ok) {
    const failures = user.failed_login_count + 1;
    const lock = failures >= MAX_FAILURES;
    await query(
      `UPDATE users SET
         failed_login_count = $2,
         locked_until = $3,
         updated_at = now()
       WHERE id = $1`,
      [user.id, lock ? 0 : failures, lock ? new Date(Date.now() + LOCKOUT_MINUTES * 60 * 1000) : null]
    );
    await writeAudit({ actorType: "anonymous", actorLabel: email, action: "auth.login", resource: "sessions", result: "denied", requestId, ip, metadata: { reason: "bad_password", failures, locked: lock } });
    return NextResponse.json({ errors: [{ code: "LOGIN_FAILED" }] }, { status: 401 });
  }

  await query(
    "UPDATE users SET failed_login_count = 0, locked_until = NULL, last_login_at = now(), updated_at = now() WHERE id = $1",
    [user.id]
  );
  const { token } = await createSession(user.id, { ip, userAgent: req.headers.get("user-agent") });
  await writeAudit({ actorType: "user", actorId: user.id, actorLabel: user.email, action: "auth.login", resource: "sessions", result: "success", requestId, ip });

  const res = NextResponse.json({
    data: {
      user: { id: user.id, email: user.email, displayName: user.display_name },
      sessionExpiresInSeconds: Math.floor(SESSION_TTL_MS / 1000),
    },
  });
  res.headers.append("Set-Cookie", cookieHeaderFor(token));
  return res;
}
