import { NextResponse } from "next/server";
import { llm } from "@/lib/llm";
import { retrieve } from "@/lib/rag/retrieve";
import { getTenantConfig } from "@/lib/agents/dispatch";
import { answerChat } from "@/lib/agents/chat";

export const runtime = "nodejs";

export async function POST(req: Request) {
  const body = (await req.json()) as { tenantId?: number; question?: string };
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
  } catch (e) {
    return NextResponse.json({ errors: [{ code: "CHAT_FAILED", detail: String(e) }] }, { status: 500 });
  }
}