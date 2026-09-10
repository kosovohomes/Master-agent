import { NextResponse } from "next/server";
import { llm } from "@/lib/llm";
import { retrieve } from "@/lib/rag/retrieve";
import { getTenantConfig } from "@/lib/agents/dispatch";
import { answerChat } from "@/lib/agents/chat";

export const runtime = "nodejs";

export async function POST(req: Request) {
  let body: { tenantId?: number; question?: string };
  try {
    body = (await req.json()) as typeof body;
  } catch {
    return NextResponse.json({ errors: [{ code: "INVALID_JSON" }] }, { status: 400 });
  }
  if (!Number.isInteger(body.tenantId) || typeof body.question !== "string" || body.question.trim() === "") {
    return NextResponse.json({ errors: [{ code: "INVALID_CHAT_INPUT" }] }, { status: 400 });
  }
  try {
    const config = await getTenantConfig(body.tenantId as number);
    const result = await answerChat({
      llm,
      retrieve: (p) => retrieve({ embed: (texts) => llm.embed(texts) }, p),
    }, {
      tenantId: body.tenantId as number,
      question: body.question.trim(),
      config,
    });
    return NextResponse.json({ data: result, meta: { ts: new Date().toISOString() } });
  } catch {
    return NextResponse.json({ errors: [{ code: "CHAT_FAILED", detail: "internal error" }] }, { status: 500 });
  }
}