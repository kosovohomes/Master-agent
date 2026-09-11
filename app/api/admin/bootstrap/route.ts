import { NextResponse } from "next/server";
import { query } from "@/lib/db";
import { hashPassword } from "@/lib/auth/password";
import { authorizeOpsOrAdmin } from "@/lib/admin";
import { writeAudit, requestIdFor } from "@/lib/audit";

export const runtime = "nodejs";

/**
 * POST /api/admin/bootstrap — create the FIRST owner user (one-time).
 * Bearer-guarded (OPS_TOKEN or ADMIN_PASSWORD). Refuses with 409 once any
 * user exists; further users are managed through /api/admin/users by the
 * owner. The password travels only in this request body and is stored as a
 * scrypt hash; it is never written to audit logs.
 */
export async function POST(req: Request) {
  const requestId = requestIdFor(req);
  const token = req.headers.get("authorization")?.replace(/^Bearer\s+/i, "") ?? null;
  if (!authorizeOpsOrAdmin(token)) {
    await writeAudit({ actorType: "anonymous", actorLabel: "ops:bearer", action: "users.bootstrap", resource: "users", result: "denied", requestId });
    return NextResponse.json({ errors: [{ code: "UNAUTHORIZED" }] }, { status: 401 });
  }

  let body: { email?: string; password?: string; displayName?: string };
  try {
    body = (await req.json()) as typeof body;
  } catch {
    return NextResponse.json({ errors: [{ code: "INVALID_JSON" }] }, { status: 400 });
  }
  const email = typeof body.email === "string" ? body.email.trim().toLowerCase() : "";
  const password = typeof body.password === "string" ? body.password : "";
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || password.length < 10) {
    return NextResponse.json(
      { errors: [{ code: "INVALID_INPUT", detail: "email must be valid; password must be at least 10 characters" }] },
      { status: 400 }
    );
  }

  const existing = await query<{ n: number }>("SELECT count(*)::int AS n FROM users");
  if (existing[0].n > 0) {
    await writeAudit({ actorType: "system", actorLabel: "ops:bearer", action: "users.bootstrap", resource: "users", result: "denied", requestId, metadata: { reason: "users_already_exist" } });
    return NextResponse.json({ errors: [{ code: "ALREADY_BOOTSTRAPPED" }] }, { status: 409 });
  }

  const ownerRole = await query<{ id: number }>("SELECT id FROM roles WHERE key = 'owner' AND is_active");
  if (ownerRole.length === 0) {
    return NextResponse.json({ errors: [{ code: "ROLES_NOT_SEEDED", detail: "run migrations first" }] }, { status: 500 });
  }

  const passwordHash = await hashPassword(password);
  const [user] = await query<{ id: number }>(
    `INSERT INTO users (email, display_name, password_hash, status)
     VALUES ($1, $2, $3, 'active') RETURNING id`,
    [email, typeof body.displayName === "string" && body.displayName ? body.displayName : null, passwordHash]
  );
  await query("INSERT INTO user_roles (user_id, role_id) VALUES ($1, $2)", [user.id, ownerRole[0].id]);

  await writeAudit({ actorType: "system", actorLabel: "ops:bearer", action: "users.bootstrap", resource: "users", resourceId: user.id, result: "success", requestId, metadata: { email, role: "owner" } });
  return NextResponse.json({ data: { userId: user.id, email, role: "owner" }, meta: { requestId } });
}
