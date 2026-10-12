import { NextResponse } from "next/server";
import { query } from "@/lib/db";
import { hashPassword, generateInitialPassword, verifyPassword } from "@/lib/auth/password";
import { authorizeOpsOrAdmin } from "@/lib/admin";
import { destroySessionsForUser } from "@/lib/auth/sessions";
import { writeAudit, requestIdFor } from "@/lib/audit";

export const runtime = "nodejs";

/**
 * POST /api/admin/recover — owner account recovery (Access & Identity
 * Overhaul). Bearer-guarded (OPS_TOKEN or ADMIN_PASSWORD) — the same root
 * ops trust as /api/admin/migrate. Two modes:
 *
 *  body {}                    → inventory: emails, status, roles, lock state
 *                               (no mutation) — resolves the "which email is
 *                               mine?" chicken-and-egg without DB access.
 *  body {email}               → rotate that user's password to a fresh,
 *                               human-typeable initial password returned ONCE
 *                               in this response (never stored in plaintext,
 *                               never audited); destroys all their sessions
 *                               and clears lockout/failure counters.
 *
 * This replaces the old "only bootstrap works, and only before the first
 * user exists" dead end: a locked-out owner can always recover with the ops
 * bearer from the Vercel env. Every call is audited (auth.recover); the
 * password itself never enters logs.
 */
export async function POST(req: Request) {
  const requestId = requestIdFor(req);
  const token = req.headers.get("authorization")?.replace(/^Bearer\s+/i, "") ?? null;
  if (!authorizeOpsOrAdmin(token)) {
    await writeAudit({ actorType: "anonymous", actorLabel: "ops:bearer", action: "auth.recover", resource: "users", result: "denied", requestId });
    return NextResponse.json({ errors: [{ code: "UNAUTHORIZED" }] }, { status: 401 });
  }

  let body: { email?: string };
  try {
    body = (await req.json().catch(() => ({}))) as typeof body;
  } catch {
    body = {};
  }

  const email = typeof body.email === "string" ? body.email.trim().toLowerCase() : "";

  if (!email) {
    const users = await query<{ id: number; email: string; display_name: string | null; status: string; locked_until: Date | null; has_password: boolean; provider: string; roles: string[] }>(
      `SELECT u.id, u.email, u.display_name, u.status, u.locked_until, u.provider, (u.password_hash <> '') AS has_password,
              COALESCE(json_agg(r.key) FILTER (WHERE r.key IS NOT NULL), '[]') AS roles
       FROM users u
       LEFT JOIN user_roles ur ON ur.user_id = u.id
       LEFT JOIN roles r ON r.id = ur.role_id
       GROUP BY u.id
       ORDER BY u.id ASC`
    );
    await writeAudit({ actorType: "system", actorLabel: "ops:bearer", action: "auth.recover", resource: "users", result: "success", requestId, metadata: { mode: "inventory", count: users.length } });
    return NextResponse.json({
      data: {
        users: users.map((u) => ({
          id: u.id,
          email: u.email,
          displayName: u.display_name,
          status: u.status,
          roles: u.roles,
          lockedUntil: u.locked_until,
          hasPassword: u.has_password,
          provider: u.provider,
        })),
      },
      meta: { requestId },
    });
  }

  const users = await query<{ id: number; email: string; status: string; password_hash: string }>(
    "SELECT id, email, status, password_hash FROM users WHERE email = $1",
    [email]
  );
  if (users.length === 0) {
    await writeAudit({ actorType: "system", actorLabel: "ops:bearer", action: "auth.recover", resource: "users", result: "denied", requestId, metadata: { mode: "rotate", reason: "unknown_email" } });
    return NextResponse.json({ errors: [{ code: "USER_NOT_FOUND" }] }, { status: 404 });
  }
  const user = users[0];

  const initialPassword = generateInitialPassword();
  const passwordHash = await hashPassword(initialPassword);
  await query(
    `UPDATE users SET password_hash = $2, failed_login_count = 0, locked_until = NULL, updated_at = now() WHERE id = $1`,
    [user.id, passwordHash]
  );
  await destroySessionsForUser(user.id);

  // Sanity: the rotated hash must verify (guards against corruption).
  const ok = await verifyPassword(initialPassword, passwordHash);

  await writeAudit({ actorType: "system", actorLabel: "ops:bearer", action: "auth.recover", resource: "users", resourceId: user.id, result: ok ? "success" : "failure", requestId, metadata: { mode: "rotate", sessionsDestroyed: true } });
  if (!ok) {
    return NextResponse.json({ errors: [{ code: "ROTATE_FAILED" }] }, { status: 500 });
  }
  return NextResponse.json({
    data: { userId: user.id, email: user.email, initialPassword },
    meta: { requestId },
  });
}
