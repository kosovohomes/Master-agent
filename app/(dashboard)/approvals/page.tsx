"use client";

import { useCallback, useEffect, useState } from "react";

/**
 * /approvals — the human oversight queue (Phase 1 M1). Replaces the old
 * sessionStorage /admin page. Session-based: the acting user is recorded as
 * the reviewer server-side; schedule vs approve permissions are enforced by
 * the API, and the UI reflects what the caller may do.
 */
type Draft = { id: number; tenant_id: number; agent: string; channel: string; content: string; status: string; review_notes: string | null };
type Bu = { id: number; name: string; legacyTenantId: number | null };

export default function ApprovalsPage() {
  const [bus, setBus] = useState<Bu[]>([]);
  const [selectedBu, setSelectedBu] = useState("");
  const [drafts, setDrafts] = useState<Draft[]>([]);
  const [error, setError] = useState("");
  const [canApprove, setCanApprove] = useState(false);
  const [canSchedule, setCanSchedule] = useState(false);

  const load = useCallback(async function load(tenantId: string) {
    setError("");
    const meRes = await fetch("/api/auth/me");
    if (meRes.status === 401) { window.location.href = "/login"; return; }
    const me = (await meRes.json()) as { data?: { user?: { permissions?: string[] } } };
    const perms = me.data?.user?.permissions ?? [];
    setCanApprove(perms.includes("drafts.approve"));
    setCanSchedule(perms.includes("drafts.schedule"));

    const buRes = await fetch("/api/admin/business-units");
    const buData = (await buRes.json()) as { data?: Bu[] };
    setBus(buData.data ?? []);

    const url = tenantId
      ? `/api/admin/drafts?tenantId=${tenantId}&status=pending`
      : "/api/admin/drafts?status=pending";
    const r = await fetch(url);
    if (r.status === 403) { setError("That business unit is outside your access scope."); setDrafts([]); return; }
    if (!r.ok) { setError(`Load failed (${r.status})`); return; }
    const data = (await r.json()) as { data?: Draft[] };
    setDrafts(data.data ?? []);
  }, []);

  useEffect(() => { void load(""); }, [load]);

  async function act(id: number, action: "approve" | "reject" | "schedule") {
    const comment = action === "reject" ? (window.prompt("Rejection note", "") ?? "") : undefined;
    const r = await fetch(`/api/admin/drafts/${id}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action, comment }),
    });
    if (!r.ok) {
      const j = (await r.json().catch(() => ({}))) as { errors?: { code?: string }[] };
      setError(j.errors?.[0]?.code === "FORBIDDEN" ? "Your role does not permit that action." : `Action failed (${r.status})`);
      return;
    }
    await load(selectedBu);
  }

  return (
    <div className="max-w-3xl mx-auto space-y-6">
      <header>
        <h1 className="text-xl font-semibold">Approvals</h1>
        <p className="text-sm" style={{ color: "var(--muted)" }}>
          Generation is autonomous; publication is human-gated.
        </p>
      </header>

      {error && <div className="cc-card text-sm font-medium" style={{ borderColor: "var(--danger)", color: "var(--danger)" }}>{error}</div>}

      <div className="cc-card flex items-end gap-3">
        <div className="flex-1">
          <label className="cc-label" htmlFor="bu-select">Business unit</label>
          <select
            id="bu-select"
            className="cc-input"
            value={selectedBu}
            onChange={(e) => {
              const v = e.target.value;
              setSelectedBu(v);
              const bu = bus.find((b) => String(b.id) === v);
              void load(bu?.legacyTenantId ? String(bu.legacyTenantId) : "");
            }}
          >
            <option value="">All in scope</option>
            {bus.map((b) => (
              <option key={b.id} value={b.id}>{b.name}</option>
            ))}
          </select>
        </div>
      </div>

      {drafts.map((d) => (
        <article key={d.id} className="cc-card">
          <div className="flex items-center justify-between mb-2">
            <p className="text-sm font-medium">
              #{d.id} · {d.agent} → {d.channel} · tenant {d.tenant_id}
            </p>
            <span className="cc-badge cc-badge-warn">{d.status}</span>
          </div>
          <pre className="whitespace-pre-wrap text-sm" style={{ fontFamily: "inherit" }}>{d.content}</pre>
          <div className="mt-3 flex gap-2">
            {canApprove && d.status === "pending" && (
              <>
                <button className="cc-btn cc-btn-primary text-xs" onClick={() => void act(d.id, "approve")}>Approve</button>
                <button className="cc-btn cc-btn-danger text-xs" onClick={() => void act(d.id, "reject")}>Reject</button>
              </>
            )}
            {canSchedule && d.status === "approved" && (
              <button className="cc-btn text-xs" onClick={() => void act(d.id, "schedule")}>Schedule</button>
            )}
          </div>
        </article>
      ))}
      {drafts.length === 0 && (
        <p className="cc-card text-sm" style={{ color: "var(--muted)" }}>
          No drafts in the queue for the selected scope.
        </p>
      )}
    </div>
  );
}
