"use client";

import { useCallback, useEffect, useState } from "react";

/**
 * /seo — SEO workforce control screen (Phase 9, roadmap §464).
 * Keyword intelligence (the BU keyword store with intent/difficulty/source),
 * recommendations with MANDATORY evidence (kind/risk/status + approve /
 * dismiss / complete approval flags), and the manual scan trigger (durable
 * seo_scan task — the Operations screen shows its steps). Reads and writes
 * /api/admin/seo* (seo.manage server-side).
 */
type Keyword = {
  id: number;
  businessUnitId: number;
  keyword: string;
  intent: string;
  difficultyEst: number | null;
  volumeEst: number | null;
  url: string | null;
  source: string;
  status: string;
  lastSeenAt: string;
};

type Evidence = {
  label: string;
  url?: string | null;
  note: string;
  researchItemId?: number | null;
};

type Recommendation = {
  id: number;
  businessUnitId: number;
  targetKind: string;
  targetUrl: string | null;
  kind: string;
  title: string;
  detail: string;
  evidence: Evidence[];
  status: string;
  risk: string;
  reviewedBy: string | null;
  reviewedAt: string | null;
  createdAt: string;
};

type Stats = {
  keywordsActive: number;
  keywordsRetired: number;
  recommendationsOpen: number;
  recommendationsApproved: number;
  recommendationsDone: number;
  recommendationsDismissed: number;
  withEvidencePct: number;
};

type BusinessUnit = { id: number; name: string; slug: string };

const REC_STATUS_STYLES: Record<string, string> = {
  open: "cc-badge-warn",
  approved: "cc-badge-ok",
  done: "cc-badge-ok",
  dismissed: "cc-badge-muted",
};

const RISK_STYLES: Record<string, string> = {
  low: "cc-badge-muted",
  medium: "cc-badge-warn",
  high: "cc-badge-danger",
};

function StatusBadge({ status }: { status: string }) {
  return <span className={`cc-badge ${REC_STATUS_STYLES[status] ?? "cc-badge-muted"}`}>{status}</span>;
}

