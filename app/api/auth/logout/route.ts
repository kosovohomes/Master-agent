import { NextResponse } from "next/server";
import { destroySession, clearCookieHeader, sessionTokenFrom } from "@/lib/auth/sessions";
import { writeAudit, requestIdFor } from "@/lib/audit";

export const runtime = "nodejs";

/**
 * POST /api/auth/logout — deletes the server-side session row and clears
 * the cookie. Idempotent: logout without a valid session still succeeds.
 * Browser form posts are redirected to /login; API callers receive JSON.
 */
export async function POST(req: Request) {
  const requestId = requestIdFor(req);
  const token = sessionTokenFrom(req);
  await destroySession(token);
  await writeAudit({ actorType: "user", actorLabel: token ? "session" : "anonymous", action: "auth.logout", resource: "sessions", result: "success", requestId });
  const accept = req.headers.get("accept") ?? "";
  if (accept.includes("text/html")) {
    const res = NextResponse.redirect(new URL("/login", req.url), { status: 303 });
    res.headers.append("Set-Cookie", clearCookieHeader());
    return res;
  }
  const res = NextResponse.json({ data: { ok: true } });
  res.headers.append("Set-Cookie", clearCookieHeader());
  return res;
}
