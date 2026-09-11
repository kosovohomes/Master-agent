"use client";

import { useCallback, useEffect, useState } from "react";

/**
 * /settings — Settings foundation (Phase 1 M3): feature flags and the
 * emergency controls (stop_all_agents, disable_publishing). Toggling calls
 * the guarded PUT /api/admin/settings (settings.manage) and is audited.
 */
type Flag = { key: string; enabled: boolean; emergency: boolean; description: string | null; updatedAt: string };

export default function SettingsPage() {
  const [flags, setFlags] = useState<Flag[]>([]);
  const [canManage, setCanManage] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");

  const load = useCallback(async function load() {
    setError("");
    const [r, meRes] = await Promise.all([fetch("/api/admin/settings"), fetch("/api/auth/me")]);
    if (r.status === 401 || meRes.status === 401) { window.location.href = "/login"; return; }
    const me = (await meRes.json()) as { data?: { user?: { permissions?: string[] } } };
    setCanManage((me.data?.user?.permissions ?? []).includes("settings.manage"));
    if (r.status === 403) { setError("Your role does not include settings access."); return; }
    if (!r.ok) { setError(`Load failed (${r.status})`); return; }
    const data = (await r.json()) as { data?: { flags?: Flag[] } };
    setFlags(data.data?.flags ?? []);
  }, []);

  useEffect(() => { void load(); }, [load]);

  async function toggle(flag: Flag) {
    setNotice(""); setError("");
    const r = await fetch("/api/admin/settings", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ flags: [{ key: flag.key, enabled: !flag.enabled }] }),
    });
    if (r.status === 403) { setError("Your role does not include settings.manage."); return; }
    if (!r.ok) { setError(`Update failed (${r.status})`); return; }
    setNotice(`${flag.key} → ${!flag.enabled ? "ON" : "OFF"}`);
    await load();
  }

  return (
    <div className="max-w-3xl mx-auto space-y-6">
      <header>
        <h1 className="text-xl font-semibold">Settings</h1>
        <p className="text-sm" style={{ color: "var(--muted)" }}>
          Feature flags and emergency controls. Changes are audit-logged.
        </p>
      </header>

      {error && <div className="cc-card text-sm font-medium" style={{ borderColor: "var(--danger)", color: "var(--danger)" }}>{error}</div>}
      {notice && <div className="cc-card text-sm font-medium" style={{ borderColor: "var(--ok)", color: "var(--ok)" }}>{notice}</div>}

      <section className="cc-card">
        <h2 className="text-sm font-semibold mb-3">Feature &amp; emergency flags</h2>
        <table className="cc-table">
          <thead>
            <tr><th>Flag</th><th>State</th><th>Description</th><th>Updated</th>{canManage && <th />}</tr>
          </thead>
          <tbody>
            {flags.map((f) => (
              <tr key={f.key} style={f.emergency && f.enabled ? { background: "color-mix(in srgb, var(--danger) 6%, transparent)" } : undefined}>
                <td className="font-mono text-xs font-semibold">
                  {f.key}
                  {f.emergency && <span className="cc-badge cc-badge-danger ml-2">emergency</span>}
                </td>
                <td>
                  <span className={`cc-badge ${f.enabled ? "cc-badge-danger" : "cc-badge-muted"}`}>{f.enabled ? "ON" : "OFF"}</span>
                </td>
                <td className="text-sm">{f.description ?? "—"}</td>
                <td className="text-xs whitespace-nowrap">{new Date(f.updatedAt).toLocaleString()}</td>
                {canManage && (
                  <td>
                    <button className={`cc-btn text-xs ${f.emergency && !f.enabled ? "cc-btn-danger" : ""}`} onClick={() => void toggle(f)}>
                      {f.enabled ? "Turn off" : "Turn on"}
                    </button>
                  </td>
                )}
              </tr>
            ))}
            {flags.length === 0 && <tr><td colSpan={5} className="text-sm" style={{ color: "var(--muted)" }}>No flags visible.</td></tr>}
          </tbody>
        </table>
      </section>

      <section className="cc-card text-sm" style={{ color: "var(--muted)" }}>
        <p>
          <strong style={{ color: "var(--foreground)" }}>Emergency semantics:</strong>{" "}
          <code>stop_all_agents</code> blocks agent execution and public chat LLM spend immediately;
          <code>disable_publishing</code> halts the scheduled publishing sweep. Approval state and
          stored credentials are untouched. Turning a flag off restores the behavior without a deploy.
        </p>
      </section>
    </div>
  );
}
