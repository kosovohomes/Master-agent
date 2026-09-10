import { NextResponse } from "next/server";
import { query } from "@/lib/db";
import { encryptChannelToken } from "@/lib/channels";
import type { ChannelKind } from "@/lib/agents/publishers/index";

export const runtime = "nodejs";

const CHANNEL_KINDS: ChannelKind[] = ["linkedin", "x", "instagram", "tiktok", "email"];

export async function POST(req: Request) {
  let body: { tenantId?: number; kind?: string; token?: string };
  try {
    body = (await req.json()) as typeof body;
  } catch {
    return NextResponse.json({ errors: [{ code: "INVALID_CHANNEL_WIREUP" }] }, { status: 400 });
  }
  if (!Number.isInteger(body.tenantId) || typeof body.kind !== "string" || typeof body.token !== "string" || body.token.trim() === "") {
    return NextResponse.json({ errors: [{ code: "INVALID_CHANNEL_WIREUP" }] }, { status: 400 });
  }
  const kind = body.kind as ChannelKind;
  if (!CHANNEL_KINDS.includes(kind)) {
    return NextResponse.json({ errors: [{ code: "INVALID_CHANNEL_KIND" }] }, { status: 400 });
  }
  try {
    const tokenEncrypted = encryptChannelToken(body.token);
    const rows = await query<{ id: number }>(
      `INSERT INTO channels (tenant_id, kind, token_encrypted, status)
       VALUES ($1, $2, $3, 'healthy')
       ON CONFLICT (tenant_id, kind) DO UPDATE
       SET token_encrypted = EXCLUDED.token_encrypted, status = 'healthy'
       RETURNING id`,
      [body.tenantId as number, kind, tokenEncrypted]
    );
    return NextResponse.json({
      data: { channelId: rows[0].id, kind, tenantId: body.tenantId },
      meta: { ts: new Date().toISOString() },
    });
  } catch (e) {
    if ((e as { code?: string }).code === "23503") {
      return NextResponse.json({ errors: [{ code: "UNKNOWN_TENANT" }] }, { status: 404 });
    }
    return NextResponse.json({ errors: [{ code: "CHANNEL_WIREUP_FAILED", detail: "internal error" }] }, { status: 500 });
  }
}