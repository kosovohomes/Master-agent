"use client";

import { useCallback, useEffect, useState } from "react";

/**
 * /connectors — Website connector control screen (Phase 6).
 * Connector lifecycle (create with reveal-once signing secret / rotate /
 * enable / delete), §394 capability grants per website, and the signed
 * webhook receipt log with verdicts (signature_valid, accepted / rejected /
 * failed + spawned task). Reads and writes /api/admin/connectors*
 * (connectors.manage server-side). Webhook URL convention:
 *   POST /api/integrations/<websiteId>/events
 */
type Connector = {
  id: number;
  websiteId: number;
  businessUnitId: number;
  websiteName: string;
  websiteSlug: string;
  type: string;
  displayName: string | null;
  status: string;
  signingAlgo: string;
  capabilities: string[];
  lastEventAt: string | null;
  rotatedAt: string | null;
  deliveries24h: number;
  failed24h: number;
};

type Website = { id: number; name: string; slug: string; status: string };

type Delivery = {
  id: number;
  deliveryId: string;
  eventType: string;
  signatureValid: boolean;
  status: string;
  rejectionReason: string | null;
  taskId: number | null;
  createdAt: string;
};

const STATUS_STYLES: Record<string, string> = {
  active: "cc-badge-ok",
  error: "cc-badge-warn",
  disabled: "cc-badge-muted",
  rejected: "cc-badge-warn",
  failed: "cc-badge-danger",
  received: "cc-badge-muted",
  accepted: "cc-badge-ok",
};

const CAPABILITIES = [
  "READ_CONTENT",
  "CREATE_CONTENT",
  "UPDATE_CONTENT",
  "PUBLISH_CONTENT",
  "READ_LEADS",
  "CREATE_LEAD",
  "READ_ANALYTICS",
  "SEND_NOTIFICATION",
  "READ_PRODUCTS",
];

function Badge({ status }: { status: string }) {
  return <span className={`cc-badge ${STATUS_STYLES[status] ?? "cc-badge-muted"}`}>{status}</span>;
}

