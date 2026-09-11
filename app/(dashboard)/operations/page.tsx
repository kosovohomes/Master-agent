"use client";

import { useCallback, useEffect, useState } from "react";

/**
 * /operations — task engine observability (Phase 3).
 * Workflows + recent runs, the durable task queue (with retry/cancel state),
 * and the event/notification feed. Server-side RBAC (audit.read) enforces
 * access; this screen reads via /api/admin/* only. Task cancellation posts
 * the intent — the queue decides queued-cancel vs cooperative mid-run cancel.
 */
type Workflow = {
  id: number; slug: string; name: string; triggerKind: string;
  taskKind: string; enabled: boolean;
  triggerConfig: Record<string, unknown>;
};
type WorkflowRun = {
  id: number; workflowSlug: string; triggerKind: string; status: string;
  taskId: number | null; startedAt: string; finishedAt: string | null;
};
type Task = {
  id: number; kind: string; status: string; attempts: number; maxAttempts: number;
  error: string | null; idempotencyKey: string | null; createdAt: string;
  finishedAt: string | null;
};
type EventRow = { id: number; name: string; payload: Record<string, unknown>; createdAt: string };
type NotificationRow = {
  id: number; subject: string | null; target: string | null;
  status: string; attempts: number; lastError: string | null; createdAt: string;
};

const STATUS_STYLES: Record<string, string> = {
  succeeded: "cc-badge-ok", published: "cc-badge-ok", sent: "cc-badge-ok",
  failed: "cc-badge-warn", escalated: "cc-badge-warn", suppressed: "cc-badge-muted",
  cancelled: "cc-badge-muted", queued: "cc-badge-muted", pending: "cc-badge-muted",
  claimed: "cc-badge-warn", running: "cc-badge-warn", waiting_approval: "cc-badge-warn",
};

function Badge({ status }: { status: string }) {
  const cls = STATUS_STYLES[status] ?? "cc-badge-muted";
  return <span className={`cc-badge ${cls}`}>{status}</span>;
}

