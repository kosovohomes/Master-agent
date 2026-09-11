"use client";

import { useCallback, useEffect, useState } from "react";

/**
 * /agents — agent registry dashboard v1 (Phase 2).
 * Agents are data: this screen reads the registry and flips the enablement
 * layers (global status, per-BU enablement). Every mutation is enforced and
 * audited server-side; this UI only sends intents. Prompt versioning is
 * exposed read-only here (history + changelog) — the version editor arrives
 * with the Phase 7 content screens.
 */
type RegistryAgent = {
  id: number; slug: string; name: string; description: string;
  agentKind: string; executorKind: string; status: string;
  currentVersion: { id: number; version: number; changelog: string | null } | null;
};

type BuLink = { businessUnitId: number; agentId: number; enabled: boolean; config: Record<string, unknown> };

type Bu = { id: number; slug: string; name: string };

type VersionRow = {
  id: number; version: number; systemPrompt: string; changelog: string | null; createdAt: string;
};

const STATUS_STYLES: Record<string, string> = {
  active: "cc-badge-ok",
  disabled: "cc-badge-muted",
  archived: "cc-badge-warn",
};

export default function AgentsPage() {
  const [agents, setAgents] = useState<RegistryAgent[]>([]);
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [bus, setBus] = useState<Bu[]>([]);
  const [links, setLinks] = useState<Record<number, BuLink[]>>({});
  const [versions, setVersions] = useState<{ slug: string; rows: VersionRow[] } | null>(null);

  const load = useCallback(async function load() {
    setError("");
    const r = await fetch("/api/admin/agents");
    if (r.status === 401) { window.location.href = "/login"; return; }
    if (r.status === 403) { setError("Your role does not include registry read access."); return; }
    if (!r.ok) { setError(`Load failed (${r.status})`); return; }
    const data = (await r.json()) as { data?: RegistryAgent[] };
    setAgents(data.data ?? []);

    const rb = await fetch("/api/admin/business-units");
    if (rb.ok) {
      const bd = (await rb.json()) as { data?: Bu[] };
      setBus(bd.data ?? []);
      const next: Record<number, BuLink[]> = {};
      await Promise.all(
        (bd.data ?? []).map(async (bu) => {
          const lr = await fetch(`/api/admin/agents?businessUnitId=${bu.id}`);
          if (lr.ok) {
            const ld = (await lr.json()) as { data?: BuLink[] };
            next[bu.id] = ld.data ?? [];
          }
        })
      );
      setLinks(next);
    }
  }, []);

  useEffect(() => { void load(); }, [load]);

  async function patch(body: Record<string, unknown>, label: string) {
    setBusy(label); setError(""); setNotice("");
    const r = await fetch("/api/admin/agents", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    setBusy("");
    if (r.status === 403) { setError("Your role does not include agents.manage."); return; }
    if (!r.ok) {
      const j = (await r.json().catch(() => ({}))) as { errors?: { code?: string; detail?: string }[] };
      setError(j.errors?.[0]?.detail ?? j.errors?.[0]?.code ?? `Update failed (${r.status})`);
      return;
    }
    setNotice("Registry updated — behavior propagates within one run.");
    await load();
  }

  async function showVersions(slug: string) {
    setError("");
    const r = await fetch(`/api/admin/agents/versions?slug=${encodeURIComponent(slug)}`);
    if (!r.ok) { setError(`Version load failed (${r.status})`); return; }
    const d = (await r.json()) as { data?: VersionRow[] };
    setVersions({ slug, rows: d.data ?? [] });
  }

  return (
    <div className="max-w-6xl mx-auto space-y-6">
      <header>
        <h1 className="text-xl font-semibold">Agents</h1>
        <p className="text-sm" style={{ color: "var(--muted)" }}>
          The workforce registry. Enabled agents run without deploys; every run is attributed to its prompt version.
        </p>
      </header>

      {error && <div className="cc-card text-sm font-medium" style={{ borderColor: "var(--danger)", color: "var(--danger)" }}>{error}</div>}
      {notice && <div className="cc-card text-sm font-medium" style={{ borderColor: "var(--ok)", color: "var(--ok)" }}>{notice}</div>}

      <div className="cc-card overflow-x-auto">
        <table className="cc-table">
          <thead>
            <tr><th>Agent</th><th>Kind</th><th>Executor</th><th>Status</th><th>Version</th><th>Actions</th></tr>
          </thead>
          <tbody>
            {agents.map((a) => (
              <tr key={a.id}>
                <td>
                  <div className="font-medium">{a.name}</div>
                  <div className="text-xs font-mono" style={{ color: "var(--muted)" }}>{a.slug}</div>
                  <div className="text-xs" style={{ color: "var(--muted)" }}>{a.description}</div>
                </td>
                <td className="text-xs">{a.agentKind}</td>
                <td className="text-xs font-mono">{a.executorKind}</td>
                <td><span className={`cc-badge ${STATUS_STYLES[a.status] ?? "cc-badge-muted"}`}>{a.status}</span></td>
                <td className="text-xs">
                  {a.currentVersion ? `v${a.currentVersion.version}` : "—"}
                  {a.currentVersion?.changelog ? <div style={{ color: "var(--muted)" }}>{a.currentVersion.changelog}</div> : null}
                </td>
                <td>
                  <div className="flex flex-wrap gap-2">
                    {a.status === "active" ? (
                      <button
                        className="cc-btn text-xs"
                        disabled={busy === `${a.slug}:status`}
                        onClick={() => void patch({ slug: a.slug, status: "disabled" }, `${a.slug}:status`)}
                      >
                        Disable
                      </button>
                    ) : a.status === "disabled" ? (
                      <button
                        className="cc-btn text-xs"
                        disabled={busy === `${a.slug}:status`}
                        onClick={() => void patch({ slug: a.slug, status: "active" }, `${a.slug}:status`)}
                      >
                        Enable
                      </button>
                    ) : null}
                    <button className="cc-btn text-xs" onClick={() => void showVersions(a.slug)}>History</button>
                  </div>
                  {bus.length > 0 && (a.status === "active" || a.status === "disabled") && (
                    <div className="mt-2 space-y-1">
                      {bus.map((bu) => {
                        const link = links[bu.id]?.find((l) => l.agentId === a.id);
                        return (
                          <div key={bu.id} className="flex items-center gap-2 text-xs">
                            <span style={{ color: "var(--muted)" }}>{bu.name}:</span>
                            <span className="font-medium">{link ? (link.enabled ? "enabled" : "disabled") : "default"}</span>
                            {link ? (
                              <button
                                className="cc-btn text-xs"
                                disabled={busy === `${a.slug}:bu:${bu.id}`}
                                onClick={() => void patch({ slug: a.slug, businessUnitId: bu.id, enabled: !link.enabled }, `${a.slug}:bu:${bu.id}`)}
                              >
                                {link.enabled ? "Enable for BU" : "Disable for BU"}
                              </button>
                            ) : (
                              <button
                                className="cc-btn text-xs"
                                disabled={busy === `${a.slug}:bu:${bu.id}`}
                                onClick={() => void patch({ slug: a.slug, businessUnitId: bu.id, enabled: false }, `${a.slug}:bu:${bu.id}`)}
                              >
                                Disable for BU
                              </button>
                            )}
                          </div>
                        );
                      })}
                    </div>
                  )}
                </td>
              </tr>
            ))}
            {agents.length === 0 && <tr><td colSpan={6} className="text-sm" style={{ color: "var(--muted)" }}>Registry is empty — run migrations.</td></tr>}
          </tbody>
        </table>
      </div>

      {versions && (
        <div className="cc-card space-y-3">
          <div className="flex items-center justify-between">
            <h2 className="text-sm font-semibold">Prompt history — {versions.slug}</h2>
            <button className="cc-btn text-xs" onClick={() => setVersions(null)}>Close</button>
          </div>
          <div className="space-y-2">
            {versions.rows.map((v) => (
              <div key={v.id} className="rounded-lg border p-3 text-xs" style={{ borderColor: "rgba(255,255,255,0.12)" }}>
                <div className="flex items-center gap-2">
                  <span className="font-mono font-semibold">v{v.version}</span>
                  <span style={{ color: "var(--muted)" }}>{new Date(v.createdAt).toLocaleString()}</span>
                  {v.changelog ? <span style={{ color: "var(--muted)" }}>· {v.changelog}</span> : null}
                </div>
                <pre className="mt-2 whitespace-pre-wrap font-mono" style={{ color: "var(--muted)" }}>{v.systemPrompt}</pre>
              </div>
            ))}
            {versions.rows.length === 0 && <div className="text-xs" style={{ color: "var(--muted)" }}>No versions recorded.</div>}
          </div>
        </div>
      )}
    </div>
  );
}
