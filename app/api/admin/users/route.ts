import { NextResponse } from "next/server";
import { query } from "@/lib/db";
import { hashPassword, generateInitialPassword } from "@/lib/auth/password";
import { destroySessionsForUser } from "@/lib/auth/sessions";
import { requirePermission } from "@/lib/auth/guards";
import { writeAudit, requestIdFor } from "@/lib/audit";

export const runtime = "nodejs";

/**
 * /api/admin/users — Owner-only user administration (§12.4 "invite/disable").
 *  GET   list users + roles (users.manage)
 *  POST  create a user {email, password?, displayName?, role, businessUnitId?};
 *        when password omitted a random initial password is generated and
 *        returned ONCE in the response (never stored in plaintext, never audited)
 *  PATCH update {id, status?, role?, businessUnitId?, unlock?}; disabling a
 *        user destroys their sessions immediately
 * Every action is audited; passwords/tokens never enter audit metadata.
 */
export async function GET(req: Request) {
  const requestId = requestIdFor(req);
  const gate = await requirePermission(req, "users.manage");
  if (!gate.ok) return gate.response;

  const users = await query<any>(
    `SELECT u.id, u.email, u.display_name, u.status, u.last_login_at, u.created_at,
            u.locked_until, u.failed_login_count,
            COALESCE(json_agg(r.key) FILTER (WHERE r.key IS NOT NULL), '[]') AS roles
     FROM users u
     LEFT JOIN user_roles ur ON ur.user_id = u.id
     LEFT JOIN roles r ON r.id = ur.role_id
     GROUP BY u.id
     ORDER BY u.id ASC`
  );
  return NextResponse.json({
    data: users.map((u) => ({
      id: u.id,
      email: u.email,
      displayName: u.display_name,
      status: u.status,
      roles: u.roles,
      lastLoginAt: u.last_login_at,
      createdAt: u.created_at,
      lockedUntil: u.locked_until,
    })),
    meta: { requestId },
  });
}

export async function POST(req: Request) {
  const requestId = requestIdFor(req);
  const gate = await requirePermission(req, "users.manage");
  if (!gate.ok) return gate.response;
  const actor = gate.ctx.user!;

  let body: { email?: string; password?: string; displayName?: string; role?: string; businessUnitId?: number };
  try {
    body = (await req.json()) as typeof body;
  } catch {
    return NextResponse.json({ errors: [{ code: "INVALID_JSON" }] }, { status: 400 });
  }
  const email = typeof body.email === "string" ? body.email.trim().toLowerCase() : "";
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return NextResponse.json({ errors: [{ code: "INVALID_EMAIL" }] }, { status: 400 });
  }
  if (typeof body.role !== "string" || body.role === "") {
    return NextResponse.json({ errors: [{ code: "INVALID_ROLE" }] }, { status: 400 });
  }

  const roleRows = await query<{ id: number; is_active: boolean }>(
    "SELECT id, is_active FROM roles WHERE key = $1",
    [body.role]
  );
  if (roleRows.length === 0 || !roleRows[0].is_active) {
    return NextResponse.json({ errors: [{ code: "INVALID_ROLE" }] }, { status: 400 });
  }

  const generated = typeof body.password !== "string" || body.password === "";
  const password = generated ? generateInitialPassword() : (body.password as string);
  if (password.length < 10) {
    return NextResponse.json({ errors: [{ code: "PASSWORD_TOO_SHORT", detail: "minimum 10 characters" }] }, { status: 400 });
  }

  const dupe = await query<{ n: number }>("SELECT count(*)::int AS n FROM users WHERE email = $1", [email]);
  if (dupe[0].n > 0) {
    return NextResponse.json({ errors: [{ code: "EMAIL_TAKEN" }] }, { status: 409 });
  }

  const passwordHash = await hashPassword(password);
  const [user] = await query<{ id: number }>(
    `INSERT INTO users (email, display_name, password_hash, status)
     VALUES ($1, $2, $3, 'active') RETURNING id`,
    [email, typeof body.displayName === "string" && body.displayName ? body.displayName : null, passwordHash]
  );
  await query("INSERT INTO user_roles (user_id, role_id, business_unit_id) VALUES ($1, $2, $3)", [
    user.id,
    roleRows[0].id,
    Number.isInteger(body.businessUnitId) ? (body.businessUnitId as number) : null,
  ]);

  await writeAudit({ actorType: "user", actorId: actor.id, action: "users.create", resource: "users", resourceId: user.id, result: "success", requestId, metadata: { email, role: body.role, businessUnitId: body.businessUnitId ?? null, generatedPassword: generated } });
  return NextResponse.json({
    data: { userId: user.id, email, role: body.role, initialPassword: generated ? password : undefined },
    meta: { requestId },
  });
}

