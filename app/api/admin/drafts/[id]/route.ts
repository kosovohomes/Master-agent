import { NextResponse } from "next/server";
import { authorizeAdmin } from "@/lib/admin";
import { approveDraft, rejectDraft, scheduleDraft } from "@/lib/agents/approval";

export const runtime = "nodejs";

export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  if (!authorizeAdmin(req.headers.get("authorization")?.replace("Bearer ", "") ?? null)) {
    return NextResponse.json({ errors: [{ code: "UNAUTHORIZED" }] }, { status: 401 });
  }
  const draftId = Number((await params).id);
  let body: { action?: string; comment?: string };
  try {
    body = (await req.json()) as typeof body;
  } catch {
    return NextResponse.json({ errors: [{ code: "INVALID_JSON" }] }, { status: 400 });
  }
  try {
    if (body.action === "approve") await approveDraft(draftId);
    else if (body.action === "reject") await rejectDraft(draftId, body.comment ?? "");
    else if (body.action === "schedule") await scheduleDraft(draftId);
    else return NextResponse.json({ errors: [{ code: "INVALID_ACTION" }] }, { status: 400 });
    return NextResponse.json({ data: { draftId } });
  } catch {
    return NextResponse.json({ errors: [{ code: "ACTION_FAILED", detail: "internal error" }] }, { status: 400 });
  }
}