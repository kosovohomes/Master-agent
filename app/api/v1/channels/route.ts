import { NextResponse } from "next/server";
import { query } from "@/lib/db";
import { encryptChannelToken } from "@/lib/channels";
import { sessionOrLegacyBearer } from "@/lib/auth/guards";
import { rateLimit, clientIp } from "@/lib/security/ratelimit";
import { writeAudit, requestIdFor } from "@/lib/audit";
import type { ChannelKind } from "@/lib/agents/publishers/index";

export const runtime = "nodejs";

const CHANNEL_KINDS: ChannelKind[] = ["linkedin", "x", "instagram", "tiktok", "email"];

/**
 * POST /api/v1/channels — channel credential wire-up.
 *
 * Phase 1 M0 (SEC-C1): this was an unauthenticated mutation that let any
 * internet caller plant/overwrite publishing credentials for any enumerable
 * tenant. It is now fail-closed: a session holding website.manage, or —
 * during the flag-gated transition window — a legacy ops/admin bearer.
 * Per-IP rate limiting applies; every attempt is audited.
 */
export async function POST(req: Request) {
  const requestId = requestIdFor(req);
  const ip = clientIp(req);

  const rl = await rateLimit(`channels:${ip}`, 10, 10 * 60 * 1000);
  if (!rl.allowed) {
    await writeAudit({ actorType: "anonymous", actorLabel: "ip", action: "channels.wireup", resource: "channels", result: "denied", requestId, ip, metadata: { reason: "rate_limited" } });
    return NextResponse.json({ errors: [{ code: "RATE_LIMITED" }] }, { status: 429, headers: { "Retry-After": String(rl.retryAfterSec) } });
  }

  const gate = await sessionOrLegacyBearer(req, "website.manage");
  if (!gate.ok) {
    await writeAudit({ actorType: "anonymous", actorLabel: "ip", action: "channels.wireup", resource: "channels", result: "denied", requestId, ip, metadata: { reason: "unauthorized" } });
    return gate.response;
  }

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
    await writeAudit({
      actorType: gate.ctx.user ? "user" : "system",
      actorId: gate.ctx.user?.id ?? null,
      actorLabel: gate.ctx.user ? undefined : gate.ctx.via === "legacy-bearer" ? "ops:bearer" : null,
      action: "channels.wireup",
      resource: "channels",
      resourceId: rows[0].id,
      result: "success",
      requestId,
      ip,
      metadata: { tenantId: body.tenantId, kind, via: gate.ctx.via },
    });
    return NextResponse.json({
      data: { channelId: rows[0].id, kind, tenantId: body.tenantId },
      meta: { ts: new Date().toISOString(), requestId },
    });
  } catch (e) {
    if ((e as { code?: string }).code === "23503") {
      return NextResponse.json({ errors: [{ code: "UNKNOWN_TENANT" }] }, { status: 404 });
    }
    await writeAudit({ actorType: gate.ctx.user ? "user" : "system", actorId: gate.ctx.user?.id ?? null, action: "channels.wireup", resource: "channels", result: "failure", requestId, ip, metadata: { tenantId: body.tenantId, kind } });
    return NextResponse.json({ errors: [{ code: "CHANNEL_WIREUP_FAILED", detail: "internal error" }] }, { status: 500 });
  }
}
