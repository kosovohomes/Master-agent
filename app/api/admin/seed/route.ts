import { NextResponse } from "next/server";
import { authorizeOpsOrAdmin } from "@/lib/admin";
import { runDemoSeed } from "@/lib/demo-seed";

export const runtime = "nodejs";

/**
 * POST /api/admin/seed
 * Bearer-guarded (ADMIN_PASSWORD or OPS_TOKEN). Runs the idempotent demo
 * seed against the current environment's DATABASE_URL + OPENAI_API_KEY:
 * creates/reuses a tenant, saves brand config, ingests knowledge into
 * pgvector, dispatches a real marketing goal -> returns the pending draft.
 *
 * Optional JSON body: { slug?, name?, topic?, channel?, knowledge? }
 */
export async function POST(req: Request) {
  const token = req.headers.get("authorization")?.replace("Bearer ", "") ?? null;
  if (!authorizeOpsOrAdmin(token)) {
    return NextResponse.json({ errors: [{ code: "UNAUTHORIZED" }] }, { status: 401 });
  }
  let body: Record<string, unknown> = {};
  try {
    body = (await req.json()) as Record<string, unknown>;
  } catch {
    body = {};
  }
  try {
    const result = await runDemoSeed({
      slug: typeof body.slug === "string" && body.slug ? body.slug : undefined,
      name: typeof body.name === "string" && body.name ? body.name : undefined,
      topic: typeof body.topic === "string" && body.topic ? body.topic : undefined,
      channel: typeof body.channel === "string" && body.channel ? body.channel : undefined,
      knowledge: typeof body.knowledge === "string" && body.knowledge ? body.knowledge : undefined,
    });
    return NextResponse.json({
      data: {
        tenantId: result.tenantId,
        tenantSlug: result.tenantSlug,
        documentId: result.documentId,
        chunkCount: result.chunkCount,
        runId: result.runId,
        agent: result.agent,
        routeReason: result.routeReason,
        draftId: result.draft.id,
        draftStatus: result.draft.status,
        draftContent: result.draft.content,
      },
      meta: { ts: new Date().toISOString() },
    });
  } catch (e) {
    return NextResponse.json(
      { errors: [{ code: "SEED_FAILED", detail: e instanceof Error ? e.message : "unknown error" }] },
      { status: 500 }
    );
  }
}
