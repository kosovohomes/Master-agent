import { NextResponse } from "next/server";
import { sweepDue, getPublisher, type ChannelKind } from "@/lib/agents/publishers/index";
import { decryptChannelToken } from "@/lib/channels";
import { safeEqual } from "@/lib/security";
import { isFlagEnabled } from "@/lib/settings";
import { writeAudit, requestIdFor } from "@/lib/audit";

export const runtime = "nodejs";

async function realPublish(p: { channel: ChannelKind; content: string; token: string }) {
  return getPublisher(p.channel).publish({ env: process.env as NodeJS.ProcessEnv }, p);
}

async function handle(req: Request) {
  const requestId = requestIdFor(req);
  const auth = req.headers.get("x-cron-secret");
  if (!safeEqual(auth, process.env.CRON_SECRET)) {
    await writeAudit({ actorType: "anonymous", actorLabel: "cron", action: "publishing.sweep", resource: "drafts", result: "denied", requestId, metadata: { reason: "bad_cron_secret" } });
    return NextResponse.json({ errors: [{ code: "UNAUTHORIZED" }] }, { status: 401 });
  }

  // Emergency flag (SEC-L8 v1): disable_publishing halts the scheduled sweep
  // without touching approval state or stored credentials.
  if (await isFlagEnabled("disable_publishing", false)) {
    await writeAudit({ actorType: "system", actorLabel: "cron", action: "publishing.sweep", resource: "drafts", result: "denied", requestId, metadata: { reason: "disable_publishing" } });
    return NextResponse.json({ data: { skipped: true, reason: "disable_publishing" } });
  }

  const result = await sweepDue({
    publish: async (p) => {
      const plain = decryptChannelToken(p.token);
      return realPublish({ channel: p.channel, content: p.content, token: plain });
    },
  });
  await writeAudit({ actorType: "system", actorLabel: "cron", action: "publishing.sweep", resource: "drafts", result: "success", requestId, metadata: { result: result as unknown as Record<string, unknown> } });
  return NextResponse.json({ data: result, meta: { requestId } });
}

export async function POST(req: Request) {
  return handle(req);
}

// Vercel Cron invokes the configured path with an HTTP GET request.
// Without this alias every scheduled sweep would fail with 405.
export const GET = POST;
