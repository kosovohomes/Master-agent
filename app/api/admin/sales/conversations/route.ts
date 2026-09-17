import { NextResponse } from "next/server";
import { requirePermission, requireAnyPermission } from "@/lib/auth/guards";
import { query } from "@/lib/db";
import { listConversations, getConversation, getMessages, closeConversation } from "@/lib/sales/service";
import { writeAudit, requestIdFor } from "@/lib/audit";
import { SalesServiceError } from "@/lib/sales/types";

export const runtime = "nodejs";

async function firstBuId(): Promise<number | null> {
  return (await query<{ id: number }>("SELECT id FROM business_units ORDER BY id ASC LIMIT 1"))[0]?.id ?? null;
}

async function buFromUrl(req: Request): Promise<number | null> {
  const buRaw = new URL(req.url).searchParams.get("businessUnitId");
  return buRaw && /^\d+$/.test(buRaw) ? Number(buRaw) : null;
}

/**
 * /api/admin/sales/conversations (Phase 12) — persisted widget chats.
 *  GET — sales.manage / audit.read: ?businessUnitId= list, or
 *        ?id= detail WITH the message transcript. Transcripts contain ONLY
 *        visitor/assistant turns (§65: internal reasoning is never stored,
 *        so it cannot leak here). Assistant turns carry public citations.
 */
export async function GET(req: Request) {
  const requestId = requestIdFor(req);
  const gate = await requireAnyPermission(req, ["sales.manage", "audit.read"]);
  if (!gate.ok) return gate.response;

  const url = new URL(req.url);
  const idRaw = url.searchParams.get("id");
  if (idRaw) {
    const id = Number(idRaw);
    if (!Number.isInteger(id) || id <= 0) {
      return NextResponse.json({ errors: [{ code: "INVALID_ID" }] }, { status: 400 });
    }
    const conversation = await getConversation(id);
    if (!conversation) return NextResponse.json({ errors: [{ code: "NOT_FOUND" }] }, { status: 404 });
    const messages = await getMessages(id);
    return NextResponse.json({ data: { conversation, messages }, meta: { requestId } });
  }

  const buId = (await buFromUrl(req)) ?? (await firstBuId());
  if (!buId) return NextResponse.json({ errors: [{ code: "NO_BUSINESS_UNIT" }] }, { status: 400 });

  const conversations = await listConversations(buId, 50);
  return NextResponse.json({ data: { conversations }, meta: { requestId } });
}

/**
 * POST — sales.manage: close an active conversation (widget handoff
 * completed, or the inquiry it produced was resolved). Audited.
 */
export async function POST(req: Request) {
  const requestId = requestIdFor(req);
  const gate = await requirePermission(req, "sales.manage");
  if (!gate.ok) return gate.response;
  const userId = gate.ctx.user?.id ?? null;

  let body: { id?: number };
  try {
    body = (await req.json()) as typeof body;
  } catch {
    return NextResponse.json({ errors: [{ code: "INVALID_JSON" }] }, { status: 400 });
  }
  if (!Number.isInteger(body.id) || (body.id as number) <= 0) {
    return NextResponse.json({ errors: [{ code: "INVALID_ID" }] }, { status: 400 });
  }

  try {
    const conversation = await closeConversation(body.id as number);
    await writeAudit({
      actorType: "user",
      actorId: userId,
      action: "sales.conversation.close",
      resource: "conversations",
      resourceId: conversation.id,
      result: "success",
      requestId,
      metadata: {},
    });
    return NextResponse.json({ data: { conversation }, meta: { ts: new Date().toISOString(), requestId } });
  } catch (e) {
    if (e instanceof SalesServiceError && e.code === "NOT_FOUND") {
      return NextResponse.json({ errors: [{ code: "NOT_FOUND", detail: e.message }] }, { status: 404 });
    }
    return NextResponse.json({ errors: [{ code: "CLOSE_FAILED" }] }, { status: 500 });
  }
}
