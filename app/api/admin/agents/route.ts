import { NextResponse } from "next/server";
import {
  listAgents,
  getAgentBySlug,
  getAgentById,
  setAgentStatus,
  setBuAgent,
  listBuAgents,
  currentVersion,
} from "@/lib/agents/registry";
import { requireAnyPermission, requirePermission } from "@/lib/auth/guards";
import { writeAudit, requestIdFor } from "@/lib/audit";

export const runtime = "nodejs";

/**
 * /api/admin/agents (Phase 2 — agent dashboard v1).
 *  GET   — authenticated staff read of the registry (agents + current
 *          version summary). Reads ride the same staff-read permissions as
 *          the rest of the Command Center.
 *  PATCH — agents.manage. Two mutation shapes:
 *            {slug, status}                           → global directory switch
 *            {slug, businessUnitId, enabled, config?} → per-BU enablement
 *            {slug, businessUnitId} (+ ?view=links via GET /?businessUnitId=)
 * Mutations are audited. Flipping either layer changes behavior within one
 * run, zero deploys (Phase 2 acceptance criterion).
 */
export async function GET(req: Request) {
  const requestId = requestIdFor(req);
  const gate = await requireAnyPermission(req, ["agents.manage", "drafts.read", "agents.run"]);
  if (!gate.ok) return gate.response;

  const rawBu = new URL(req.url).searchParams.get("businessUnitId");
  if (rawBu !== null) {
    if (!/^\d+$/.test(rawBu)) {
      return NextResponse.json({ errors: [{ code: "INVALID_BU" }] }, { status: 400 });
    }
    return NextResponse.json({ data: await listBuAgents(Number(rawBu)), meta: { requestId } });
  }

  const agents = await listAgents();
  const withVersions = await Promise.all(
    agents.map(async (a) => {
      const v = await currentVersion(a.id);
      return { ...a, currentVersion: v ? { id: v.id, version: v.version, changelog: v.changelog } : null };
    })
  );
  return NextResponse.json({ data: withVersions, meta: { requestId } });
}

export async function PATCH(req: Request) {
  const requestId = requestIdFor(req);
  const gate = await requirePermission(req, "agents.manage");
  if (!gate.ok) return gate.response;
  const actor = gate.ctx.user!;

  let body: {
    slug?: string; id?: number; status?: string;
    businessUnitId?: number; enabled?: boolean; config?: Record<string, unknown>;
  };
  try {
    body = (await req.json()) as typeof body;
  } catch {
    return NextResponse.json({ errors: [{ code: "INVALID_JSON" }] }, { status: 400 });
  }

  const agent = body.slug
    ? await getAgentBySlug(body.slug)
    : Number.isInteger(body.id)
      ? await getAgentById(body.id as number)
      : null;
  if (!agent) {
    return NextResponse.json({ errors: [{ code: "UNKNOWN_AGENT" }] }, { status: 404 });
  }

  // Per-BU enablement shape
  if (body.businessUnitId !== undefined || body.enabled !== undefined) {
    if (!Number.isInteger(body.businessUnitId) || typeof body.enabled !== "boolean") {
      return NextResponse.json({ errors: [{ code: "INVALID_INPUT" }] }, { status: 400 });
    }
    const link = await setBuAgent(body.businessUnitId as number, agent.id, body.enabled as boolean, body.config);
    await writeAudit({
      actorType: "user", actorId: actor.id, action: "agent.bu_enablement", resource: "agents",
      resourceId: String(agent.id), result: "success", requestId,
      metadata: { slug: agent.slug, businessUnitId: body.businessUnitId, enabled: body.enabled },
    });
    return NextResponse.json({ data: link, meta: { requestId } });
  }

  // Global status shape
  if (body.status !== undefined) {
    if (!["active", "disabled", "archived"].includes(body.status)) {
      return NextResponse.json({ errors: [{ code: "INVALID_STATUS" }] }, { status: 400 });
    }
    const updated = await setAgentStatus(agent.id, body.status as "active" | "disabled" | "archived");
    await writeAudit({
      actorType: "user", actorId: actor.id, action: "agent.status", resource: "agents",
      resourceId: String(agent.id), result: "success", requestId,
      metadata: { slug: agent.slug, status: body.status },
    });
    return NextResponse.json({ data: updated, meta: { requestId } });
  }

  return NextResponse.json({ errors: [{ code: "INVALID_INPUT", detail: "nothing to update" }] }, { status: 400 });
}
