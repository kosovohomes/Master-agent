import { NextResponse } from "next/server";
import { requireSession } from "@/lib/auth/guards";

export const runtime = "nodejs";

/**
 * GET /api/auth/me — the authenticated principal: identity, roles,
 * permissions. Used by the Command Center shell; never returns secrets.
 */
export async function GET(req: Request) {
  const gate = await requireSession(req);
  if (!gate.ok) return gate.response;
  const u = gate.ctx.user;
  return NextResponse.json({
    data: {
      user: {
        id: u!.id,
        email: u!.email,
        displayName: u!.displayName,
        roles: u!.roles,
        permissions: u!.permissions,
      },
      via: gate.ctx.via,
    },
  });
}
