import { NextResponse } from "next/server";
import { authorizeOpsOrAdmin } from "@/lib/admin";
import { runDemoSeed } from "@/lib/demo-seed";
import { writeAudit, requestIdFor } from "@/lib/audit";

export const runtime = "nodejs";

/**
 * POST /api/admin/seed
 * Bearer-guarded (ADMIN_PASSWORD or OPS_TOKEN). Runs the idempotent demo
 * seed against the current environment's DATABASE_URL + OPENAI_API_KEY:
 * creates/reuses a tenant + mapped business unit + website, saves brand
 * config, ingests knowledge into pgvector, dispatches a real marketing goal
 * -> returns the pending draft. Every call is audited.
 *
 * Optional JSON body: { slug?, name?, topic?, channel?, knowledge? }
 */
export async function POST(req: Request) {
  const requestId = requestIdFor(req);
  const token = req.headers.get("authorization")?.replace(/^Bearer\s+/i, "") ?? null;
  if (!authorizeOpsOrAdmin(token)) {
    await writeAudit({ actorType: "anonymous", actorLabel: "ops:bearer", action: "ops.seed", resource: "tenants", result: "denied", requestId });
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
    await writeAudit({
      actorType: "system", actorLabel: "ops:bearer", action: "ops.seed", resource: "tenants",
      resourceId: result.tenantId, result: "success", requestId,
      metadata: { tenantSlug: result.tenantSlug, businessUnitId: result.businessUnitId, websiteId: result.websiteId, draftId: result.draft.id },
    });
    return NextResponse.json({
      data: {
        tenantId: result.tenantId,
        tenantSlug: result.tenantSlug,
        businessUnitId: result.businessUnitId,
        websiteId: result.websiteId,
        documentId: result.documentId,
        chunkCount: result.chunkCount,
        runId: result.runId,
        agent: result.agent,
        routeReason: result.routeReason,
        draftId: result.draft.id,
        draftStatus: result.draft.status,
        draftContent: result.draft.content,
      },
      meta: { ts: new Date().toISOString(), requestId },
    });
  } catch (e) {
    await writeAudit({ actorType: "system", actorLabel: "ops:bearer", action: "ops.seed", resource: "tenants", result: "failure", requestId, metadata: { error: e instanceof Error ? e.message : "unknown" } });
    return NextResponse.json(
      { errors: [{ code: "SEED_FAILED", detail: e instanceof Error ? e.message : "unknown error" }] },
      { status: 500 }
    );
  }
}