export default function OperationsPage() {
  const [workflows, setWorkflows] = useState<Workflow[]>([]);
  const [runs, setRuns] = useState<WorkflowRun[]>([]);
  const [tasks, setTasks] = useState<Task[]>([]);
  const [events, setEvents] = useState<EventRow[]>([]);
  const [notifications, setNotifications] = useState<NotificationRow[]>([]);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [busy, setBusy] = useState("");

  const load = useCallback(async function load() {
    setError("");
    const rw = await fetch("/api/admin/workflows");
    if (rw.status === 401) { window.location.href = "/login"; return; }
    if (rw.status === 403) { setError("Your role does not include operations read access."); return; }
    if (rw.ok) {
      const d = (await rw.json()) as { data?: { workflows: Workflow[]; runs: WorkflowRun[] } };
      setWorkflows(d.data?.workflows ?? []);
      setRuns(d.data?.runs ?? []);
    }
    const rt = await fetch("/api/admin/tasks?limit=25");
    if (rt.ok) {
      const d = (await rt.json()) as { data?: { tasks: Task[] } };
      setTasks(d.data?.tasks ?? []);
    }
    const re = await fetch("/api/admin/events?limit=25");
    if (re.ok) {
      const d = (await re.json()) as { data?: { events: EventRow[]; notifications: NotificationRow[] } };
      setEvents(d.data?.events ?? []);
      setNotifications(d.data?.notifications ?? []);
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  async function trigger(slug: string) {
    setBusy(`wf-${slug}`); setError(""); setNotice("");
    const r = await fetch("/api/admin/workflows", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ slug }),
    });
    setBusy("");
    if (r.ok) { setNotice(`Workflow ${slug} triggered.`); await load(); }
    else setError(`Trigger failed (${r.status})`);
  }

  async function cancelTask(id: number) {
    setBusy(`t-${id}`); setError(""); setNotice("");
    const r = await fetch(`/api/admin/tasks/${id}`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "cancel" }),
    });
    setBusy("");
    if (r.ok) { setNotice(`Cancellation requested for task #${id}.`); await load(); }
    else setError(`Cancel failed (${r.status})`);
  }

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-xl font-semibold">Operations</h1>
        <p className="text-sm" style={{ color: "var(--muted)" }}>
          Task engine, workflows, events and notifications (Phase 3). Jobs are durable rows —
          retries, backoff and crash recovery are enforced by the queue, not by the browser.
        </p>
      </div>

      {error && <div className="cc-card" style={{ borderColor: "var(--destructive)" }}>{error}</div>}
      {notice && <div className="cc-card">{notice}</div>}

      <section className="cc-card">
        <h2 className="font-semibold mb-2">Workflows</h2>
        <table className="cc-table w-full">
          <thead>
            <tr><th>Slug</th><th>Trigger</th><th>Task kind</th><th>State</th><th></th></tr>
          </thead>
          <tbody>
            {workflows.map((w) => (
              <tr key={w.id}>
                <td className="font-mono text-xs">{w.slug}</td>
                <td>{w.triggerKind}</td>
                <td className="font-mono text-xs">{w.taskKind}</td>
                <td>{w.enabled ? <Badge status="succeeded" /> : <Badge status="cancelled" />}</td>
                <td>
                  <button className="cc-btn cc-btn-primary text-xs" disabled={busy === `wf-${w.slug}`} onClick={() => trigger(w.slug)}>
                    Run now
                  </button>
                </td>
              </tr>
            ))}
            {workflows.length === 0 && <tr><td colSpan={5}>No workflows defined.</td></tr>}
          </tbody>
        </table>
      </section>

      <section className="cc-card">
        <h2 className="font-semibold mb-2">Recent workflow runs</h2>
        <table className="cc-table w-full">
          <thead>
            <tr><th>#</th><th>Workflow</th><th>Trigger</th><th>Status</th><th>Task</th><th>Started</th></tr>
          </thead>
          <tbody>
            {runs.slice(0, 10).map((r) => (
              <tr key={r.id}>
                <td>{r.id}</td>
                <td className="font-mono text-xs">{r.workflowSlug}</td>
                <td>{r.triggerKind}</td>
                <td><Badge status={r.status} /></td>
                <td>{r.taskId ?? "—"}</td>
                <td className="text-xs">{new Date(r.startedAt).toLocaleString()}</td>
              </tr>
            ))}
            {runs.length === 0 && <tr><td colSpan={6}>No runs yet.</td></tr>}
          </tbody>
        </table>
      </section>

      <section className="cc-card">
        <h2 className="font-semibold mb-2">Task queue (latest 25)</h2>
        <table className="cc-table w-full">
          <thead>
            <tr><th>#</th><th>Kind</th><th>Status</th><th>Attempts</th><th>Error</th><th></th></tr>
          </thead>
          <tbody>
            {tasks.map((t) => (
              <tr key={t.id}>
                <td>{t.id}</td>
                <td className="font-mono text-xs">{t.kind}</td>
                <td><Badge status={t.status} /></td>
                <td>{t.attempts}/{t.maxAttempts}</td>
                <td className="text-xs" style={{ maxWidth: 280, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                  {t.error ?? "—"}
                </td>
                <td>
                  {!["succeeded", "failed", "cancelled", "escalated"].includes(t.status) && (
                    <button className="cc-btn cc-btn-danger text-xs" disabled={busy === `t-${t.id}`} onClick={() => cancelTask(t.id)}>
                      Cancel
                    </button>
                  )}
                </td>
              </tr>
            ))}
            {tasks.length === 0 && <tr><td colSpan={6}>No tasks yet.</td></tr>}
          </tbody>
        </table>
      </section>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        <section className="cc-card">
          <h2 className="font-semibold mb-2">Events</h2>
          <table className="cc-table w-full">
            <thead><tr><th>#</th><th>Name</th><th>At</th></tr></thead>
            <tbody>
              {events.slice(0, 12).map((e) => (
                <tr key={e.id}>
                  <td>{e.id}</td>
                  <td className="font-mono text-xs">{e.name}</td>
                  <td className="text-xs">{new Date(e.createdAt).toLocaleString()}</td>
                </tr>
              ))}
              {events.length === 0 && <tr><td colSpan={3}>No events yet.</td></tr>}
            </tbody>
          </table>
        </section>

        <section className="cc-card">
          <h2 className="font-semibold mb-2">Notifications</h2>
          <table className="cc-table w-full">
            <thead><tr><th>#</th><th>Subject</th><th>Status</th><th>Target</th></tr></thead>
            <tbody>
              {notifications.slice(0, 12).map((n) => (
                <tr key={n.id}>
                  <td>{n.id}</td>
                  <td className="text-xs" style={{ maxWidth: 220, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                    {n.subject ?? "—"}
                  </td>
                  <td><Badge status={n.status} /></td>
                  <td className="text-xs">{n.target ?? "—"}</td>
                </tr>
              ))}
              {notifications.length === 0 && <tr><td colSpan={4}>No notifications yet.</td></tr>}
            </tbody>
          </table>
        </section>
      </div>
    </div>
  );
}
