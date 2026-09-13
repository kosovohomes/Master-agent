"use client";

import { useCallback, useEffect, useState } from "react";

/**
 * /research — Research workforce control screen (Phase 7, roadmap P6).
 * Scheduled research (create / run-now / enable / delete), the findings
 * feed with citation provenance + score + confidence (verify / reject /
 * archive / escalate), unprocessed items with one-click reprocess, and the
 * competitor registry with its detected-events log. Reads and writes
 * /api/admin/research* + /api/admin/competitors* (research.manage
 * server-side).
 */
type Source = {
  index: number;
  title: string;
  url: string | null;
  snippet: string;
  fetchedAt: string | null;
  revision: string | null;
};

type Item = {
  id: number;
  businessUnitId: number;
  scheduleId: number | null;
  agentSlug: string;
  topic: string;
  query: string | null;
  status: string;
  title: string | null;
  summary: string | null;
  analysis: Record<string, unknown> | null;
  score: number | null;
  confidence: number | null;
  sources: Source[];
  createdAt: string;
  reviewedAt: string | null;
  reviewedBy: string | null;
};

type Schedule = {
  id: number;
  businessUnitId: number;
  agentSlug: string;
  name: string;
  topic: string;
  queries: string[];
  sources: { kind: string; ref: string }[];
  cadence: string;
  maxItems: number;
  enabled: boolean;
  lastRunAt: string | null;
};

type Competitor = {
  id: number;
  businessUnitId: number;
  name: string;
  url: string | null;
  notes: string | null;
  enabled: boolean;
};

type CompetitorEvent = {
  id: number;
  competitorId: number;
  kind: string;
  title: string;
  url: string | null;
  detectedAt: string;
};

type BusinessUnit = { id: number; name: string; slug: string };

const STATUS_STYLES: Record<string, string> = {
  finding: "cc-badge-ok",
  verified: "cc-badge-ok",
  escalated: "cc-badge-danger",
  unprocessed: "cc-badge-warn",
  rejected: "cc-badge-muted",
  archived: "cc-badge-muted",
};

function Badge({ status }: { status: string }) {
  return <span className={`cc-badge ${STATUS_STYLES[status] ?? "cc-badge-muted"}`}>{status}</span>;
}

