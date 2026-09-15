import { NextResponse } from "next/server";
import { requirePermission } from "@/lib/auth/guards";
import { disconnectAccount, updateAccount } from "@/lib/social/service";
import { SocialServiceError } from "@/lib/social/types";
import type { SocialAccountStatus, SocialHealth } from "@/lib/social/types";
import { writeAudit, requestIdFor } from "@/lib/audit";

export const runtime = "nodejs";

const HEALTH: SocialHealth[] = ["healthy", "unhealthy"];
const OAUTH_STATUS: SocialAccountStatus[] = ["connected", "expired", "revoked", "error"];

/**
 * /api/admin/social/accounts/[id] (Phase 10).
 *  PATCH  — social.manage: {displayName?, accountRef?, health?,
 *           oauthStatus?, tokenExpiresAt?}. Credential-free lifecycle
 *           management (SEC-L5 transitions are first-class here — mark
 *           expired/revoked when a provider callback says so).
 *           Credentials are NEVER patchable: reconnect instead.
 *  DELETE — social.manage: disconnect (row deleted; audited).
 */
export async function PATCH(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const requestId = requestIdFor(req);
  const gate = await requirePermission(req, "social.manage");
  if (!gate.ok) return gate.response;

  const { id: idRaw } = await ctx.params;
  const id = Number(idRaw);
  if (!Number.isInteger(id) || id <= 0) {
    return NextResponse.json({ errors: [{ code: "INVALID_ID" }] }, { status: 400 });
  }

  let body: Record<string, unknown>;
  try {
    body = (await req.json()) as Record<string, unknown>;
  } catch {
    return NextResponse.json({ errors: [{ code: "INVALID_JSON" }] }, { status: 400 });
  }

  if (body.health !== undefined && !HEALTH.includes(body.health as SocialHealth)) {
    return NextResponse.json({ errors: [{ code: "INVALID_HEALTH" }] }, { status: 400 });
  }
  if (body.oauthStatus !== undefined && !OAUTH_STATUS.includes(body.oauthStatus as SocialAccountStatus)) {
    return NextResponse.json({ errors: [{ code: "INVALID_OAUTH_STATUS" }] }, { status: 400 });
  }

  try {
    const account = await updateAccount(id, {
      displayName: typeof body.displayName === "string" ? body.displayName : null,
      accountRef: typeof body.accountRef === "string" ? body.accountRef : null,
      health: (body.health as SocialHealth) ?? undefined,
      oauthStatus: (body.oauthStatus as SocialAccountStatus) ?? undefined,
      tokenExpiresAt: typeof body.tokenExpiresAt === "string" ? body.tokenExpiresAt : null,
    });
    await writeAudit({
      actorType: "user",
      actorId: gate.ctx.user?.id ?? null,
      action: "social.account.update",
      resource: "social_accounts",
      resourceId: account.id,
      result: "success",
      requestId,
      metadata: { health: account.health, oauthStatus: account.oauthStatus },
    });
    return NextResponse.json({ data: { account }, meta: { requestId } });
  } catch (e) {
    const code = e instanceof SocialServiceError ? e.code : "ACCOUNT_UPDATE_FAILED";
    const status = code === "NOT_FOUND" ? 404 : 500;
    return NextResponse.json({ errors: [{ code }] }, { status });
  }
}

export async function DELETE(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const requestId = requestIdFor(req);
  const gate = await requirePermission(req, "social.manage");
  if (!gate.ok) return gate.response;

  const { id: idRaw } = await ctx.params;
  const id = Number(idRaw);
  if (!Number.isInteger(id) || id <= 0) {
    return NextResponse.json({ errors: [{ code: "INVALID_ID" }] }, { status: 400 });
  }

  try {
    await disconnectAccount(id);
    await writeAudit({
      actorType: "user",
      actorId: gate.ctx.user?.id ?? null,
      action: "social.account.disconnect",
      resource: "social_accounts",
      resourceId: id,
      result: "success",
      requestId,
      metadata: {},
    });
    return NextResponse.json({ data: { disconnected: true }, meta: { requestId } });
  } catch (e) {
    const code = e instanceof SocialServiceError ? e.code : "DISCONNECT_FAILED";
    const status = code === "NOT_FOUND" ? 404 : 500;
    return NextResponse.json({ errors: [{ code }] }, { status });
  }
}
