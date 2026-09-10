import { NextResponse } from "next/server";
import { authorizeOpsOrAdmin } from "@/lib/admin";

export const runtime = "nodejs";

const KEYS = [
  "DATABASE_URL",
  "OPENAI_API_KEY",
  "OPENAI_MODEL",
  "OPENAI_EMBEDDINGS_MODEL",
  "CHANNEL_ENC_KEY",
  "ADMIN_PASSWORD",
  "CRON_SECRET",
  "RESEND_API_KEY",
  "EMAIL_FROM",
  "EMAIL_TARGET",
  "NEXT_PUBLIC_APP_URL",
  "OPS_TOKEN",
] as const;

/**
 * GET /api/admin/env-check
 * Bearer-guarded (ADMIN_PASSWORD or OPS_TOKEN). Runtime env diagnosis:
 * reports whether each expected variable is present and its length.
 * Never returns values. For DATABASE_URL only, it additionally reports
 * scheme + host (no credentials) so misconfigured local URLs are obvious.
 */
export async function GET(req: Request) {
  const token = req.headers.get("authorization")?.replace("Bearer ", "") ?? null;
  if (!authorizeOpsOrAdmin(token)) {
    return NextResponse.json({ errors: [{ code: "UNAUTHORIZED" }] }, { status: 401 });
  }
  const report = KEYS.map((k) => {
    const v = process.env[k];
    const item: Record<string, unknown> = {
      key: k,
      present: typeof v === "string" && v.length > 0,
    };
    if (v) {
      item.length = v.length;
      if (k === "DATABASE_URL") {
        item.scheme = v.split(":")[0];
        try {
          item.host = new URL(v).host; // hostname(+port) only, never credentials
        } catch {
          item.host = "unparseable";
        }
      }
    }
    return item;
  });
  return NextResponse.json({ data: report });
}
