"use client";

import { useCallback, useEffect, useState } from "react";

/**
 * /websites — Business Unit + Website administration (Phase 1 M2 acceptance:
 * two BUs + two websites configurable through the UI with zero code changes).
 * Create and edit flows call the guarded admin APIs; the server enforces
 * bu.manage / website.manage and audits every mutation.
 */
type Bu = {
  id: number; slug: string; name: string; status: string;
  brandVoice: string; persona: string; audience: string;
  legacyTenantId: number | null; websiteCount: number;
};
type Website = {
  id: number; businessUnitId: number; slug: string; name: string;
  domain: string | null; environment: string; status: string; defaultLocale: string;
};

export default function WebsitesPage() {
  const [bus, setBus] = useState<Bu[]>([]);
  const [websites, setWebsites] = useState<Website[]>([]);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [canManageBu, setCanManageBu] = useState(false);
  const [canManageSite, setCanManageSite] = useState(false);

  // create-BU form
  const [newBuName, setNewBuName] = useState("");
  const [newBuSlug, setNewBuSlug] = useState("");
  const [newBuVoice, setNewBuVoice] = useState("");
  // create-website form
  const [newSiteBu, setNewSiteBu] = useState("");
  const [newSiteName, setNewSiteName] = useState("");
  const [newSiteDomain, setNewSiteDomain] = useState("");

  const load = useCallback(async function load() {
    setError("");
    const [buRes, meRes] = await Promise.all([
      fetch("/api/admin/business-units"),
      fetch("/api/auth/me"),
    ]);
    if (buRes.status === 401 || meRes.status === 401) {
      window.location.href = "/login";
      return;
    }
    const me = (await meRes.json()) as { data?: { user?: { permissions?: string[] } } };
    setCanManageBu((me.data?.user?.permissions ?? []).includes("bu.manage"));
    setCanManageSite((me.data?.user?.permissions ?? []).includes("website.manage"));
    const buData = (await buRes.json()) as { data?: Bu[] };
    setBus(buData.data ?? []);
    const wRes = await fetch("/api/admin/websites");
    if (wRes.ok) {
      const wData = (await wRes.json()) as { data?: Website[] };
      setWebsites(wData.data ?? []);
    }
  }, []);

  useEffect(() => { void load(); }, [load]);

  function fail(msg: string) {
    setError(msg);
    setNotice("");
  }
  function ok(msg: string) {
    setNotice(msg);
    setError("");
  }

  async function createBu(e: React.FormEvent) {
    e.preventDefault();
    if (!newBuName.trim()) return fail("Business unit name is required.");
    const r = await fetch("/api/admin/business-units", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: newBuName.trim(), slug: newBuSlug.trim() || undefined, brandVoice: newBuVoice }),
    });
    const j = (await r.json().catch(() => ({}))) as { errors?: { code?: string; detail?: string }[] };
    if (!r.ok) return fail(j.errors?.[0]?.detail ?? `Create failed (${r.status})`);
    ok(`Business unit “${newBuName.trim()}” created.`);
    setNewBuName(""); setNewBuSlug(""); setNewBuVoice("");
    await load();
  }

  async function createWebsite(e: React.FormEvent) {
    e.preventDefault();
    if (!newSiteBu) return fail("Pick a business unit first.");
    if (!newSiteName.trim()) return fail("Website name is required.");
    const r = await fetch("/api/admin/websites", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        businessUnitId: Number(newSiteBu),
        name: newSiteName.trim(),
        domain: newSiteDomain.trim() || undefined,
      }),
    });
    const j = (await r.json().catch(() => ({}))) as { errors?: { code?: string; detail?: string }[] };
    if (!r.ok) return fail(j.errors?.[0]?.detail ?? `Create failed (${r.status})`);
    ok(`Website “${newSiteName.trim()}” created.`);
    setNewSiteName(""); setNewSiteDomain("");
    await load();
  }

  async function toggleBuStatus(bu: Bu) {
    const r = await fetch("/api/admin/business-units", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id: bu.id, status: bu.status === "active" ? "suspended" : "active" }),
    });
    if (!r.ok) return fail(`Status change failed (${r.status})`);
    await load();
  }

  async function toggleSiteStatus(w: Website) {
    const r = await fetch("/api/admin/websites", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id: w.id, status: w.status === "active" ? "inactive" : "active" }),
    });
    if (!r.ok) return fail(`Status change failed (${r.status})`);
    await load();
  }

  async function editSiteDomain(w: Website) {
    const domain = window.prompt("Website domain (blank to clear)", w.domain ?? "");
    if (domain === null) return;
    const r = await fetch("/api/admin/websites", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id: w.id, domain: domain.trim() || null }),
    });
    if (!r.ok) return fail(`Update failed (${r.status})`);
    await load();
  }

  return (
    <div className="max-w-5xl mx-auto space-y-6">
      <header>
        <h1 className="text-xl font-semibold">Websites</h1>
        <p className="text-sm" style={{ color: "var(--muted)" }}>
          Businesses and their sites are configuration rows — adding one never requires a deploy.
        </p>
      </header>

      {error && <div className="cc-card text-sm font-medium" style={{ borderColor: "var(--danger)", color: "var(--danger)" }}>{error}</div>}
      {notice && <div className="cc-card text-sm font-medium" style={{ borderColor: "var(--ok)", color: "var(--ok)" }}>{notice}</div>}

      <section className="cc-card">
        <h2 className="text-sm font-semibold mb-3">Business units</h2>
        <table className="cc-table">
          <thead>
            <tr><th>Name</th><th>Slug</th><th>Status</th><th>Websites</th><th>Legacy tenant</th>{canManageBu && <th />}</tr>
          </thead>
          <tbody>
            {bus.map((b) => (
              <tr key={b.id}>
                <td className="font-medium">{b.name}</td>
                <td>{b.slug}</td>
                <td><span className={`cc-badge ${b.status === "active" ? "cc-badge-ok" : "cc-badge-warn"}`}>{b.status}</span></td>
                <td>{b.websiteCount}</td>
                <td>{b.legacyTenantId ?? "—"}</td>
                {canManageBu && (
                  <td>
                    <button className="cc-btn text-xs" onClick={() => void toggleBuStatus(b)}>
                      {b.status === "active" ? "Suspend" : "Activate"}
                    </button>
                  </td>
                )}
              </tr>
            ))}
            {bus.length === 0 && <tr><td colSpan={6} className="text-sm" style={{ color: "var(--muted)" }}>None visible.</td></tr>}
          </tbody>
        </table>

        {canManageBu && (
          <form onSubmit={createBu} className="grid gap-3 sm:grid-cols-4 mt-4 items-end">
            <div className="sm:col-span-2">
              <label className="cc-label" htmlFor="bu-name">New business unit</label>
              <input id="bu-name" className="cc-input" value={newBuName} onChange={(e) => setNewBuName(e.target.value)} placeholder="WakeelyPro" />
            </div>
            <div>
              <label className="cc-label" htmlFor="bu-slug">Slug (optional)</label>
              <input id="bu-slug" className="cc-input" value={newBuSlug} onChange={(e) => setNewBuSlug(e.target.value)} placeholder="auto from name" />
            </div>
            <button type="submit" className="cc-btn cc-btn-primary">Create business unit</button>
            <div className="sm:col-span-4">
              <label className="cc-label" htmlFor="bu-voice">Brand voice (optional)</label>
              <input id="bu-voice" className="cc-input" value={newBuVoice} onChange={(e) => setNewBuVoice(e.target.value)} placeholder="Tone and voice for generated content" />
            </div>
          </form>
        )}
      </section>

      <section className="cc-card">
        <h2 className="text-sm font-semibold mb-3">Websites</h2>
        <table className="cc-table">
          <thead>
            <tr><th>Name</th><th>Slug</th><th>Business unit</th><th>Domain</th><th>Env</th><th>Status</th>{canManageSite && <th />}</tr>
          </thead>
          <tbody>
            {websites.map((w) => (
              <tr key={w.id}>
                <td className="font-medium">{w.name}</td>
                <td>{w.slug}</td>
                <td>{bus.find((b) => b.id === w.businessUnitId)?.name ?? w.businessUnitId}</td>
                <td>{w.domain ?? "—"}</td>
                <td>{w.environment}</td>
                <td><span className={`cc-badge ${w.status === "active" ? "cc-badge-ok" : "cc-badge-muted"}`}>{w.status}</span></td>
                {canManageSite && (
                  <td className="space-x-2 whitespace-nowrap">
                    <button className="cc-btn text-xs" onClick={() => void editSiteDomain(w)}>Domain</button>
                    <button className="cc-btn text-xs" onClick={() => void toggleSiteStatus(w)}>
                      {w.status === "active" ? "Disable" : "Enable"}
                    </button>
                  </td>
                )}
              </tr>
            ))}
            {websites.length === 0 && <tr><td colSpan={7} className="text-sm" style={{ color: "var(--muted)" }}>None visible.</td></tr>}
          </tbody>
        </table>

        {canManageSite && (
          <form onSubmit={createWebsite} className="grid gap-3 sm:grid-cols-4 mt-4 items-end">
            <div>
              <label className="cc-label" htmlFor="ws-bu">Business unit</label>
              <select id="ws-bu" className="cc-input" value={newSiteBu} onChange={(e) => setNewSiteBu(e.target.value)}>
                <option value="">Choose…</option>
                {bus.map((b) => <option key={b.id} value={b.id}>{b.name}</option>)}
              </select>
            </div>
            <div>
              <label className="cc-label" htmlFor="ws-name">Website name</label>
              <input id="ws-name" className="cc-input" value={newSiteName} onChange={(e) => setNewSiteName(e.target.value)} placeholder="Marketing site" />
            </div>
            <div>
              <label className="cc-label" htmlFor="ws-domain">Domain (optional)</label>
              <input id="ws-domain" className="cc-input" value={newSiteDomain} onChange={(e) => setNewSiteDomain(e.target.value)} placeholder="example.com" />
            </div>
            <button type="submit" className="cc-btn cc-btn-primary">Create website</button>
          </form>
        )}
      </section>
    </div>
  );
}
