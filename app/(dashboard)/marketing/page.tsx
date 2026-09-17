"use client";

import { useCallback, useEffect, useState } from "react";

/**
 * /marketing — Marketing workforce control screen (Phase 11, roadmap §468:
 * campaigns, audience analysis, performance monitoring).
 *
 * Brief generation (the §91 AUTO leg) → review → explicit campaign creation
 * (still 'draft') → the ACTIVATE button is the approval doorway (launch
 * requires the session user; the service stamps the immutable approver).
 * Pause / resume / complete / cancel round out the FSM; the sweep
 * auto-completes active campaigns past their end date. Metric snapshots are
 * append-only; rollups SUM over them.
 */
type Segment = {
  id: number;
  businessUnitId: number;
  name: string;
  description: string | null;
  estimatedSize: number | null;
  source: string;
  createdAt: string;
};

type Campaign = {
  id: number;
  businessUnitId: number;
  name: string;
  objective: string | null;
  status: string;
  startsAt: string | null;
  endsAt: string | null;
  approvedByUserId: number | null;
  createdByAgent: string | null;
  createdAt: string;
};

type Rollup = {
  campaignId: number;
  impressions: number;
  clicks: number;
  conversions: number;
  spendUsd: number;
  snapshots: number;
};

type Brief = {
  name: string;
  objective: string;
  audienceSummary: string;
  keyMessages: string[];
  channels: string[];
  startOffsetDays: number;
  durationDays: number;
  notes: string | null;
  degraded: boolean;
};

type BusinessUnit = { id: number; name: string; slug: string };

const STATUS_STYLES: Record<string, string> = {
  draft: "cc-badge-warn",
  active: "cc-badge-ok",
  paused: "cc-badge-muted",
  completed: "cc-badge-ok",
  cancelled: "cc-badge-muted",
};

/** FSM actions shown per status — activate = the §91 approval doorway. */
const ACTIONS: Record<string, Array<{ to: string; label: string; primary?: boolean }>> = {
  draft: [{ to: "active", label: "Activate (launch)", primary: true }, { to: "cancelled", label: "Cancel" }],
  active: [{ to: "paused", label: "Pause" }, { to: "completed", label: "Complete" }, { to: "cancelled", label: "Cancel" }],
  paused: [{ to: "active", label: "Resume", primary: true }, { to: "completed", label: "Complete" }, { to: "cancelled", label: "Cancel" }],
  completed: [],
  cancelled: [],
};

