import { NextResponse } from "next/server";
import { getAgentBySlug, listVersions, createAgentVersion } from "@/lib/agents/registry";
import { requireAnyPermission, requirePermission } from "@/lib/auth/guards";
import { writeAudit, requestIdFor } from "@/lib/audit";

export const runtime = "nodejs";

/**
 * /api/admin/agents/versions (Phase 2 — prompt versioning).
 *  GET  ?slug=… — version history for one agent (agents.manage or staff read).
 *  POST         — agents.manage. Appends the next immutable version:
 *                 {slug, systemPrompt, config?, outputSchema?, changelog?}.
 * The registry always executes the CURRENT (max) version; prior versions
 * remain for audit and rollback (re-pointing = appending a new version with
 * the old content, or a future activate endpoint).
 */
export async function GET(req: Request) {
  const requestId = requestIdFor(req);
  const gate = await requireAnyPermission(req, ["agents.manage", "drafts.read"]);
  if (!gate.ok) return gate.response;

  const slug = new URL(req.url).searchParams.get("slug");
  if (!slug) {
    return NextResponse.json({ errors: [{ code: "INVALID_INPUT", detail: "slug required" }] }, { status: 400 });
  }
  const agent = await getAgentBySlug(slug);
  if (!agent) {
    return NextResponse.json({ errors: [{ code: "UNKNOWN_AGENT" }] }, { status: 404 });
  }
  return NextResponse.json({ data: await listVersions(agent.id), meta: { requestId } });
}

export async function POST(req: Request) {
  const requestId = requestIdFor(req);
  const gate = await requirePermission(req, "agents.manage");
  if (!gate.ok) return gate.response;
  const actor = gate.ctx.user!;

  let body: { slug?: string; systemPrompt?: string; config?: Record<string, unknown>; outputSchema?: Record<string, unknown>; changelog?: string };
  try {
    body = (await req.json()) as typeof body;
  } catch {
    return NextResponse.json({ errors: [{ code: "INVALID_JSON" }] }, { status: 400 });
  }
  if (typeof body.slug !== "string" || typeof body.systemPrompt !== "string" || body.systemPrompt.trim() === "") {
    return NextResponse.json({ errors: [{ code: "INVALID_INPUT" }] }, { status: 400 });
  }
  const agent = await getAgentBySlug(body.slug);
  if (!agent) {
    return NextResponse.json({ errors: [{ code: "UNKNOWN_AGENT" }] }, { status: 404 });
  }

  const version = await createAgentVersion({
    agentId: agent.id,
    systemPrompt: body.systemPrompt,
    config: body.config,
    outputSchema: body.outputSchema ?? null,
    changelog: body.changelog,
    createdByUserId: actor.id,
  });
  await writeAudit({
    actorType: "user", actorId: actor.id, action: "agent.version.create", resource: "agent_versions",
    resourceId: String(version.id), result: "success", requestId,
    metadata: { slug: agent.slug, version: version.version },
  });
  return NextResponse.json({ data: version, meta: { requestId } });
}
