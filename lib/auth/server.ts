/**
 * Server-component session access (Next runtime only).
 *
 * Route handlers and tests use lib/auth/guards.ts + lib/auth/sessions.ts
 * directly (framework-free). Server components cannot receive a Request, so
 * they read the cookie through next/headers here.
 */
import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { getSessionByToken, SESSION_COOKIE, type SessionUser } from "./sessions";

export async function requireSessionUser(): Promise<SessionUser> {
  const jar = await cookies();
  const session = await getSessionByToken(jar.get(SESSION_COOKIE)?.value ?? null);
  if (!session) redirect("/login");
  return session.user;
}

export async function currentSessionUser(): Promise<SessionUser | null> {
  const jar = await cookies();
  const session = await getSessionByToken(jar.get(SESSION_COOKIE)?.value ?? null);
  return session?.user ?? null;
}
