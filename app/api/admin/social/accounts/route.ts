import { NextResponse } from "next/server";
import { requireAnyPermission, requirePermission } from "@/lib/auth/guards";
import { connectAccount, listAccounts } from "@/lib/social/service";
import { SocialServiceError } from "@/lib/social/types";
import type { SocialPlatform } from "@/lib/social/types";
import { writeAudit, requestIdFor } from "@/lib/audit";

export const runtime = "nodejs";

const PLATFORMS: SocialPlatform[] = ["linkedin", "x", "instagram", "tiktok"];

/**
 * /api/admin/social/accounts (Phase 10).
 *  GET  — social.manage / audit.read: accounts for a BU (no secrets ever).
 *  POST — social.manage: manual connect {businessUnitId, platform, token,
 *         accountRef?, displayName?}. Credentials are encrypted at rest
 *         (SEC-L2 envelope). linkedin REQUIRES accountRef (R4 fix).
 *         Audited WITHOUT the token (audit logs must not record secrets).
 */
export async function GET(req: Request) {
  const requestId = requestIdFor(req);
  const gate = await requireAnyPermission(req, ["social.manage", "audit.read"]);
  if (!gate.ok) return gate.response;
  const url = new URL(req.url);
  const buRaw = url.searchParams.get("businessUnitId");
  const businessUnitId = buRaw && /^\d+$/.test(buRaw) ? Number(buRaw) : null;
  const accounts = await listAccounts({ businessUnitId });
  return NextResponse.json({ data: { accounts }, meta: { requestId } });
}

export async function POST(req: Request) {
  const requestId = requestIdFor(req);
  const gate = await requirePermission(req, "social.manage");
  if (!gate.ok) return gate.response;

  let body: Record<string, unknown>;
  try {
    body = (await req.json()) as Record<string, unknown>;
  } catch {
    return NextResponse.json({ errors: [{ code: "INVALID_JSON" }] }, { status: 400 });
  }

  const businessUnitId = Number(body.businessUnitId);
  const platform = String(body.platform ?? "") as SocialPlatform;
  const token = typeof body.token === "string" ? body.token : "";
  const accountRef = typeof body.accountRef === "string" ? body.accountRef : null;
  const displayName = typeof body.displayName === "string" ? body.displayName : null;

  if (!Number.isInteger(businessUnitId) || businessUnitId <= 0) {
    return NextResponse.json({ errors: [{ code: "BUSINESS_UNIT_ID_REQUIRED" }] }, { status: 400 });
  }
  if (!PLATFORMS.includes(platform)) {
    return NextResponse.json(
      { errors: [{ code: "INVALID_PLATFORM", detail: `platform must be one of ${PLATFORMS.join(", ")}` }] },
      { status: 400 }
    );
  }

  try {
    const account = await connectAccount({
      businessUnitId,
      platform,
      token,
      accountRef,
      displayName,
      source: "manual",
    });
    await writeAudit({
      actorType: "user",
      actorId: gate.ctx.user?.id ?? null,
      action: "social.account.connect",
      resource: "social_accounts",
      resourceId: account.id,
      result: "success",
      requestId,
      metadata: { businessUnitId, platform, source: "manual", hasAccountRef: Boolean(accountRef) },
    });
    return NextResponse.json({ data: { account }, meta: { requestId } });
  } catch (e) {
    const code = e instanceof SocialServiceError ? e.code : "CONNECT_FAILED";
    const status = code === "ACCOUNT_REF_REQUIRED" || code === "BAD_TOKEN" || code === "BAD_PLATFORM" ? 400 : 500;
    await writeAudit({
      actorType: "user",
      actorId: gate.ctx.user?.id ?? null,
      action: "social.account.connect",
      resource: "social_accounts",
      result: "failure",
      requestId,
      metadata: { businessUnitId, platform, code },
    });
    return NextResponse.json({ errors: [{ code, detail: e instanceof Error ? e.message : undefined }] }, { status });
  }
}
