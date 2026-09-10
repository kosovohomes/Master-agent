import { NextResponse } from "next/server";
import { dispatch, getTenantConfig } from "@/lib/agents/dispatch";
import { llm } from "@/lib/llm";
import type { AgentGoal } from "@/lib/agents/types";

export const runtime = "nodejs";

export async function POST(req: Request) {
  let body: Partial<AgentGoal>;
  try {
    body = (await req.json()) as Partial<AgentGoal>;
  } catch {
    return NextResponse.json({ errors: [{ code: "INVALID_JSON" }] }, { status: 400 });
  }
  if (!Number.isInteger(body.tenantId)) {
    return NextResponse.json({ errors: [{ code: "INVALID_TENANT" }] }, { status: 400 });
  }
  try {
    const result = await dispatch({ llm, getConfig: getTenantConfig }, {
      tenantId: body.tenantId as number,
      topic: String(body.topic ?? ""),
      channel: String(body.channel ?? ""),
      context: body.context,
    });
    return NextResponse.json({ data: result, meta: { ts: new Date().toISOString() } });
  } catch {
    return NextResponse.json({ errors: [{ code: "DISPATCH_FAILED", detail: "internal error" }] }, { status: 500 });
  }
}