export default function MarketingPage() {
  const [segments, setSegments] = useState<Segment[]>([]);
  const [campaigns, setCampaigns] = useState<Campaign[]>([]);
  const [rollups, setRollups] = useState<Rollup[]>([]);
  const [bus, setBus] = useState<BusinessUnit[]>([]);
  const [flag, setFlag] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [busy, setBusy] = useState("");
  const [brief, setBrief] = useState<Brief | null>(null);
  // forms
  const [buId, setBuId] = useState("");
  const [segName, setSegName] = useState("");
  const [segSize, setSegSize] = useState("");
  const [snapCampaign, setSnapCampaign] = useState("");
  const [snapImpr, setSnapImpr] = useState("");
  const [snapClicks, setSnapClicks] = useState("");
  const [snapConv, setSnapConv] = useState("");
  const [snapSpend, setSnapSpend] = useState("");

  const load = useCallback(async function load() {
    setError("");
    const rc = await fetch("/api/admin/marketing");
    if (rc.status === 401) { window.location.href = "/login"; return; }
    if (rc.status === 403) { setError("Your role does not include Marketing manage access."); return; }
    if (rc.ok) {
      const j = (await rc.json()) as { data?: { segments: Segment[]; campaigns: Campaign[]; metrics: Array<{ campaign: Campaign; rollup: Rollup }>; flags: { marketing: boolean } } };
      setSegments(j.data?.segments ?? []);
      setCampaigns(j.data?.campaigns ?? []);
      setRollups((j.data?.metrics ?? []).map((m) => m.rollup));
      setFlag(j.data?.flags?.marketing ?? false);
    }
    const rb = await fetch("/api/admin/business-units");
    if (rb.ok) {
      const j = (await rb.json()) as { data?: BusinessUnit[] };
      setBus(j.data ?? []);
    }
  }, []);

  useEffect(() => { void load(); }, [load]);

  function errText(j: { errors?: { code?: string; detail?: string }[] }, fallback: string): string {
    const e = j.errors?.[0];
    const map: Record<string, string> = {
      BAD_TRANSITION: "That transition is not legal from the current state.",
      TERMINAL: "The campaign is completed/cancelled and can no longer be edited.",
      DUPLICATE: "An entry with that name already exists for this business unit.",
      SEGMENT_NOT_FOUND: "Audience segment not found in this business unit.",
      BAD_WINDOW: "ends_at must be after starts_at.",
      FLAG_DISABLED: "The marketing workforce flag is OFF.",
    };
    return e?.detail ?? map[e?.code ?? ""] ?? fallback;
  }

  async function genBrief() {
    setBusy("brief"); setNotice(""); setError(""); setBrief(null);
    try {
      const res = await fetch("/api/admin/marketing/brief", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ businessUnitId: Number(buId) }),
      });
      const j = (await res.json()) as { data?: { brief: Brief }; errors?: { code?: string; detail?: string }[] };
      if (!res.ok || !j.data) { setError(errText(j, `Brief failed (${res.status})`)); return; }
      setBrief(j.data.brief);
      setNotice(j.data.brief.degraded
        ? "Deterministic brief (LLM unavailable) — grounded in evidence only; review before creating."
        : "LLM brief generated — review, then create the campaign when satisfied.");
    } finally { setBusy(""); }
  }

  async function createFromBrief() {
    if (!brief) return;
    setBusy("create"); setError("");
    try {
      const start = new Date(Date.now() + brief.startOffsetDays * 86_400_000);
      const end = new Date(start.getTime() + brief.durationDays * 86_400_000);
      const res = await fetch("/api/admin/marketing/campaigns", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          businessUnitId: Number(buId),
          name: brief.name,
          objective: brief.objective,
          metadata: { brief: { audienceSummary: brief.audienceSummary, keyMessages: brief.keyMessages, channels: brief.channels, notes: brief.notes } },
          startsAt: start.toISOString(),
          endsAt: end.toISOString(),
          agentSlug: brief.degraded ? null : "marketing",
        }),
      });
      const j = (await res.json()) as { data?: { campaign: Campaign }; errors?: { code?: string; detail?: string }[] };
      if (!res.ok || !j.data) { setError(errText(j, `Create failed (${res.status})`)); return; }
      setNotice(`Campaign #${j.data.campaign.id} created in draft — ACTIVATE to launch it (launch is approval-stamped).`);
      setBrief(null);
      await load();
    } finally { setBusy(""); }
  }

  async function transition(c: Campaign, to: string) {
    setBusy(`c${c.id}`); setNotice(""); setError("");
    try {
      const res = await fetch(`/api/admin/marketing/campaigns/${c.id}/transition`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ to }),
      });
      const j = (await res.json()) as { errors?: { code?: string; detail?: string }[] };
      if (!res.ok) { setError(errText(j, `Transition failed (${res.status})`)); return; }
      setNotice(to === "active" ? `Campaign #${c.id} is LIVE — launch approved by you.` : `Campaign #${c.id} → ${to}.`);
      await load();
    } finally { setBusy(""); }
  }

  async function addSegment() {
    setBusy("seg"); setNotice(""); setError("");
    try {
      const res = await fetch("/api/admin/marketing/segments", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          businessUnitId: Number(buId), name: segName,
          estimatedSize: segSize ? Number(segSize) : null,
        }),
      });
      const j = (await res.json()) as { errors?: { code?: string; detail?: string }[] };
      if (!res.ok) { setError(errText(j, `Segment create failed (${res.status})`)); return; }
      setNotice(`Segment "${segName}" added.`);
      setSegName(""); setSegSize("");
      await load();
    } finally { setBusy(""); }
  }

  async function deleteSegment(s: Segment) {
    setBusy(`s${s.id}`); setError("");
    try {
      const res = await fetch(`/api/admin/marketing/segments/${s.id}`, { method: "DELETE" });
      if (!res.ok) { setError(`Delete failed (${res.status})`); return; }
      await load();
    } finally { setBusy(""); }
  }

  async function ingestSnapshot() {
    setBusy("snap"); setNotice(""); setError("");
    try {
      const res = await fetch("/api/admin/marketing/metrics", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          campaignId: Number(snapCampaign),
          impressions: snapImpr ? Number(snapImpr) : null,
          clicks: snapClicks ? Number(snapClicks) : null,
          conversions: snapConv ? Number(snapConv) : null,
          spendUsd: snapSpend ? Number(snapSpend) : null,
          source: "manual",
        }),
      });
      const j = (await res.json()) as { errors?: { code?: string; detail?: string }[] };
      if (!res.ok) { setError(errText(j, `Snapshot failed (${res.status})`)); return; }
      setNotice(`Metric snapshot stored for campaign #${snapCampaign}.`);
      setSnapImpr(""); setSnapClicks(""); setSnapConv(""); setSnapSpend("");
      await load();
    } finally { setBusy(""); }
  }

  async function runSweep() {
    setBusy("sweep"); setNotice(""); setError("");
    try {
      const res = await fetch("/api/admin/marketing/sweep", { method: "POST" });
      const j = (await res.json()) as { data?: { taskId: number }; errors?: { code?: string; detail?: string }[] };
      if (!res.ok || !j.data) { setError(errText(j, `Sweep failed (${res.status})`)); return; }
      setNotice(`Marketing sweep spawned as task #${j.data.taskId}.`);
      await load();
    } finally { setBusy(""); }
  }

  const input = "cc-input";
  const buName = (id: number) => bus.find((b) => b.id === id)?.name ?? `BU #${id}`;
  const rollupFor = (id: number) => rollups.find((r) => r.campaignId === id);

  return (
    <div className="space-y-6 max-w-6xl">
      <div>
        <h1 className="text-2xl font-semibold">Marketing</h1>
        <p className="text-sm mt-1" style={{ color: "var(--muted)" }}>
          Campaign lifecycle: brief (auto) → draft → human launch (approval-stamped) → performance.
          Activation is the only path to a live campaign and always records your identity.
          <span className={`cc-badge ml-2 ${flag ? "cc-badge-ok" : "cc-badge-muted"}`}>marketing {flag ? "ON" : "OFF"}</span>
        </p>
      </div>

      {error && <div className="cc-badge cc-badge-danger px-3 py-2 rounded-lg text-sm">{error}</div>}
      {notice && <div className="cc-badge cc-badge-ok px-3 py-2 rounded-lg text-sm">{notice}</div>}

      <section className="cc-card p-4">
        <h2 className="font-semibold mb-3">Campaign brief (agent-drafted, human-approved)</h2>
        <div className="grid gap-2" style={{ gridTemplateColumns: "repeat(auto-fit, minmax(180px, 1fr))" }}>
          <select className={input} value={buId} onChange={(e) => setBuId(e.target.value)}>
            <option value="">Business unit…</option>
            {bus.map((b) => <option key={b.id} value={b.id}>{b.name}</option>)}
          </select>
          <button className="cc-btn cc-btn-primary" disabled={busy !== "" || !buId || !flag} onClick={genBrief}>
            {busy === "brief" ? "…" : "Generate brief"}
          </button>
          <button className="cc-btn" disabled={busy !== ""} onClick={runSweep}>
            {busy === "sweep" ? "…" : "Run lifecycle sweep"}
          </button>
        </div>
        {brief && (
          <div className="mt-3 space-y-2 cc-card p-3" style={{ borderColor: "rgba(255,255,255,0.08)" }}>
            <div className="text-sm font-semibold">{brief.name}</div>
            <div className="text-sm">{brief.objective}</div>
            <div className="text-xs" style={{ color: "var(--muted)" }}>Audience: {brief.audienceSummary}</div>
            <ul className="text-xs list-disc pl-5" style={{ color: "var(--muted)" }}>
              {brief.keyMessages.map((m, i) => <li key={i}>{m}</li>)}
            </ul>
            <div className="text-xs" style={{ color: "var(--muted)" }}>
              Channels: {brief.channels.join(", ") || "—"} · starts in {brief.startOffsetDays}d · runs {brief.durationDays}d
              {brief.notes ? ` · ${brief.notes}` : ""}
            </div>
            <button className="cc-btn cc-btn-primary" disabled={busy !== ""} onClick={createFromBrief}>
              {busy === "create" ? "…" : "Create campaign from brief (stays draft)"}
            </button>
          </div>
        )}
        <p className="text-xs mt-2" style={{ color: "var(--muted)" }}>
          Briefs are the AUTO leg: an agent may draft them, but nothing goes live without a human launch.
          If the LLM is unavailable, the deterministic brief is produced strictly from evidence (content,
          segments, connected channels) — nothing is invented.
        </p>
      </section>

      <section className="cc-card p-4">
        <h2 className="font-semibold mb-3">Campaigns ({campaigns.length})</h2>
        <div className="space-y-2">
          {campaigns.length === 0 && <p className="text-sm" style={{ color: "var(--muted)" }}>No campaigns yet — generate a brief or create one manually.</p>}
          {campaigns.map((c) => {
            const r = rollupFor(c.id);
            return (
              <div key={c.id} className="cc-card p-3" style={{ borderColor: "rgba(255,255,255,0.08)" }}>
                <div className="flex flex-wrap items-center gap-2">
                  <span className={`cc-badge ${STATUS_STYLES[c.status] ?? "cc-badge-muted"}`}>{c.status}</span>
                  <span className="text-sm font-medium">{c.name}</span>
                  {c.createdByAgent ? <span className="cc-badge cc-badge-muted">agent: {c.createdByAgent}</span> : null}
                </div>
                <div className="text-xs mt-1" style={{ color: "var(--muted)" }}>
                  {buName(c.businessUnitId)} · {c.objective ?? "no objective"} ·{" "}
                  {c.startsAt ? `${new Date(c.startsAt).toLocaleDateString()} → ${c.endsAt ? new Date(c.endsAt).toLocaleDateString() : "open"}` : "no window"}
                  {c.approvedByUserId ? ` · launched by user #${c.approvedByUserId}` : ""}
                </div>
                {r && r.snapshots > 0 && (
                  <div className="text-xs mt-1" style={{ color: "var(--muted)" }}>
                    {r.impressions} impressions · {r.clicks} clicks · {r.conversions} conversions · ${r.spendUsd.toFixed(2)} spend ({r.snapshots} snapshots)
                  </div>
                )}
                {ACTIONS[c.status]?.length > 0 && (
                  <div className="flex flex-wrap gap-1 mt-2">
                    {ACTIONS[c.status].map((a) => (
                      <button
                        key={a.to}
                        className={a.primary ? "cc-btn cc-btn-primary" : "cc-btn"}
                        disabled={busy !== ""}
                        onClick={() => transition(c, a.to)}
                      >
                        {busy === `c${c.id}` ? "…" : a.label}
                      </button>
                    ))}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      </section>

      <section className="cc-card p-4">
        <h2 className="font-semibold mb-3">Audience segments ({segments.length})</h2>
        <div className="grid gap-2 mb-3" style={{ gridTemplateColumns: "repeat(auto-fit, minmax(160px, 1fr))" }}>
          <select className={input} value={buId} onChange={(e) => setBuId(e.target.value)}>
            <option value="">Business unit…</option>
            {bus.map((b) => <option key={b.id} value={b.id}>{b.name}</option>)}
          </select>
          <input className={input} placeholder="Segment name" value={segName} onChange={(e) => setSegName(e.target.value)} />
          <input className={input} placeholder="Est. size (optional)" inputMode="numeric" value={segSize} onChange={(e) => setSegSize(e.target.value)} />
          <button className="cc-btn cc-btn-primary" disabled={busy !== "" || !buId || !segName.trim()} onClick={addSegment}>Add segment</button>
        </div>
        <div className="overflow-x-auto">
          <table className="cc-table w-full">
            <thead>
              <tr><th>Segment</th><th>BU</th><th>Est. size</th><th>Source</th><th>Created</th><th>Actions</th></tr>
            </thead>
            <tbody>
              {segments.length === 0 && (
                <tr><td colSpan={6} className="text-sm" style={{ color: "var(--muted)" }}>No segments yet.</td></tr>
              )}
              {segments.map((s) => (
                <tr key={s.id}>
                  <td>{s.name}</td>
                  <td className="text-xs">{buName(s.businessUnitId)}</td>
                  <td>{s.estimatedSize ?? "—"}</td>
                  <td className="text-xs">{s.source}</td>
                  <td className="text-xs" style={{ color: "var(--muted)" }}>{new Date(s.createdAt).toLocaleString()}</td>
                  <td><button className="cc-btn" disabled={busy !== ""} onClick={() => deleteSegment(s)}>Delete</button></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      <section className="cc-card p-4">
        <h2 className="font-semibold mb-3">Metric snapshot (append-only)</h2>
        <div className="grid gap-2" style={{ gridTemplateColumns: "repeat(auto-fit, minmax(140px, 1fr))" }}>
          <select className={input} value={snapCampaign} onChange={(e) => setSnapCampaign(e.target.value)}>
            <option value="">Campaign…</option>
            {campaigns.map((c) => <option key={c.id} value={c.id}>#{c.id} {c.name.slice(0, 30)}</option>)}
          </select>
          <input className={input} placeholder="Impressions" inputMode="numeric" value={snapImpr} onChange={(e) => setSnapImpr(e.target.value)} />
          <input className={input} placeholder="Clicks" inputMode="numeric" value={snapClicks} onChange={(e) => setSnapClicks(e.target.value)} />
          <input className={input} placeholder="Conversions" inputMode="numeric" value={snapConv} onChange={(e) => setSnapConv(e.target.value)} />
          <input className={input} placeholder="Spend $" inputMode="decimal" value={snapSpend} onChange={(e) => setSnapSpend(e.target.value)} />
          <button className="cc-btn cc-btn-primary" disabled={busy !== "" || !snapCampaign} onClick={ingestSnapshot}>
            {busy === "snap" ? "…" : "Store snapshot"}
          </button>
        </div>
        <p className="text-xs mt-2" style={{ color: "var(--muted)" }}>
          Snapshots are never overwritten — rollups SUM across them, so provider pulls and manual entries
          coexist without losing history.
        </p>
      </section>
    </div>
  );
}