export async function PATCH(req: Request) {
  const requestId = requestIdFor(req);
  const gate = await requirePermission(req, "users.manage");
  if (!gate.ok) return gate.response;
  const actor = gate.ctx.user!;

  let body: { id?: number; status?: string; role?: string; businessUnitId?: number | null; unlock?: boolean };
  try {
    body = (await req.json()) as typeof body;
  } catch {
    return NextResponse.json({ errors: [{ code: "INVALID_JSON" }] }, { status: 400 });
  }
  const targetId = Number(body.id);
  if (!Number.isInteger(targetId)) {
    return NextResponse.json({ errors: [{ code: "INVALID_USER" }] }, { status: 400 });
  }
  const target = await query<{ id: number; email: string }>("SELECT id, email FROM users WHERE id = $1", [targetId]);
  if (target.length === 0) {
    return NextResponse.json({ errors: [{ code: "UNKNOWN_USER" }] }, { status: 404 });
  }

  if (body.unlock === true) {
    await query("UPDATE users SET failed_login_count = 0, locked_until = NULL, updated_at = now() WHERE id = $1", [targetId]);
    await writeAudit({ actorType: "user", actorId: actor.id, action: "users.unlock", resource: "users", resourceId: targetId, result: "success", requestId });
  }

  if (body.status !== undefined) {
    if (body.status !== "active" && body.status !== "disabled") {
      return NextResponse.json({ errors: [{ code: "INVALID_STATUS" }] }, { status: 400 });
    }
    if (targetId === actor.id && body.status === "disabled") {
      return NextResponse.json({ errors: [{ code: "SELF_DISABLE_FORBIDDEN" }] }, { status: 400 });
    }
    await query("UPDATE users SET status = $2, updated_at = now() WHERE id = $1", [targetId, body.status]);
    if (body.status === "disabled") await destroySessionsForUser(targetId);
    await writeAudit({ actorType: "user", actorId: actor.id, action: "users.set_status", resource: "users", resourceId: targetId, result: "success", requestId, metadata: { status: body.status } });
  }

  if (body.role !== undefined) {
    const roleRows = await query<{ id: number; is_active: boolean }>("SELECT id, is_active FROM roles WHERE key = $1", [body.role]);
    if (roleRows.length === 0 || !roleRows[0].is_active) {
      return NextResponse.json({ errors: [{ code: "INVALID_ROLE" }] }, { status: 400 });
    }
    await query("DELETE FROM user_roles WHERE user_id = $1", [targetId]);
    await query("INSERT INTO user_roles (user_id, role_id, business_unit_id) VALUES ($1, $2, $3)", [
      targetId,
      roleRows[0].id,
      body.businessUnitId === undefined ? null : body.businessUnitId,
    ]);
    await writeAudit({ actorType: "user", actorId: actor.id, action: "users.set_role", resource: "users", resourceId: targetId, result: "success", requestId, metadata: { role: body.role, businessUnitId: body.businessUnitId ?? null } });
  }

  return NextResponse.json({ data: { userId: targetId }, meta: { requestId } });
}
