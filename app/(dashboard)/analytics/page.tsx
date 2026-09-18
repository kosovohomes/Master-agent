"use client";

import { useCallback, useEffect, useState } from "react";

/**
 * /analytics — Analytics + Strategy workforce screen (Phase 13, roadmap
 * P12: §99 cross-BU aggregate dashboards, §102–§103 reports, recommendations
 * store).
 *
 * Every number on this screen comes from the aggregate layer (counts and
 * sums only). Platform-level artifacts (reports, recommendations, the per-BU
 * breakdown) are visible ONLY to owner-level scopes — the API filters by
 * buScopeForUser and the UI simply renders what it receives.
 */

type Metrics = {
  businessUnits: number; websites: number; users: number;
  leads: { total: number; newStage: number; qualified: number; won: number; lost: number; hotOpen: number };
  inquiries: { total: number; escalated: number; spam: number; resolved: number };
  conversations: { total: number; escalated: number };
  content: { items: number; inReview: number; approved: number; published: number };
  social: { posts: number; published: number; failed: number };
  campaigns: { active: number; completed: number };
  marketing: { impressions: number; clicks: number; conversions: number; spendUsd: number };
  llm: { requests: number; errors: number; promptTokens: number; completionTokens: number; costUsd: number };
  research: { findings: number; escalated: number };
  seo: { openRecommendations: number };
  tasks: { failed: number; escalated: number };
};

type BreakdownRow = {
  businessUnitId: number; businessUnitName: string; leads: number; hotLeads: number;
  inquiries: number; escalatedInquiries: number; contentItems: number; socialPosts: number;
  campaignSpendUsd: number; llmRequests: number; llmCostUsd: number;
};

type Report = {
  id: number; businessUnitId: number | null; periodKind: string; periodKey: string;
  status: string; title: string; summary: string | null;
  payload: { insights?: { metric: string; direction: string; observation: string }[]; provenance?: { insightsBy: string; narrativeBy: string; recommendationsBy: string; promptVersion: number } };
  narrative: { summary: string; highlights: string[]; risks: string[] } | null;
  generatedBy: string | null; degraded: boolean; createdAt: string;
};

type Recommendation = {
  id: number; businessUnitId: number | null; source: string; reportId: number | null;
  kind: string; priority: string; title: string; detail: string; evidence: string[];
  status: string; reviewedBy: string | null; createdAt: string;
};

type Schedule = { id: number; businessUnitId: number | null; cadence: string; enabled: boolean; lastRunAt: string | null };

type Summary = {
  reportsReady: number; reportsFailed: number; recommendationsOpen: number;
  recommendationsAccepted: number; schedules: number;
};

type Payload = {
  scope: string; windowDays: number; metrics: Metrics; breakdown: BreakdownRow[];
  reports: Report[]; recommendations: Recommendation[]; schedules: Schedule[];
  summary: Summary; flags: { analytics: boolean };
};

const PRIORITY_STYLES: Record<string, string> = {
  high: "cc-badge cc-badge-danger",
  medium: "cc-badge cc-badge-warn",
  low: "cc-badge cc-badge-muted",
};

function errText(j: { errors?: { code?: string; detail?: string }[] }, fallback: string): string {
  const e = j?.errors?.[0];
  return e ? [e.code, e.detail].filter(Boolean).join(": ") : fallback;
}