export default function SeoPage() {
  const [keywords, setKeywords] = useState<Keyword[]>([]);
  const [recommendations, setRecommendations] = useState<Recommendation[]>([]);
  const [statRows, setStats] = useState<Stats | null>(null);
  const [bus, setBus] = useState<BusinessUnit[]>([]);
  const [flag, setFlag] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [busy, setBusy] = useState("");
  const [expanded, setExpanded] = useState<number | null>(null);
  // scan form
  const [buId, setBuId] = useState("");

  const load = useCallback(async function load() {
    setError("");
    const rc = await fetch("/api/admin/seo");
    if (rc.status === 401) { window.location.href = "/login"; return; }
    if (rc.status === 403) { setError("Your role does not include SEO manage access."); return; }
    if (rc.ok) {
      const j = (await rc.json()) as { data?: { keywords: Keyword[]; recommendations: Recommendation[]; stats: Stats; flag: boolean } };
      setKeywords(j.data?.keywords ?? []);
      setRecommendations(j.data?.recommendations ?? []);
      setStats(j.data?.stats ?? null);
      setFlag(j.data?.flag ?? false);
    }
    const rb = await fetch("/api/admin/business-units");
    if (rb.ok) {
      const j = (await rb.json()) as { data?: BusinessUnit[] };
      setBus(j.data ?? []);
    }
  }, []);

  useEffect(() => { void load(); }, [load]);

  async function runScan() {
    setBusy("scan"); setNotice(""); setError("");
    try {
      const res = await fetch("/api/admin/seo", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ businessUnitId: Number(buId) }),
      });
      const j = (await res.json()) as { data?: { taskId: number }; errors?: { detail?: string }[] };
      if (!res.ok || !j.data) { setError(j.errors?.[0]?.detail ?? `Scan failed (${res.status})`); return; }
      setNotice(`SEO scan spawned as task #${j.data.taskId} — results land here when the engine tick processes it.`);
      await load();
    } finally { setBusy(""); }
  }

  async function decide(rec: Recommendation, action: "approve" | "dismiss" | "complete", note: string) {
    setBusy(`rec-${rec.id}`); setNotice(""); setError("");
    try {
      const res = await fetch(`/api/admin/seo/recommendations/${rec.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action }),
      });
      const j = (await res.json()) as { errors?: { detail?: string }[] };
      if (!res.ok) { setError(j.errors?.[0]?.detail ?? `${action} failed (${res.status})`); return; }
      setNotice(note);
      await load();
    } finally { setBusy(""); }
  }

  async function retireKeyword(k: Keyword) {
    setBusy(`kw-${k.id}`); setNotice(""); setError("");
    try {
      const res = await fetch(`/api/admin/seo/keywords/${k.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ status: "retired" }),
      });
      const j = (await res.json()) as { errors?: { detail?: string }[] };
      if (!res.ok) { setError(j.errors?.[0]?.detail ?? `Retire failed (${res.status})`); return; }
      setNotice(`Keyword "${k.keyword}" retired (scans will not resurrect it).`);
      await load();
    } finally { setBusy(""); }
  }

  const input = "cc-input";
  const buName = (id: number) => bus.find((b) => b.id === id)?.name ?? `BU #${id}`;

  return (
    <div className="space-y-6 max-w-6xl">
      <div>
        <h1 className="text-2xl font-semibold">SEO</h1>
        <p className="text-sm mt-1" style={{ color: "var(--muted)" }}>
          Keyword intelligence, gap analysis and evidence-backed recommendations from the SEO agent.
          Every recommendation cites its sources — approve, dismiss or complete them here.
          <span className={`cc-badge ml-2 ${flag ? "cc-badge-ok" : "cc-badge-muted"}`}>seo {flag ? "ON" : "OFF"}</span>
        </p>
      </div>

      {error && <div className="cc-badge cc-badge-danger px-3 py-2 rounded-lg text-sm">{error}</div>}
      {notice && <div className="cc-badge cc-badge-ok px-3 py-2 rounded-lg text-sm">{notice}</div>}

      <section className="cc-card p-4">
        <h2 className="font-semibold mb-3">Scan</h2>
        <div className="grid gap-2" style={{ gridTemplateColumns: "repeat(auto-fit, minmax(180px, 1fr))" }}>
          <select className={input} value={buId} onChange={(e) => setBuId(e.target.value)}>
            <option value="">Business unit…</option>
            {bus.map((b) => <option key={b.id} value={b.id}>{b.name}</option>)}
          </select>
          <button className="cc-btn cc-btn-primary" disabled={busy !== "" || !buId} onClick={runScan}>
            {busy === "scan" ? "…" : "Run SEO scan"}
          </button>
        </div>
        <p className="text-xs mt-2" style={{ color: "var(--muted)" }}>
          The scan harvests keywords from research findings, content items and competitor intelligence, then
          stores evidence-backed recommendations. Degraded (LLM-unavailable) scans still produce the
          deterministic artifacts — nothing is invented without sources.
        </p>
      </section>

      {statRows && (
        <section className="grid gap-3" style={{ gridTemplateColumns: "repeat(auto-fit, minmax(150px, 1fr))" }}>
          <div className="cc-card p-3"><div className="text-xs" style={{ color: "var(--muted)" }}>Active keywords</div><div className="text-xl font-semibold">{statRows.keywordsActive}</div></div>
          <div className="cc-card p-3"><div className="text-xs" style={{ color: "var(--muted)" }}>Open recommendations</div><div className="text-xl font-semibold">{statRows.recommendationsOpen}</div></div>
          <div className="cc-card p-3"><div className="text-xs" style={{ color: "var(--muted)" }}>Approved</div><div className="text-xl font-semibold">{statRows.recommendationsApproved}</div></div>
          <div className="cc-card p-3"><div className="text-xs" style={{ color: "var(--muted)" }}>Completed</div><div className="text-xl font-semibold">{statRows.recommendationsDone}</div></div>
          <div className="cc-card p-3"><div className="text-xs" style={{ color: "var(--muted)" }}>With evidence</div><div className="text-xl font-semibold">{statRows.withEvidencePct}%</div></div>
        </section>
      )}

      <section className="cc-card p-4">
        <h2 className="font-semibold mb-3">Recommendations ({recommendations.length})</h2>
        <div className="space-y-2">
          {recommendations.length === 0 && <p className="text-sm" style={{ color: "var(--muted)" }}>No recommendations yet — run a scan.</p>}
          {recommendations.map((rec) => (
            <div key={rec.id} className="cc-card p-3" style={{ borderColor: "rgba(255,255,255,0.08)" }}>
              <div className="flex flex-wrap items-center gap-2">
                <StatusBadge status={rec.status} />
                <span className="cc-badge cc-badge-muted">{rec.kind}</span>
                <span className={`cc-badge ${RISK_STYLES[rec.risk] ?? "cc-badge-muted"}`}>{rec.risk} risk</span>
                <button className="text-sm font-medium underline-offset-2 hover:underline" onClick={() => setExpanded(expanded === rec.id ? null : rec.id)}>
                  {rec.title}
                </button>
              </div>
              <div className="text-xs mt-1" style={{ color: "var(--muted)" }}>
                {buName(rec.businessUnitId)} · {new Date(rec.createdAt).toLocaleString()}
                {rec.reviewedBy ? ` · reviewed by ${rec.reviewedBy}` : ""}
              </div>
              {expanded === rec.id && (
                <div className="mt-2 space-y-2">
                  <p className="text-sm">{rec.detail}</p>
                  <div>
                    <div className="text-xs font-semibold mb-1" style={{ color: "var(--muted)" }}>
                      Evidence ({rec.evidence.length})
                    </div>
                    <ul className="text-xs space-y-1" style={{ color: "var(--muted)" }}>
                      {rec.evidence.map((ev, i) => (
                        <li key={i}>
                          {ev.url ? (
                            <a href={ev.url} target="_blank" rel="noreferrer" className="underline underline-offset-2">{ev.label}</a>
                          ) : (
                            <span className="font-medium">{ev.label}</span>
                          )}
                          {" — "}{ev.note}
                          {ev.researchItemId ? <span> (research #{ev.researchItemId})</span> : null}
                        </li>
                      ))}
                    </ul>
                  </div>
                  <div className="flex flex-wrap gap-1">
                    {rec.status === "open" && (
                      <>
                        <button className="cc-btn cc-btn-primary" disabled={busy !== ""} onClick={() => decide(rec, "approve", `Recommendation #${rec.id} approved.`)}>Approve</button>
                        <button className="cc-btn" disabled={busy !== ""} onClick={() => decide(rec, "dismiss", `Recommendation #${rec.id} dismissed.`)}>Dismiss</button>
                      </>
                    )}
                    {rec.status === "approved" && (
                      <button className="cc-btn cc-btn-primary" disabled={busy !== ""} onClick={() => decide(rec, "complete", `Recommendation #${rec.id} marked done.`)}>Mark done</button>
                    )}
                  </div>
                </div>
              )}
            </div>
          ))}
        </div>
      </section>

      <section className="cc-card p-4">
        <h2 className="font-semibold mb-3">Keywords ({keywords.length})</h2>
        <div className="overflow-x-auto">
          <table className="cc-table w-full">
            <thead>
              <tr><th>Keyword</th><th>Intent</th><th>Difficulty</th><th>Est. volume</th><th>Source</th><th>Last seen</th><th>Actions</th></tr>
            </thead>
            <tbody>
              {keywords.length === 0 && (
                <tr><td colSpan={7} className="text-sm" style={{ color: "var(--muted)" }}>No keywords yet — run a scan.</td></tr>
              )}
              {keywords.map((k) => (
                <tr key={k.id}>
                  <td>
                    {k.url ? <a href={k.url} target="_blank" rel="noreferrer" className="underline underline-offset-2">{k.keyword}</a> : k.keyword}
                  </td>
                  <td><span className="cc-badge cc-badge-muted">{k.intent}</span></td>
                  <td>{k.difficultyEst ?? "—"}</td>
                  <td>{k.volumeEst != null ? `${k.volumeEst} est.` : "—"}</td>
                  <td className="text-xs">{k.source}</td>
                  <td className="text-xs" style={{ color: "var(--muted)" }}>{new Date(k.lastSeenAt).toLocaleString()}</td>
                  <td>
                    <button className="cc-btn" disabled={busy !== ""} onClick={() => retireKeyword(k)}>Retire</button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>
    </div>
  );
}
