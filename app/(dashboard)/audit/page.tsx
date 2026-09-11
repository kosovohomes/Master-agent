"use client";

import { useCallback, useEffect, useState } from "react";

/**
 * /audit — audit viewer v0 (Phase 1 M3). Read-only, server-filtered via the
 * guarded GET /api/admin/audit (audit.read). Metadata is already sanitized
 * server-side; this viewer renders it as-is.
 */
type AuditRow = {
  id: number; created_at: string; actor_type: string; actor_id: number | null;
  actor_label: string | null; action: string; resource: string | null;
  resource_id: string | null; result: string; request_id: string | null;
  ip: string | null; metadata: Record<string, unknown> | null;
};

const RESULT_STYLES: Record<string, string> = {
  success: "cc-badge-ok",
  failure: "cc-badge-danger",
  denied: "cc-badge-warn",
};

export default function AuditPage() {
  const [rows, setRows] = useState<AuditRow[]>([]);
  const [action, setAction] = useState("");
  const [result, setResult] = useState("");
  const [error, setError] = useState("");

  const load = useCallback(async function load() {
    setError("");
    const params = new URLSearchParams();
    if (action) params.set("action", action);
    if (result) params.set("result", result);
    const r = await fetch(`/api/admin/audit?${params.toString()}`);
    if (r.status === 401) { window.location.href = "/login"; return; }
    if (r.status === 403) { setError("Your role does not include audit.read."); return; }
    if (!r.ok) { setError(`Load failed (${r.status})`); return; }
    const data = (await r.json()) as { data?: AuditRow[] };
    setRows(data.data ?? []);
  }, [action, result]);

  useEffect(() => { void load(); }, [load]);

  return (
    <div className="max-w-6xl mx-auto space-y-6">
      <header>
        <h1 className="text-xl font-semibold">Audit</h1>
        <p className="text-sm" style={{ color: "var(--muted)" }}>
          Every administrative mutation, actor-attributed. Secrets are never recorded.
        </p>
      </header>

      {error && <div className="cc-card text-sm font-medium" style={{ borderColor: "var(--danger)", color: "var(--danger)" }}>{error}</div>}

      <div className="cc-card flex flex-wrap items-end gap-3">
        <div>
          <label className="cc-label" htmlFor="f-action">Action prefix</label>
          <input id="f-action" className="cc-input" value={action} onChange={(e) => setAction(e.target.value)} placeholder="auth. / draft. / bu. / settings." />
        </div>
        <div>
          <label className="cc-label" htmlFor="f-result">Result</label>
          <select id="f-result" className="cc-input" value={result} onChange={(e) => setResult(e.target.value)}>
            <option value="">Any</option>
            <option value="success">success</option>
            <option value="failure">failure</option>
            <option value="denied">denied</option>
          </select>
        </div>
        <button className="cc-btn" onClick={() => void load()}>Apply</button>
      </div>

      <div className="cc-card overflow-x-auto">
        <table className="cc-table">
          <thead>
            <tr>
              <th>Time</th><th>Actor</th><th>Action</th><th>Resource</th><th>Result</th><th>Request</th><th>Metadata</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.id}>
                <td className="whitespace-nowrap">{new Date(r.created_at).toLocaleString()}</td>
                <td>
                  <div className="font-medium">{r.actor_label ?? (r.actor_id != null ? `user ${r.actor_id}` : r.actor_type)}</div>
                  <div className="text-xs" style={{ color: "var(--muted)" }}>{r.actor_type}{r.ip ? ` · ${r.ip}` : ""}</div>
                </td>
                <td className="font-mono text-xs">{r.action}</td>
                <td className="text-xs">
                  {r.resource ?? "—"}
                  {r.resource_id ? ` #${r.resource_id}` : ""}
                </td>
                <td><span className={`cc-badge ${RESULT_STYLES[r.result] ?? "cc-badge-muted"}`}>{r.result}</span></td>
                <td className="font-mono text-xs">{r.request_id ? r.request_id.slice(0, 8) : "—"}</td>
                <td className="text-xs font-mono" style={{ maxWidth: 320, overflowWrap: "anywhere" }}>
                  {r.metadata ? JSON.stringify(r.metadata) : "—"}
                </td>
              </tr>
            ))}
            {rows.length === 0 && <tr><td colSpan={7} className="text-sm" style={{ color: "var(--muted)" }}>No matching audit records.</td></tr>}
          </tbody>
        </table>
      </div>
    </div>
  );
}
