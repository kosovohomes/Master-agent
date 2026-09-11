import { NextResponse } from "next/server";
import { listEvents, listNotifications } from "@/lib/tasks/events";
import { requirePermission } from "@/lib/auth/guards";
import { requestIdFor } from "@/lib/audit";

export const runtime = "nodejs";

/**
 * /api/admin/events (Phase 3 — event bus + notifications read view).
 *  GET — audit.read: recent events and notifications (v1: email, ops target).
 *        Suppressed rows (no target configured) are visible here by design:
 *        intent is observable even when delivery is not possible.
 */
export async function GET(req: Request) {
  const requestId = requestIdFor(req);
  const gate = await requirePermission(req, "audit.read");
  if (!gate.ok) return gate.response;

  const url = new URL(req.url);
  const limit = Number(url.searchParams.get("limit") ?? 50);
  const n = Number.isFinite(limit) ? limit : 50;
  const [events, notifications] = await Promise.all([listEvents(n), listNotifications(n)]);
  // Map snake_case rows to the Command Center read model.
  return NextResponse.json({
    data: {
      events: events.map((e) => ({
        id: e.id, name: e.name, payload: e.payload, createdAt: e.created_at,
      })),
      notifications: notifications.map((x) => ({
        id: x.id, subject: x.subject, target: x.target, status: x.status,
        attempts: x.attempts, lastError: x.last_error, sentAt: x.sent_at, createdAt: x.created_at,
      })),
    },
    meta: { requestId },
  });
}
