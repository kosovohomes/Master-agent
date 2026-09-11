import { NextResponse } from "next/server";
import { listFeatureFlags, setFeatureFlag, listSystemSettings, setSystemSetting } from "@/lib/settings";
import { requirePermission } from "@/lib/auth/guards";
import { writeAudit, requestIdFor } from "@/lib/audit";

export const runtime = "nodejs";

/**
 * /api/admin/settings (Phase 1 M3).
 *  GET — settings.manage OR audit.read holders see feature/emergency flags
 *        and system settings. No secret material is ever returned here.
 *  PUT — settings.manage. Body: { flags?: {key, enabled}[], settings?: {key, value}[] }.
 *        Emergency flags (stop_all_agents, disable_publishing) are audited
 *        individually with their new state.
 */
export async function GET(req: Request) {
  const requestId = requestIdFor(req);
  const gate = await requirePermission(req, "settings.manage");
  if (!gate.ok) {
    const alt = await requirePermission(req, "audit.read");
    if (!alt.ok) return alt.response;
  }
  const [flags, settings] = await Promise.all([listFeatureFlags(), listSystemSettings()]);
  return NextResponse.json({ data: { flags, settings }, meta: { requestId } });
}

export async function PUT(req: Request) {
  const requestId = requestIdFor(req);
  const gate = await requirePermission(req, "settings.manage");
  if (!gate.ok) return gate.response;
  const actor = gate.ctx.user!;

  let body: { flags?: { key?: string; enabled?: boolean }[]; settings?: { key?: string; value?: unknown }[] };
  try {
    body = (await req.json()) as typeof body;
  } catch {
    return NextResponse.json({ errors: [{ code: "INVALID_JSON" }] }, { status: 400 });
  }

  const updatedFlags: string[] = [];
  for (const f of body.flags ?? []) {
    if (typeof f.key !== "string" || typeof f.enabled !== "boolean") continue;
    const updated = await setFeatureFlag(f.key, f.enabled, actor.id);
    if (updated) {
      updatedFlags.push(f.key);
      await writeAudit({
        actorType: "user", actorId: actor.id,
        action: updated.emergency ? "settings.emergency_flag" : "settings.flag",
        resource: "feature_flags", resourceId: f.key,
        result: "success", requestId,
        metadata: { enabled: f.enabled },
      });
    }
  }

  const updatedSettings: string[] = [];
  for (const s of body.settings ?? []) {
    if (typeof s.key !== "string" || s.key === "") continue;
    await setSystemSetting(s.key, s.value, actor.id);
    updatedSettings.push(s.key);
    await writeAudit({ actorType: "user", actorId: actor.id, action: "settings.set", resource: "system_settings", resourceId: s.key, result: "success", requestId });
  }

  if (updatedFlags.length === 0 && updatedSettings.length === 0) {
    return NextResponse.json({ errors: [{ code: "NOTHING_TO_UPDATE" }] }, { status: 400 });
  }
  return NextResponse.json({ data: { updatedFlags, updatedSettings }, meta: { requestId } });
}