export default function ConnectorsPage() {
  const [connectors, setConnectors] = useState<Connector[]>([]);
  const [websites, setWebsites] = useState<Website[]>([]);
  const [flag, setFlag] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [busy, setBusy] = useState("");
  // create form
  const [websiteId, setWebsiteId] = useState("");
  const [displayName, setDisplayName] = useState("");
  // reveal-once secret
  const [secret, setSecret] = useState<{ connectorId: number; secret: string } | null>(null);
  // grants + deliveries for the selected connector
  const [selectedId, setSelectedId] = useState<number | null>(null);
  const [grants, setGrants] = useState<Record<string, boolean>>({});
  const [deliveries, setDeliveries] = useState<Delivery[]>([]);

  const load = useCallback(async function load() {
    setError("");
    const rc = await fetch("/api/admin/connectors");
    if (rc.status === 401) { window.location.href = "/login"; return; }
    if (rc.status === 403) { setError("Your role does not include connector manage access."); return; }
    if (rc.ok) {
      const j = (await rc.json()) as { data?: { connectors: Connector[]; flag: boolean } };
      setConnectors(j.data?.connectors ?? []);
      setFlag(j.data?.flag ?? false);
    }
    const rw = await fetch("/api/admin/websites");
    if (rw.ok) {
      const j = (await rw.json()) as { data?: Website[] };
      setWebsites(j.data ?? []);
    }
  }, []);

  useEffect(() => { void load(); }, [load]);

  const selected = connectors.find((c) => c.id === selectedId) ?? null;

  const loadGrants = useCallback(async function (connector: Connector) {
    const res = await fetch(`/api/admin/connectors/${connector.id}/capabilities`);
    if (!res.ok) return;
    const j = (await res.json()) as { data?: { grants: { capability: string; enabled: boolean }[] } };
    const map: Record<string, boolean> = {};
    for (const c of CAPABILITIES) map[c] = false;
    for (const g of j.data?.grants ?? []) if (g.capability in map) map[g.capability] = g.enabled;
    setGrants(map);
  }, []);

  const loadDeliveries = useCallback(async function (connectorId: number) {
    const res = await fetch(`/api/admin/connectors/${connectorId}/deliveries?limit=50`);
    if (!res.ok) return;
    const j = (await res.json()) as { data?: { deliveries: Delivery[] } };
    setDeliveries(j.data?.deliveries ?? []);
  }, []);

  function select(connector: Connector) {
    setSelectedId(connector.id);
    setDeliveries([]);
    void loadGrants(connector);
    void loadDeliveries(connector.id);
  }

  async function createConnector() {
    setBusy("create"); setNotice(""); setError(""); setSecret(null);
    try {
      const res = await fetch("/api/admin/connectors", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ websiteId: Number(websiteId), displayName: displayName || null }),
      });
      const j = (await res.json()) as { data?: { connector: Connector; signingSecret: string }; errors?: { detail?: string }[] };
      if (!res.ok || !j.data) { setError(j.errors?.[0]?.detail ?? `Create failed (${res.status})`); return; }
      setSecret({ connectorId: j.data.connector.id, secret: j.data.signingSecret });
      setNotice(`Connector #${j.data.connector.id} created. The signing secret is shown once below.`);
      setWebsiteId(""); setDisplayName("");
      await load();
      select(j.data.connector);
    } finally { setBusy(""); }
  }

  async function rotate(c: Connector) {
    setBusy(`rot-${c.id}`); setNotice(""); setError(""); setSecret(null);
    try {
      const res = await fetch(`/api/admin/connectors/${c.id}`, { method: "POST" });
      const j = (await res.json()) as { data?: { signingSecret: string }; errors?: { detail?: string }[] };
      if (!res.ok || !j.data) { setError(j.errors?.[0]?.detail ?? `Rotate failed (${res.status})`); return; }
      setSecret({ connectorId: c.id, secret: j.data.signingSecret });
      setNotice(`Secret rotated for connector #${c.id}. The previous secret stays valid for 24h (zero-downtime cutover).`);
      await load();
    } finally { setBusy(""); }
  }

  async function patch(c: Connector, body: Record<string, unknown>, note: string) {
    setBusy(`patch-${c.id}`); setNotice(""); setError("");
    try {
      const res = await fetch(`/api/admin/connectors/${c.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      if (!res.ok) {
        const j = (await res.json()) as { errors?: { detail?: string }[] };
        setError(j.errors?.[0]?.detail ?? `Update failed (${res.status})`);
        return;
      }
      setNotice(note);
      await load();
    } finally { setBusy(""); }
  }

  async function remove(c: Connector) {
    setBusy(`del-${c.id}`); setNotice(""); setError("");
    try {
      const res = await fetch(`/api/admin/connectors/${c.id}`, { method: "DELETE" });
      if (!res.ok) { setError(`Delete failed (${res.status})`); return; }
      setNotice("Connector deleted.");
      if (selectedId === c.id) { setSelectedId(null); setDeliveries([]); setGrants({}); }
      await load();
    } finally { setBusy(""); }
  }

  async function toggleGrant(capability: string) {
    if (!selected) return;
    setBusy(`cap-${capability}`); setError("");
    try {
      const res = await fetch(`/api/admin/connectors/${selected.id}/capabilities`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ capability, enabled: !grants[capability] }),
      });
      if (!res.ok) {
        const j = (await res.json()) as { errors?: { detail?: string }[] };
        setError(j.errors?.[0]?.detail ?? `Grant failed (${res.status})`);
        return;
      }
      setGrants((g) => ({ ...g, [capability]: !g[capability] }));
      await load();
    } finally { setBusy(""); }
  }

  const input = "cc-input";
  const webhookBase = typeof window !== "undefined" ? window.location.origin : "";

  return (
    <div className="space-y-6 max-w-6xl">
      <div>
        <h1 className="text-2xl font-semibold">Connectors</h1>
        <p className="text-sm mt-1" style={{ color: "var(--muted)" }}>
          Signed inbound webhooks per website: HMAC-SHA256 signatures, 5-minute timestamp window,
          replay protection, zero-downtime secret rotation, and §394 capability grants.
          <span className={`cc-badge ml-2 ${flag ? "cc-badge-ok" : "cc-badge-muted"}`}>connectors {flag ? "ON" : "OFF"}</span>
        </p>
      </div>

      {error && <div className="cc-badge cc-badge-danger px-3 py-2 rounded-lg text-sm">{error}</div>}
      {notice && <div className="cc-badge cc-badge-ok px-3 py-2 rounded-lg text-sm">{notice}</div>}

      {secret && (
        <section className="cc-card p-4" style={{ borderColor: "rgba(250,204,21,0.4)" }}>
          <h2 className="font-semibold mb-2">Signing secret for connector #{secret.connectorId} — shown once</h2>
          <p className="text-xs mb-2" style={{ color: "var(--muted)" }}>
            Configure your site to send: <code>POST {webhookBase}/api/integrations/{connectors.find((c) => c.id === secret.connectorId)?.websiteId ?? "&lt;websiteId&gt;"}/events</code> with headers
            <code> X-AgentOS-Signature: t=&lt;unix_seconds&gt;,v1=hex</code> and <code>X-AgentOS-Delivery</code>, where
            <code> v1 = HMAC_SHA256(secret, t + &quot;.&quot; + rawBody)</code>.
          </p>
          <div className="flex items-center gap-2">
            <code className="text-xs p-2 rounded-lg flex-1 overflow-x-auto" style={{ background: "rgba(255,255,255,0.05)" }}>{secret.secret}</code>
            <button className="cc-btn" onClick={() => { void navigator.clipboard?.writeText(secret.secret); setNotice("Secret copied to clipboard."); }}>
              Copy
            </button>
            <button className="cc-btn" onClick={() => setSecret(null)}>I stored it</button>
          </div>
        </section>
      )}

      <section className="cc-card p-4">
        <h2 className="font-semibold mb-3">Connectors ({connectors.length})</h2>
        <div className="overflow-x-auto">
          <table className="cc-table w-full">
            <thead>
              <tr>
                <th>ID</th><th>Website</th><th>Type</th><th>Status</th><th>Capabilities</th>
                <th>Last event</th><th>24h deliveries</th><th>Actions</th>
              </tr>
            </thead>
            <tbody>
              {connectors.map((c) => (
                <tr key={c.id} style={selectedId === c.id ? { outline: "1px solid rgba(99,102,241,0.6)" } : undefined}>
                  <td>{c.id}</td>
                  <td>
                    <div>{c.websiteName}</div>
                    <div className="text-xs" style={{ color: "var(--muted)" }}>{c.websiteSlug} · site #{c.websiteId}</div>
                  </td>
                  <td>{c.type}</td>
                  <td><Badge status={c.status} /></td>
                  <td>
                    <div className="flex flex-wrap gap-1 max-w-[220px]">
                      {c.capabilities.length === 0
                        ? <span className="text-xs" style={{ color: "var(--muted)" }}>none granted</span>
                        : c.capabilities.map((cap) => <span key={cap} className="cc-badge cc-badge-muted">{cap}</span>)}
                    </div>
                  </td>
                  <td className="text-xs" style={{ color: "var(--muted)" }}>
                    {c.lastEventAt ? new Date(c.lastEventAt).toLocaleString() : "never"}
                  </td>
                  <td className="text-xs">
                    {c.deliveries24h}
                    {c.failed24h > 0 && <span style={{ color: "var(--danger)" }}> ({c.failed24h} failed)</span>}
                  </td>
                  <td className="whitespace-nowrap">
                    <button className="cc-btn cc-btn-primary mr-1" disabled={busy !== ""} onClick={() => select(c)}>
                      {selectedId === c.id ? "Selected" : "Inspect"}
                    </button>
                    <button className="cc-btn mr-1" disabled={busy !== ""} onClick={() => rotate(c)}>
                      {busy === `rot-${c.id}` ? "…" : "Rotate"}
                    </button>
                    <button
                      className="cc-btn mr-1"
                      disabled={busy !== ""}
                      onClick={() => patch(c, { status: c.status === "disabled" ? "active" : "disabled" }, c.status === "disabled" ? "Connector enabled." : "Connector disabled.")}
                    >
                      {c.status === "disabled" ? "Enable" : "Disable"}
                    </button>
                    <button className="cc-btn cc-btn-danger" disabled={busy !== ""} onClick={() => remove(c)}>Delete</button>
                  </td>
                </tr>
              ))}
              {connectors.length === 0 && (
                <tr><td colSpan={8} className="text-sm" style={{ color: "var(--muted)" }}>No connectors yet — create one below.</td></tr>
              )}
            </tbody>
          </table>
        </div>
      </section>

      <section className="cc-card p-4">
        <h2 className="font-semibold mb-3">Create connector</h2>
        <div className="grid gap-3 md:grid-cols-3">
          <label className="text-xs" style={{ color: "var(--muted)" }}>Website
            <select className={`${input} mt-1`} value={websiteId} onChange={(e) => setWebsiteId(e.target.value)}>
              <option value="">choose a website…</option>
              {websites.map((w) => <option key={w.id} value={w.id}>{w.name} (#{w.id})</option>)}
            </select>
          </label>
          <label className="text-xs" style={{ color: "var(--muted)" }}>Display name
            <input className={`${input} mt-1`} value={displayName} onChange={(e) => setDisplayName(e.target.value)} placeholder="e.g. Marketing site webhook" />
          </label>
          <div className="flex items-end">
            <button className="cc-btn cc-btn-primary" disabled={busy !== "" || websiteId === ""} onClick={createConnector}>
              {busy === "create" ? "Creating…" : "Create webhook connector"}
            </button>
          </div>
        </div>
      </section>

      {selected && (
        <>
          <section className="cc-card p-4">
            <h2 className="font-semibold mb-1">Capability grants — {selected.websiteName} (site #{selected.websiteId})</h2>
            <p className="text-xs mb-3" style={{ color: "var(--muted)" }}>
              §394: an event is executed only when its capability is granted here. content.sync requires READ_CONTENT.
            </p>
            <div className="grid gap-2 md:grid-cols-3">
              {CAPABILITIES.map((cap) => (
                <label key={cap} className="flex items-center gap-2 text-sm rounded-lg border p-2" style={{ borderColor: "rgba(255,255,255,0.1)" }}>
                  <input
                    type="checkbox"
                    checked={grants[cap] ?? false}
                    disabled={busy !== ""}
                    onChange={() => toggleGrant(cap)}
                  />
                  <span>{cap}</span>
                </label>
              ))}
            </div>
          </section>

          <section className="cc-card p-4">
            <h2 className="font-semibold mb-3">Webhook deliveries — connector #{selected.id}</h2>
            <div className="overflow-x-auto">
              <table className="cc-table w-full">
                <thead>
                  <tr><th>When</th><th>Event</th><th>Delivery</th><th>Sig</th><th>Status</th><th>Detail</th><th>Task</th></tr>
                </thead>
                <tbody>
                  {deliveries.map((d) => (
                    <tr key={d.id}>
                      <td className="text-xs" style={{ color: "var(--muted)" }}>{new Date(d.createdAt).toLocaleString()}</td>
                      <td>{d.eventType}</td>
                      <td className="text-xs max-w-[140px] truncate" title={d.deliveryId}>{d.deliveryId}</td>
                      <td><span className={`cc-badge ${d.signatureValid ? "cc-badge-ok" : "cc-badge-danger"}`}>{d.signatureValid ? "valid" : "invalid"}</span></td>
                      <td><Badge status={d.status} /></td>
                      <td className="text-xs" style={{ color: "var(--muted)" }}>{d.rejectionReason ?? "—"}</td>
                      <td className="text-xs">{d.taskId != null ? `#${d.taskId}` : "—"}</td>
                    </tr>
                  ))}
                  {deliveries.length === 0 && (
                    <tr><td colSpan={7} className="text-sm" style={{ color: "var(--muted)" }}>No deliveries yet.</td></tr>
                  )}
                </tbody>
              </table>
            </div>
          </section>
        </>
      )}
    </div>
  );
}