export default function ResearchPage() {
  const [items, setItems] = useState<Item[]>([]);
  const [schedules, setSchedules] = useState<Schedule[]>([]);
  const [competitors, setCompetitors] = useState<Competitor[]>([]);
  const [events, setEvents] = useState<CompetitorEvent[]>([]);
  const [bus, setBus] = useState<BusinessUnit[]>([]);
  const [flag, setFlag] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [busy, setBusy] = useState("");
  const [expanded, setExpanded] = useState<number | null>(null);
  // schedule form
  const [buId, setBuId] = useState("");
  const [agentSlug, setAgentSlug] = useState("research");
  const [name, setName] = useState("");
  const [topic, setTopic] = useState("");
  const [cadence, setCadence] = useState("daily");
  const [sources, setSources] = useState("");
  // competitor form
  const [compName, setCompName] = useState("");
  const [compUrl, setCompUrl] = useState("");
  const [compBu, setCompBu] = useState("");

  const load = useCallback(async function load() {
    setError("");
    const rc = await fetch("/api/admin/research");
    if (rc.status === 401) { window.location.href = "/login"; return; }
    if (rc.status === 403) { setError("Your role does not include research manage access."); return; }
    if (rc.ok) {
      const j = (await rc.json()) as { data?: { items: Item[]; schedules: Schedule[]; competitors: Competitor[]; events: CompetitorEvent[]; flag: boolean } };
      setItems(j.data?.items ?? []);
      setSchedules(j.data?.schedules ?? []);
      setCompetitors(j.data?.competitors ?? []);
      setEvents(j.data?.events ?? []);
      setFlag(j.data?.flag ?? false);
    }
    const rb = await fetch("/api/admin/business-units");
    if (rb.ok) {
      const j = (await rb.json()) as { data?: BusinessUnit[] };
      setBus(j.data ?? []);
    }
  }, []);

  useEffect(() => { void load(); }, [load]);

  async function createSchedule() {
    setBusy("create"); setNotice(""); setError("");
    try {
      const res = await fetch("/api/admin/research", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          businessUnitId: Number(buId), agentSlug, name, topic, cadence,
          sources: sources.split("\n").map((s) => s.trim()).filter(Boolean),
        }),
      });
      const j = (await res.json()) as { data?: { schedule: Schedule }; errors?: { detail?: string }[] };
      if (!res.ok || !j.data) { setError(j.errors?.[0]?.detail ?? `Create failed (${res.status})`); return; }
      setNotice(`Schedule #${j.data.schedule.id} created (${j.data.schedule.agentSlug}, ${j.data.schedule.cadence}, ${j.data.schedule.sources.length} source(s)).`);
      setName(""); setTopic(""); setSources("");
      await load();
    } finally { setBusy(""); }
  }

  async function runNow(s: Schedule) {
    setBusy(`run-${s.id}`); setNotice(""); setError("");
    try {
      const res = await fetch(`/api/admin/research/schedules/${s.id}/run`, { method: "POST" });
      const j = (await res.json()) as { data?: { taskId: number }; errors?: { detail?: string }[] };
      if (!res.ok || !j.data) { setError(j.errors?.[0]?.detail ?? `Run failed (${res.status})`); return; }
      setNotice(`Research run spawned as task #${j.data.taskId} — watch it on the Operations screen.`);
      await load();
    } finally { setBusy(""); }
  }

  async function patchSchedule(s: Schedule, body: Record<string, unknown>, note: string) {
    setBusy(`sch-${s.id}`); setNotice(""); setError("");
    try {
      const res = await fetch(`/api/admin/research/schedules/${s.id}`, {
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

  async function removeSchedule(s: Schedule) {
    setBusy(`del-${s.id}`); setNotice(""); setError("");
    try {
      const res = await fetch(`/api/admin/research/schedules/${s.id}`, { method: "DELETE" });
      if (!res.ok) {
        const j = (await res.json()) as { errors?: { detail?: string }[] };
        setError(j.errors?.[0]?.detail ?? `Delete failed (${res.status})`);
        return;
      }
      setNotice(`Schedule #${s.id} deleted (findings retained).`);
      await load();
    } finally { setBusy(""); }
  }

  async function reviewItem(item: Item, action: string, note: string) {
    setBusy(`it-${item.id}`); setNotice(""); setError("");
    try {
      const res = await fetch(`/api/admin/research/items/${item.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action }),
      });
      const j = (await res.json()) as { data?: { taskId?: number }; errors?: { detail?: string }[] };
      if (!res.ok) { setError(j.errors?.[0]?.detail ?? `${action} failed (${res.status})`); return; }
      setNotice(j.data?.taskId ? `Reprocess spawned as task #${j.data.taskId}.` : note);
      await load();
    } finally { setBusy(""); }
  }

  async function createCompetitor() {
    setBusy("comp"); setNotice(""); setError("");
    try {
      const res = await fetch("/api/admin/competitors", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ businessUnitId: Number(compBu || buId), name: compName, url: compUrl || null }),
      });
      const j = (await res.json()) as { data?: { competitor: Competitor }; errors?: { detail?: string }[] };
      if (!res.ok || !j.data) { setError(j.errors?.[0]?.detail ?? `Create failed (${res.status})`); return; }
      setNotice(`Competitor "${j.data.competitor.name}" is now tracked.`);
      setCompName(""); setCompUrl("");
      await load();
    } finally { setBusy(""); }
  }

  async function removeCompetitor(c: Competitor) {
    setBusy(`cdel-${c.id}`); setNotice(""); setError("");
    try {
      const res = await fetch(`/api/admin/competitors/${c.id}`, { method: "DELETE" });
      if (!res.ok) {
        const j = (await res.json()) as { errors?: { detail?: string }[] };
        setError(j.errors?.[0]?.detail ?? `Delete failed (${res.status})`);
        return;
      }
      setNotice(`Competitor "${c.name}" untracked (events cascade, findings kept).`);
      await load();
    } finally { setBusy(""); }
  }

  const input = "cc-input";
  const buName = (id: number) => bus.find((b) => b.id === id)?.name ?? `BU #${id}`;
  const competitorName = (id: number) => competitors.find((c) => c.id === id)?.name ?? `#${id}`;

  return (
    <div className="space-y-6 max-w-6xl">
      <div>
        <h1 className="text-2xl font-semibold">Research</h1>
        <p className="text-sm mt-1" style={{ color: "var(--muted)" }}>
          Scheduled AI / legal-AI / competitor intelligence: web_search + fetch_url tools, cited and
          scored findings, ambiguity escalation, human review before anything downstream.
          <span className={`cc-badge ml-2 ${flag ? "cc-badge-ok" : "cc-badge-muted"}`}>research {flag ? "ON" : "OFF"}</span>
        </p>
      </div>

      {error && <div className="cc-badge cc-badge-danger px-3 py-2 rounded-lg text-sm">{error}</div>}
      {notice && <div className="cc-badge cc-badge-ok px-3 py-2 rounded-lg text-sm">{notice}</div>}

      <section className="cc-card p-4">
        <h2 className="font-semibold mb-3">Schedules ({schedules.length})</h2>
        <div className="overflow-x-auto">
          <table className="cc-table w-full">
            <thead>
              <tr><th>ID</th><th>BU</th><th>Name</th><th>Agent</th><th>Cadence</th><th>Last run</th><th>Actions</th></tr>
            </thead>
            <tbody>
              {schedules.length === 0 && (
                <tr><td colSpan={7} className="text-sm" style={{ color: "var(--muted)" }}>No schedules yet — create one below.</td></tr>
              )}
              {schedules.map((s) => (
                <tr key={s.id}>
                  <td>{s.id}</td>
                  <td className="text-xs">{buName(s.businessUnitId)}</td>
                  <td>
                    <div>{s.name}</div>
                    <div className="text-xs" style={{ color: "var(--muted)" }}>{s.topic}</div>
                    {s.sources.length > 0 && (
                      <div className="text-xs" style={{ color: "var(--muted)" }}>monitors {s.sources.length} source(s)</div>
                    )}
                  </td>
                  <td><span className="cc-badge cc-badge-muted">{s.agentSlug}</span></td>
                  <td>{s.cadence}<span className="text-xs" style={{ color: "var(--muted)" }}> · {s.maxItems}/run</span></td>
                  <td className="text-xs" style={{ color: "var(--muted)" }}>{s.lastRunAt ? new Date(s.lastRunAt).toLocaleString() : "never"}</td>
                  <td className="whitespace-nowrap">
                    <button className="cc-btn cc-btn-primary mr-1" disabled={busy !== "" || !flag} onClick={() => runNow(s)} title={flag ? "" : "research flag is OFF"}>
                      {busy === `run-${s.id}` ? "…" : "Run now"}
                    </button>
                    <button className="cc-btn mr-1" disabled={busy !== ""}
                      onClick={() => patchSchedule(s, { enabled: !s.enabled }, s.enabled ? "Schedule paused." : "Schedule enabled.")}>
                      {s.enabled ? "Pause" : "Enable"}
                    </button>
                    <button className="cc-btn" disabled={busy !== ""} onClick={() => removeSchedule(s)}>Delete</button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <div className="grid gap-2 mt-4" style={{ gridTemplateColumns: "repeat(auto-fit, minmax(180px, 1fr))" }}>
          <select className={input} value={buId} onChange={(e) => setBuId(e.target.value)}>
            <option value="">Business unit…</option>
            {bus.map((b) => <option key={b.id} value={b.id}>{b.name}</option>)}
          </select>
          <select className={input} value={agentSlug} onChange={(e) => setAgentSlug(e.target.value)}>
            <option value="research">research</option>
            <option value="intelligence">intelligence</option>
            <option value="legal_intelligence">legal_intelligence</option>
            <option value="competitor">competitor</option>
          </select>
          <input className={input} placeholder="Schedule name (e.g. daily AI news)" value={name} onChange={(e) => setName(e.target.value)} />
          <input className={input} placeholder="Topic — {{date}} expands to today" value={topic} onChange={(e) => setTopic(e.target.value)} />
          <select className={input} value={cadence} onChange={(e) => setCadence(e.target.value)}>
            <option value="daily">daily</option>
            <option value="weekly">weekly</option>
            <option value="hourly">hourly</option>
          </select>
          <textarea
            className={input}
            placeholder={"Monitored sources — one URL per line\nRSS feed, sitemap.xml, or page\n(max 6)"}
            value={sources}
            onChange={(e) => setSources(e.target.value)}
            style={{ gridColumn: "1 / -1", minHeight: 64 }}
          />
          <button className="cc-btn cc-btn-primary" disabled={busy !== "" || !buId || !name || !topic} onClick={createSchedule}>
            {busy === "create" ? "…" : "Create schedule"}
          </button>
        </div>
      </section>

      <section className="cc-card p-4">
        <h2 className="font-semibold mb-3">Findings ({items.length})</h2>
        <div className="space-y-2">
          {items.length === 0 && <p className="text-sm" style={{ color: "var(--muted)" }}>No research items yet.</p>}
          {items.map((it) => (
            <div key={it.id} className="cc-card p-3" style={{ borderColor: "rgba(255,255,255,0.08)" }}>
              <div className="flex flex-wrap items-center gap-2">
                <Badge status={it.status} />
                <span className="cc-badge cc-badge-muted">{it.agentSlug}</span>
                <button className="text-sm font-medium underline-offset-2 hover:underline" onClick={() => setExpanded(expanded === it.id ? null : it.id)}>
                  {it.title ?? `(unprocessed) ${it.topic}`}
                </button>
                {it.score != null && <span className="text-xs" style={{ color: "var(--muted)" }}>score {it.score}</span>}
                {it.confidence != null && <span className="text-xs" style={{ color: "var(--muted)" }}>conf {Math.round(it.confidence * 100)}%</span>}
                <span className="text-xs ml-auto" style={{ color: "var(--muted)" }}>{new Date(it.createdAt).toLocaleString()}</span>
              </div>
              {it.summary && <p className="text-sm mt-2" style={{ color: "var(--muted)" }}>{it.summary.slice(0, 280)}{it.summary.length > 280 ? "…" : ""}</p>}
              <div className="flex flex-wrap gap-1 mt-2">
                {(it.status === "finding" || it.status === "escalated") && (
                  <>
                    <button className="cc-btn mr-1" disabled={busy !== ""} onClick={() => reviewItem(it, "verify", "Finding verified.")}>Verify</button>
                    <button className="cc-btn mr-1" disabled={busy !== ""} onClick={() => reviewItem(it, "reject", "Finding rejected.")}>Reject</button>
                    <button className="cc-btn mr-1" disabled={busy !== ""} onClick={() => reviewItem(it, "archive", "Finding archived.")}>Archive</button>
                  </>
                )}
                {it.status === "unprocessed" && (
                  <button className="cc-btn cc-btn-primary" disabled={busy !== "" || !flag} onClick={() => reviewItem(it, "process", "Reprocess queued.")} title={flag ? "" : "research flag is OFF"}>
                    Process now
                  </button>
                )}
              </div>
              {expanded === it.id && (
                <div className="mt-3 text-xs space-y-2" style={{ color: "var(--muted)" }}>
                  <div>Topic: {it.topic}{it.query ? ` · query: "${it.query}"` : ""}{it.reviewedBy ? ` · reviewed by ${it.reviewedBy}` : ""}</div>
                  {it.analysis != null && Object.keys(it.analysis).length > 0 && (
                    <div>
                      {Object.entries(it.analysis).map(([k, v]) => (
                        <div key={k} className="mb-1">
                          <span style={{ color: "var(--fg)" }}>{k}:</span>{" "}
                          {(Array.isArray(v) ? v : []).map(String).join(" | ")}
                        </div>
                      ))}
                    </div>
                  )}
                  <div>
                    Sources:
                    <ul className="list-disc ml-4 mt-1 space-y-1">
                      {(it.sources ?? []).map((s) => (
                        <li key={s.index}>
                          [{s.index}] {s.url ? <a href={s.url} target="_blank" rel="noreferrer" className="underline">{s.title}</a> : s.title}
                          {s.revision ? <span> · rev {s.revision}</span> : null}
                          <div className="text-[11px] opacity-70">{s.snippet.slice(0, 160)}…</div>
                        </li>
                      ))}
                    </ul>
                  </div>
                </div>
              )}
            </div>
          ))}
        </div>
      </section>

      <section className="cc-card p-4">
        <h2 className="font-semibold mb-3">Competitors ({competitors.length})</h2>
        <table className="cc-table w-full">
          <thead>
            <tr><th>Name</th><th>BU</th><th>URL</th><th>Events</th><th>Actions</th></tr>
          </thead>
          <tbody>
            {competitors.length === 0 && (
              <tr><td colSpan={5} className="text-sm" style={{ color: "var(--muted)" }}>No competitors tracked.</td></tr>
            )}
            {competitors.map((c) => {
              const n = events.filter((e) => e.competitorId === c.id).length;
              return (
                <tr key={c.id}>
                  <td>{c.name}</td>
                  <td className="text-xs">{buName(c.businessUnitId)}</td>
                  <td className="text-xs">{c.url ? <a href={c.url} target="_blank" rel="noreferrer" className="underline">{c.url}</a> : "—"}</td>
                  <td className="text-xs">{n}</td>
                  <td><button className="cc-btn" disabled={busy !== ""} onClick={() => removeCompetitor(c)}>Untrack</button></td>
                </tr>
              );
            })}
          </tbody>
        </table>
        <div className="flex flex-wrap gap-2 mt-4">
          <select className={`${input} max-w-[220px]`} value={compBu || buId} onChange={(e) => setCompBu(e.target.value)}>
            <option value="">Business unit…</option>
            {bus.map((b) => <option key={b.id} value={b.id}>{b.name}</option>)}
          </select>
          <input className={`${input} max-w-[220px]`} placeholder="Competitor name" value={compName} onChange={(e) => setCompName(e.target.value)} />
          <input className={`${input} max-w-[280px]`} placeholder="https://competitor.example" value={compUrl} onChange={(e) => setCompUrl(e.target.value)} />
          <button className="cc-btn cc-btn-primary" disabled={busy !== "" || !compName || !(compBu || buId)} onClick={createCompetitor}>
            {busy === "comp" ? "…" : "Track competitor"}
          </button>
        </div>
        {events.length > 0 && (
          <div className="mt-4">
            <h3 className="text-sm font-semibold mb-2">Detected events (latest)</h3>
            <ul className="text-xs space-y-1" style={{ color: "var(--muted)" }}>
              {events.slice(0, 10).map((e) => (
                <li key={e.id}>
                  <span className="cc-badge cc-badge-muted mr-1">{e.kind}</span>
                  {competitorName(e.competitorId)} — {e.title}
                  {e.url ? <> · <a href={e.url} target="_blank" rel="noreferrer" className="underline">source</a></> : null}
                  {" · "}{new Date(e.detectedAt).toLocaleString()}
                </li>
              ))}
            </ul>
          </div>
        )}
      </section>
    </div>
  );
}
