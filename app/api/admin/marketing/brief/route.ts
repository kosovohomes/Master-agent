import { NextResponse } from "next/server";
import { requirePermission } from "@/lib/auth/guards";
import { ai } from "@/lib/ai";
import { gatherBriefContext, generateBrief, loadMarketingPrompt, fingerprint } from "@/lib/marketing/pipeline";
import type { MarketingBrief } from "@/lib/marketing/pipeline";
import { isFlagEnabled } from "@/lib/settings";
import { writeAudit, requestIdFor } from "@/lib/audit";

export const runtime = "nodejs";

/**
 * /api/admin/marketing/brief (Phase 11 — the AUTO leg, §91).
 *  POST — marketing.manage: {businessUnitId} → ONE campaign brief.
 *
 *  Order of gates:
 *   1. flag 'marketing' OFF → 423 FLAG_DISABLED (the phase is kill-switched;
 *      fail-closed, mirroring the SEO scan gate).
 *   2. Evidence gathered read-only (BU profile + content titles + segments
 *      + connected platforms).
 *   3. LLM leg (marketing agent v2 prompt) rides the shared client. Any
 *      failure (quota/budget/timeout) degrades to the deterministic brief —
 *      brief generation NEVER blocks on the LLM. The response carries
 *      `degraded` + `notes` so the operator knows which leg produced it.
 *
 *  The brief is a DRAFT artifact: creating it does NOT create a campaign —
 *  the caller reviews it and POSTs /campaigns explicitly (then a human
 *  launch is still required). Audited.
 */
export async function POST(req: Request) {
  const requestId = requestIdFor(req);
  const gate = await requirePermission(req, "marketing.manage");
  if (!gate.ok) return gate.response;

  let body: Record<string, unknown>;
  try {
    body = (await req.json()) as Record<string, unknown>;
  } catch {
    return NextResponse.json({ errors: [{ code: "INVALID_JSON" }] }, { status: 400 });
  }

  const businessUnitId = Number(body.businessUnitId);
  if (!Number.isInteger(businessUnitId) || businessUnitId <= 0) {
    return NextResponse.json({ errors: [{ code: "INVALID_BUSINESS_UNIT" }] }, { status: 400 });
  }

  if (!(await isFlagEnabled("marketing", false))) {
    return NextResponse.json({ errors: [{ code: "FLAG_DISABLED", detail: "marketing workforce is disabled" }] }, { status: 423 });
  }

  const prompt = await loadMarketingPrompt();
  const ctx = await gatherBriefContext(businessUnitId);
  const brief: MarketingBrief = await generateBrief(ctx, ai, prompt);
  const fp = fingerprint(prompt);

  await writeAudit({
    actorType: "user",
    actorId: gate.ctx.user?.id ?? null,
    action: "marketing.brief.generate",
    resource: "campaigns",
    resourceId: null,
    result: "success",
    requestId,
    metadata: {
      businessUnitId,
      degraded: brief.degraded,
      promptVersion: fp.promptVersion,
      thinEvidence: ctx.thin,
    },
  });

  return NextResponse.json({ data: { brief, evidence: ctx, prompt: fp }, meta: { requestId } });
}
