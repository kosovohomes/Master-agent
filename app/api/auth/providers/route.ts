import { NextResponse } from "next/server";
import { googleOAuthConfigured } from "@/lib/auth/google";

export const runtime = "nodejs";

/**
 * GET /api/auth/providers — which sign-in methods the login surface may show.
 * Unauthenticated by design: reveals only booleans (no user existence, no
 * configuration detail). The Google button renders only when the server-side
 * client credentials are present (fail-closed).
 */
export async function GET() {
  return NextResponse.json({
    data: {
      password: true,
      google: googleOAuthConfigured(),
    },
  });
}
