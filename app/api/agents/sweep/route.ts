import { NextResponse } from "next/server";
import { sweepDue, getPublisher, type ChannelKind } from "@/lib/agents/publishers/index";
import { decryptChannelToken } from "@/lib/channels";
import { safeEqual } from "@/lib/security";

export const runtime = "nodejs";

async function realPublish(p: { channel: ChannelKind; content: string; token: string }) {
  return getPublisher(p.channel).publish({ env: process.env as NodeJS.ProcessEnv }, p);
}

export async function POST(req: Request) {
  const auth = req.headers.get("x-cron-secret");
  if (!safeEqual(auth, process.env.CRON_SECRET)) {
    return NextResponse.json({ errors: [{ code: "UNAUTHORIZED" }] }, { status: 401 });
  }
  const result = await sweepDue({
    publish: async (p) => {
      const plain = decryptChannelToken(p.token);
      return realPublish({ channel: p.channel, content: p.content, token: plain });
    },
  });
  return NextResponse.json({ data: result });
}