export default function AnalyticsPage() {
  const [data, setData] = useState<Payload | null>(null);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [busy, setBusy] = useState("");
  const [detail, setDetail] = useState<Report | null>(null);
  const [scope, setScope] = useState("platform");
  const [days, setDays] = useState("30");

  const load = useCallback(async function load() {
    const res = await fetch("/api/admin/analytics");
    if (res.status === 401) { window.location.href = "/login"; return; }
    const j = (await res.json()) as { data?: Payload; errors?: { code?: string; detail?: string }[] };
    if (!res.ok || !j.data) { setError(errText(j, `Load failed (${res.status})`)); return; }
    setData(j.data);
  }, []);

  useEffect(() => { void load(); }, [load]);

  async function generate() {
    setBusy("generate"); setError(""); setNotice("");
    try {
      const body = {
        businessUnitId: scope === "platform" ? null : Number(scope),
        days: Number(days) || 30,
      };
      const res = await fetch("/api/admin/analytics/reports", {
        method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
      });
      const j = (await res.json()) as { data?: { report: Report; created: boolean }; errors?: { code?: string; detail?: string }[] };
      if (!res.ok || !j.data) { setError(errText(j, `Generation failed (${res.status})`)); return; }
      setNotice(j.data.created
        ? `Report #${j.data.report.id} generated (${j.data.report.generatedBy ?? "deterministic"}${j.data.report.degraded ? ", degraded" : ""}).`
        : `Report #${j.data.report.id} for this minute already existed.`);
      await load();
      setDetail(j.data.report);
    } finally { setBusy(""); }
  }

  async function decide(id: number, action: "accept" | "dismiss") {
    setBusy(`rec-${id}`); setError(""); setNotice("");
    try {
      const res = await fetch(`/api/admin/analytics/recommendations/${id}`, {
        method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action }),
      });
      const j = (await res.json()) as { data?: { recommendation: Recommendation }; errors?: { code?: string; detail?: string }[] };
      if (!res.ok || !j.data) { setError(errText(j, `Transition failed (${res.status})`)); return; }
      setNotice(`Recommendation #${id} ${j.data.recommendation.status}.`);
      await load();
    } finally { setBusy(""); }
  }

  async function openDetail(id: number) {
    setBusy(`view-${id}`); setError("");
    try {
      const res = await fetch(`/api/admin/analytics/reports/${id}`);
      const j = (await res.json()) as { data?: { report: Report }; errors?: { code?: string; detail?: string }[] };
      if (!res.ok || !j.data) { setError(errText(j, `Load failed (${res.status})`)); return; }
      setDetail(j.data.report);
    } finally { setBusy(""); }
  }

  if (!data) {
    return (
      <div className="max-w-6xl">
        <h1 className="text-2xl font-semibold">Analytics</h1>
        {error ? <div className="cc-badge cc-badge-danger px-3 py-2 rounded-lg text-sm mt-3">{error}</div> : <p className="text-sm mt-3">Loading…</p>}
      </div>
    );
  }

  const m = data.metrics;
  const flag = data.flags.analytics;

  return (
    <div className="space-y-6 max-w-6xl">
      <div>
        <h1 className="text-2xl font-semibold">Analytics</h1>
        <p className="text-sm mt-1">
          Owner-level cross-BU reporting with per-BU privacy (§99): every figure here is an aggregate
          (count or sum). Scheduled digests run daily / weekly / monthly (§102–§103); recommendations
          store strategy advice with the evidence that justifies it.
        </p>
        <div className="flex flex-wrap items-center gap-2 mt-2">
          <span className={flag ? "cc-badge cc-badge-ok" : "cc-badge cc-badge-muted"}>
            analytics workforce: {flag ? "ON" : "OFF (reads unaffected; generation 423)"}
          </span>
          <span className="cc-badge cc-badge-muted">scope: {data.scope === "all" ? "owner (all BUs)" : "own BUs"}</span>
          <span className="cc-badge cc-badge-muted">window: last {data.windowDays} days</span>
        </div>
      </div>

      {error && <div className="cc-badge cc-badge-danger px-3 py-2 rounded-lg text-sm">{error}</div>}
      {notice && <div className="cc-badge cc-badge-ok px-3 py-2 rounded-lg text-sm">{notice}</div>}

      {/* Aggregate stat grid */}
      <div className="grid gap-2" style={{ gridTemplateColumns: "repeat(auto-fit, minmax(140px, 1fr))" }}>
        <div className="cc-card p-3"><div className="text-xs">Leads (window)</div><div className="text-2xl font-semibold">{m.leads.total}</div><div className="text-xs mt-1">{m.leads.hotOpen} hot open</div></div>
        <div className="cc-card p-3"><div className="text-xs">Inquiries</div><div className="text-2xl font-semibold">{m.inquiries.total}</div><div className="text-xs mt-1">{m.inquiries.escalated} escalated</div></div>
        <div className="cc-card p-3"><div className="text-xs">Content published</div><div className="text-2xl font-semibold">{m.content.published}</div><div className="text-xs mt-1">{m.content.inReview} in review</div></div>
        <div className="cc-card p-3"><div className="text-xs">Campaign spend</div><div className="text-2xl font-semibold">${m.marketing.spendUsd.toFixed(2)}</div><div className="text-xs mt-1">{m.marketing.conversions} conversions</div></div>
        <div className="cc-card p-3"><div className="text-xs">LLM requests</div><div className="text-2xl font-semibold">{m.llm.requests}</div><div className="text-xs mt-1">${m.llm.costUsd.toFixed(4)} · {m.llm.errors} errors</div></div>
        <div className="cc-card p-3"><div className="text-xs">Reports ready</div><div className="text-2xl font-semibold">{data.summary.reportsReady}</div><div className="text-xs mt-1">{data.summary.reportsFailed} failed</div></div>
        <div className="cc-card p-3"><div className="text-xs">Open recommendations</div><div className="text-2xl font-semibold">{data.summary.recommendationsOpen}</div><div className="text-xs mt-1">{data.summary.recommendationsAccepted} accepted</div></div>
      </div>

      {/* Cross-BU breakdown (§99: aggregate rows only, owner scope) */}
      <section className="cc-card p-4">
        <h2 className="font-semibold mb-2">Per-BU breakdown</h2>
        {data.breakdown.length === 0 ? (
          <p className="text-sm" style={{ color: "var(--muted)" }}>No business units in your scope.</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="cc-table">
              <thead>
                <tr><th>BU</th><th>Leads</th><th>Hot</th><th>Inquiries</th><th>Escalated</th><th>Content</th><th>Social</th><th>Spend $</th><th>LLM req</th><th>LLM cost $</th></tr>
              </thead>
              <tbody>
                {data.breakdown.map((r) => (
                  <tr key={r.businessUnitId}>
                    <td>#{r.businessUnitId} {r.businessUnitName}</td>
                    <td>{r.leads}</td><td>{r.hotLeads}</td><td>{r.inquiries}</td><td>{r.escalatedInquiries}</td>
                    <td>{r.contentItems}</td><td>{r.socialPosts}</td><td>{r.campaignSpendUsd.toFixed(2)}</td>
                    <td>{r.llmRequests}</td><td>{r.llmCostUsd.toFixed(4)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      {/* On-demand generation */}
      <section className="cc-card p-4">
        <h2 className="font-semibold mb-2">Generate on-demand report</h2>
        <div className="flex flex-wrap items-end gap-3">
          <div>
            <label className="cc-label" htmlFor="an-scope">Scope</label>
            <select id="an-scope" className="cc-input" value={scope} onChange={(e) => setScope(e.target.value)}>
              <option value="platform">Platform (all BUs)</option>
              {data.breakdown.map((r) => (
                <option key={r.businessUnitId} value={String(r.businessUnitId)}>BU #{r.businessUnitId} {r.businessUnitName}</option>
              ))}
            </select>
          </div>
          <div>
            <label className="cc-label" htmlFor="an-days">Window (days)</label>
            <input id="an-days" className="cc-input" type="number" min={1} max={365} value={days} onChange={(e) => setDays(e.target.value)} />
          </div>
          <button className="cc-btn cc-btn-primary" disabled={busy === "generate"} onClick={() => void generate()}>
            {busy === "generate" ? "Generating…" : "Generate"}
          </button>
        </div>
        <p className="text-xs mt-2" style={{ color: "var(--muted)" }}>
          On-demand reports dedup per minute — a double-click returns the same report. LLM legs degrade to the
          deterministic floor when the provider is unfunded; provenance on each report names what ran.
        </p>
      </section>

      {/* Reports */}
      <section className="cc-card p-4">
        <h2 className="font-semibold mb-2">Reports ({data.reports.length})</h2>
        {data.reports.length === 0 ? (
          <p className="text-sm" style={{ color: "var(--muted)" }}>No reports yet — generate one above or wait for the next scheduled digest.</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="cc-table">
              <thead>
                <tr><th>#</th><th>Title</th><th>Period</th><th>Status</th><th>Generated by</th><th>Created</th><th></th></tr>
              </thead>
              <tbody>
                {data.reports.map((r) => (
                  <tr key={r.id}>
                    <td>{r.id}</td>
                    <td>{r.title}{r.businessUnitId == null ? " · platform" : ""}</td>
                    <td><span className="cc-badge cc-badge-muted">{r.periodKind} {r.periodKey}</span></td>
                    <td>
                      <span className={r.status === "ready" ? "cc-badge cc-badge-ok" : r.status === "failed" ? "cc-badge cc-badge-danger" : "cc-badge cc-badge-warn"}>
                        {r.status}
                      </span>
                      {r.degraded && r.status === "ready" && <span className="cc-badge cc-badge-warn ml-1">degraded</span>}
                    </td>
                    <td>{r.generatedBy ?? "—"}</td>
                    <td>{new Date(r.createdAt).toLocaleString()}</td>
                    <td><button className="cc-btn" disabled={busy === `view-${r.id}`} onClick={() => void openDetail(r.id)}>View</button></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      {/* Report detail */}
      {detail && (
        <section className="cc-card p-4">
          <div className="flex items-center justify-between mb-2">
            <h2 className="font-semibold">Report #{detail.id} — {detail.title}</h2>
            <button className="cc-btn" onClick={() => setDetail(null)}>Close</button>
          </div>
          {detail.summary && <p className="text-sm mb-3">{detail.summary}</p>}
          {detail.narrative && (
            <div className="space-y-2 text-sm">
              {detail.narrative.highlights?.length > 0 && (
                <div><strong>Highlights</strong><ul className="list-disc ml-5">{detail.narrative.highlights.map((h, i) => <li key={i}>{h}</li>)}</ul></div>
              )}
              {detail.narrative.risks?.length > 0 && (
                <div><strong>Risks</strong><ul className="list-disc ml-5">{detail.narrative.risks.map((h, i) => <li key={i}>{h}</li>)}</ul></div>
              )}
            </div>
          )}
          {detail.payload?.insights && detail.payload.insights.length > 0 && (
            <div className="mt-3 text-sm">
              <strong>Insights</strong>
              <ul className="list-disc ml-5">{detail.payload.insights.map((i, k) => <li key={k}>[{i.direction}] {i.observation}</li>)}</ul>
            </div>
          )}
          {detail.payload?.provenance && (
            <p className="text-xs mt-3" style={{ color: "var(--muted)" }}>
              Provenance: insights {detail.payload.provenance.insightsBy} · narrative {detail.payload.provenance.narrativeBy} ·
              recommendations {detail.payload.provenance.recommendationsBy} · prompt v{detail.payload.provenance.promptVersion}
            </p>
          )}
          <details className="mt-3"><summary className="text-sm cursor-pointer">Raw payload (aggregates only)</summary>
            <pre className="text-xs mt-2 overflow-auto max-h-96" style={{ background: "var(--shell)", padding: "8px", borderRadius: "8px" }}>
              {JSON.stringify(detail.payload, null, 2)}
            </pre>
          </details>
        </section>
      )}

      {/* Recommendations */}
      <section className="cc-card p-4">
        <h2 className="font-semibold mb-2">Strategy recommendations ({data.recommendations.length})</h2>
        {data.recommendations.length === 0 ? (
          <p className="text-sm" style={{ color: "var(--muted)" }}>Nothing open — recommendations appear with evidence as reports run.</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="cc-table">
              <thead>
                <tr><th>Priority</th><th>Kind</th><th>Recommendation</th><th>Evidence</th><th>Status</th><th>Actions</th></tr>
              </thead>
              <tbody>
                {data.recommendations.map((rec) => (
                  <tr key={rec.id}>
                    <td><span className={PRIORITY_STYLES[rec.priority] ?? "cc-badge"}>{rec.priority}</span></td>
                    <td>{rec.kind}</td>
                    <td>
                      <div className="font-medium">{rec.title}</div>
                      <div className="text-xs" style={{ color: "var(--muted)" }}>{rec.detail}</div>
                    </td>
                    <td className="text-xs">{rec.evidence.length > 0 ? rec.evidence.join(", ") : "—"}</td>
                    <td>
                      <span className={rec.status === "open" ? "cc-badge cc-badge-warn" : rec.status === "accepted" ? "cc-badge cc-badge-ok" : "cc-badge cc-badge-muted"}>
                        {rec.status}
                      </span>
                      {rec.reviewedBy && <div className="text-xs" style={{ color: "var(--muted)" }}>{rec.reviewedBy}</div>}
                    </td>
                    <td>
                      {rec.status === "open" ? (
                        <div className="flex gap-1">
                          <button className="cc-btn cc-btn-primary" disabled={busy === `rec-${rec.id}`} onClick={() => void decide(rec.id, "accept")}>Accept</button>
                          <button className="cc-btn cc-btn-danger" disabled={busy === `rec-${rec.id}`} onClick={() => void decide(rec.id, "dismiss")}>Dismiss</button>
                        </div>
                      ) : "—"}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      {/* Schedules */}
      <section className="cc-card p-4">
        <h2 className="font-semibold mb-2">Scheduled digests (§102–§103)</h2>
        <table className="cc-table">
          <thead><tr><th>#</th><th>Scope</th><th>Cadence</th><th>Enabled</th><th>Last run</th></tr></thead>
          <tbody>
            {data.schedules.map((s) => (
              <tr key={s.id}>
                <td>{s.id}</td>
                <td>{s.businessUnitId == null ? "Platform" : `BU #${s.businessUnitId}`}</td>
                <td><span className="cc-badge cc-badge-muted">{s.cadence}</span></td>
                <td>{s.enabled ? "yes" : "no"}</td>
                <td>{s.lastRunAt ? new Date(s.lastRunAt).toLocaleString() : "never"}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>
    </div>
  );
}
