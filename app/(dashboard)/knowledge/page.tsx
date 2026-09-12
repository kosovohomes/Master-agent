"use client";

import { useCallback, useEffect, useState } from "react";

/**
 * /knowledge — Knowledge system control screen (Phase 5).
 * Source registry (create / fetch now / disable / delete), lifecycle status
 * (last_checked + lastRun), and the scoped retrieval playground: probe
 * exactly what GLOBAL / BUSINESS / JURISDICTION / AGENT / public callers
 * would see, with authority tier + provenance on every citation. Reads and
 * writes /api/admin/knowledge* (knowledge.manage server-side).
 */
type KnowledgeSource = {
  id: number;
  businessUnitId: number | null;
  websiteId: number | null;
  kind: string;
  ref: string;
  title: string;
  description: string;
  authorityLevel: number;
  jurisdiction: string | null;
  language: string | null;
  accessLevel: string;
  refreshFrequency: string;
  maxDocuments: number;
  status: string;
  metadata: Record<string, unknown>;
  lastChecked: string | null;
};

type Citation = {
  chunkId: number;
  documentId: number;
  title: string;
  content: string;
  score: number;
  authorityTier: number;
  accessLevel: string;
  jurisdiction: string | null;
  sourceUrl: string | null;
  documentUrl: string | null;
  verificationStatus: string;
  legs: { vector: boolean; keyword: boolean };
};

type BusinessUnit = { id: number; name: string; slug: string };

const STATUS_STYLES: Record<string, string> = {
  active: "cc-badge-ok",
  error: "cc-badge-warn",
  disabled: "cc-badge-muted",
};

const KINDS = ["sitemap", "rss", "url", "api", "upload", "github", "db"];

function Badge({ status }: { status: string }) {
  return <span className={`cc-badge ${STATUS_STYLES[status] ?? "cc-badge-muted"}`}>{status}</span>;
}

export default function KnowledgePage() {
  const [sources, setSources] = useState<KnowledgeSource[]>([]);
  const [flag, setFlag] = useState(false);
  const [bus, setBus] = useState<BusinessUnit[]>([]);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [busy, setBusy] = useState("");
  // create form
  const [kind, setKind] = useState("sitemap");
  const [ref, setRef] = useState("");
  const [title, setTitle] = useState("");
  const [businessUnitId, setBusinessUnitId] = useState("");
  const [jurisdiction, setJurisdiction] = useState("");
  const [language, setLanguage] = useState("");
  const [authorityLevel, setAuthorityLevel] = useState("3");
  const [accessLevel, setAccessLevel] = useState("internal");
  const [refreshFrequency, setRefreshFrequency] = useState("manual");
  // playground
  const [query, setQuery] = useState("");
  const [scopeBu, setScopeBu] = useState("");
  const [scopeJur, setScopeJur] = useState("");
  const [scopePublic, setScopePublic] = useState(false);
  const [citations, setCitations] = useState<Citation[] | null>(null);
  const [legs, setLegs] = useState<{ vector: boolean; keyword: boolean } | null>(null);

  const load = useCallback(async function load() {
    setError("");
    const rk = await fetch("/api/admin/knowledge");
    if (rk.status === 401) { window.location.href = "/login"; return; }
    if (rk.status === 403) { setError("Your role does not include knowledge manage access."); return; }
    if (rk.ok) {
      const j = (await rk.json()) as { data?: { sources: KnowledgeSource[]; knowledgeV2: boolean } };
      setSources(j.data?.sources ?? []);
      setFlag(j.data?.knowledgeV2 ?? false);
    }
    const rb = await fetch("/api/admin/business-units");
    if (rb.ok) {
      const j = (await rb.json()) as { data?: BusinessUnit[] };
      setBus(j.data ?? []);
    }
  }, []);

  useEffect(() => { void load(); }, [load]);

  async function createSource() {
    setBusy("create"); setNotice(""); setError("");
    try {
      const res = await fetch("/api/admin/knowledge", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          kind, ref, title: title || ref,
          businessUnitId: businessUnitId ? Number(businessUnitId) : null,
          jurisdiction: jurisdiction || null,
          language: language || null,
          authorityLevel: Number(authorityLevel),
          accessLevel, refreshFrequency,
        }),
      });
      const j = (await res.json()) as { errors?: { code: string; detail?: string }[] };
      if (!res.ok) { setError(j.errors?.[0]?.detail ?? `Create failed (${res.status})`); return; }
      setNotice("Source created. Use Fetch now to ingest it.");
      setRef(""); setTitle("");
      await load();
    } finally { setBusy(""); }
  }

  async function patch(id: number, body: Record<string, unknown>, note: string) {
    setBusy(`patch-${id}`); setNotice(""); setError("");
    try {
      const res = await fetch(`/api/admin/knowledge/${id}`, {
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

  async function remove(id: number) {
    setBusy(`del-${id}`); setNotice(""); setError("");
    try {
      const res = await fetch(`/api/admin/knowledge/${id}`, { method: "DELETE" });
      if (!res.ok) { setError(`Delete failed (${res.status})`); return; }
      setNotice("Source deleted.");
      await load();
    } finally { setBusy(""); }
  }

  async function fetchNow(id: number) {
    setBusy(`fetch-${id}`); setNotice(""); setError("");
    try {
      const res = await fetch(`/api/admin/knowledge/${id}/fetch`, { method: "POST" });
      const j = (await res.json()) as { data?: { taskId: number; created: boolean }; errors?: { detail?: string }[] };
      if (!res.ok) { setError(j.errors?.[0]?.detail ?? `Fetch failed (${res.status})`); return; }
      setNotice(`Fetch task #${j.data?.taskId} ${j.data?.created ? "queued" : "already pending"} — watch Operations for the run.`);
    } finally { setBusy(""); }
  }

  async function search() {
    setBusy("search"); setNotice(""); setError("");
    try {
      const params = new URLSearchParams({ query });
      if (scopeBu) params.set("businessUnitId", scopeBu);
      if (scopeJur) params.set("jurisdiction", scopeJur);
      if (scopePublic) params.set("publicOnly", "1");
      const res = await fetch(`/api/admin/knowledge/documents?${params.toString()}`);
      const j = (await res.json()) as { data?: { citations: Citation[]; legs: { vector: boolean; keyword: boolean } }; errors?: { detail?: string }[] };
      if (!res.ok) { setError(j.errors?.[0]?.detail ?? `Search failed (${res.status})`); setCitations(null); return; }
      setCitations(j.data?.citations ?? []);
      setLegs(j.data?.legs ?? null);
    } finally { setBusy(""); }
  }

  const input = "cc-input";

  return (
    <div className="space-y-6 max-w-6xl">
      <div>
        <h1 className="text-2xl font-semibold">Knowledge</h1>
        <p className="text-sm mt-1" style={{ color: "var(--muted)" }}>
          Scoped knowledge sources, ingestion and retrieval. Scopes: global → business unit → website → jurisdiction → agent.
          <span className={`cc-badge ml-2 ${flag ? "cc-badge-ok" : "cc-badge-muted"}`}>knowledge_v2 {flag ? "ON" : "OFF"}</span>
        </p>
      </div>

      {error && <div className="cc-badge cc-badge-danger px-3 py-2 rounded-lg text-sm">{error}</div>}
      {notice && <div className="cc-badge cc-badge-ok px-3 py-2 rounded-lg text-sm">{notice}</div>}

      <section className="cc-card p-4">
        <h2 className="font-semibold mb-3">Sources ({sources.length})</h2>
        <div className="overflow-x-auto">
          <table className="cc-table w-full">
            <thead>
              <tr>
                <th>ID</th><th>Kind</th><th>Ref</th><th>Scope</th><th>Tier</th><th>Access</th>
                <th>Refresh</th><th>Status</th><th>Last checked</th><th>Actions</th>
              </tr>
            </thead>
            <tbody>
              {sources.map((s) => {
                const lastRun = (s.metadata as { lastRun?: { at?: string; ingested?: number; deduplicated?: number; error?: string } }).lastRun;
                return (
                  <tr key={s.id}>
                    <td>{s.id}</td>
                    <td>{s.kind}</td>
                    <td className="max-w-[240px] truncate" title={s.ref}>{s.ref}</td>
                    <td>
                      {s.businessUnitId == null ? "global" : `BU ${s.businessUnitId}`}
                      {s.jurisdiction ? ` · ${s.jurisdiction}` : ""}
                      {s.language ? ` · ${s.language}` : ""}
                    </td>
                    <td>T{s.authorityLevel}</td>
                    <td>{s.accessLevel}</td>
                    <td>{s.refreshFrequency}</td>
                    <td><Badge status={s.status} /></td>
                    <td className="text-xs" style={{ color: "var(--muted)" }} title={lastRun ? JSON.stringify(lastRun) : ""}>
                      {s.lastChecked ? new Date(s.lastChecked).toLocaleString() : "never"}
                      {lastRun?.error ? <div style={{ color: "var(--danger)" }}>{String(lastRun.error).slice(0, 60)}</div> : null}
                    </td>
                    <td className="whitespace-nowrap">
                      <button className="cc-btn cc-btn-primary mr-1" disabled={busy !== ""} onClick={() => fetchNow(s.id)}>
                        {busy === `fetch-${s.id}` ? "…" : "Fetch now"}
                      </button>
                      <button
                        className="cc-btn mr-1"
                        disabled={busy !== ""}
                        onClick={() => patch(s.id, { status: s.status === "disabled" ? "active" : "disabled" }, s.status === "disabled" ? "Source enabled." : "Source disabled.")}
                      >
                        {s.status === "disabled" ? "Enable" : "Disable"}
                      </button>
                      <button className="cc-btn cc-btn-danger" disabled={busy !== ""} onClick={() => remove(s.id)}>Delete</button>
                    </td>
                  </tr>
                );
              })}
              {sources.length === 0 && (
                <tr><td colSpan={10} className="text-sm" style={{ color: "var(--muted)" }}>No sources yet — create one below.</td></tr>
              )}
            </tbody>
          </table>
        </div>
      </section>

      <section className="cc-card p-4">
        <h2 className="font-semibold mb-3">Create source</h2>
        <div className="grid gap-3 md:grid-cols-4">
          <label className="text-xs" style={{ color: "var(--muted)" }}>Kind
            <select className={`${input} mt-1`} value={kind} onChange={(e) => setKind(e.target.value)}>
              {KINDS.map((k) => <option key={k} value={k}>{k}</option>)}
            </select>
          </label>
          <label className="text-xs md:col-span-2" style={{ color: "var(--muted)" }}>Ref (URL or identifier)
            <input className={`${input} mt-1`} value={ref} onChange={(e) => setRef(e.target.value)} placeholder="https://example.com/sitemap.xml" />
          </label>
          <label className="text-xs" style={{ color: "var(--muted)" }}>Title
            <input className={`${input} mt-1`} value={title} onChange={(e) => setTitle(e.target.value)} placeholder="optional" />
          </label>
          <label className="text-xs" style={{ color: "var(--muted)" }}>Business unit
            <select className={`${input} mt-1`} value={businessUnitId} onChange={(e) => setBusinessUnitId(e.target.value)}>
              <option value="">global (all BUs)</option>
              {bus.map((b) => <option key={b.id} value={b.id}>{b.name}</option>)}
            </select>
          </label>
          <label className="text-xs" style={{ color: "var(--muted)" }}>Jurisdiction
            <input className={`${input} mt-1`} value={jurisdiction} onChange={(e) => setJurisdiction(e.target.value)} placeholder="e.g. US, UK" />
          </label>
          <label className="text-xs" style={{ color: "var(--muted)" }}>Language
            <input className={`${input} mt-1`} value={language} onChange={(e) => setLanguage(e.target.value)} placeholder="e.g. en" />
          </label>
          <label className="text-xs" style={{ color: "var(--muted)" }}>Authority tier (1=gov/court … 5=unverified)
            <select className={`${input} mt-1`} value={authorityLevel} onChange={(e) => setAuthorityLevel(e.target.value)}>
              {[1, 2, 3, 4, 5].map((n) => <option key={n} value={n}>T{n}</option>)}
            </select>
          </label>
          <label className="text-xs" style={{ color: "var(--muted)" }}>Access level
            <select className={`${input} mt-1`} value={accessLevel} onChange={(e) => setAccessLevel(e.target.value)}>
              {["public", "internal", "confidential"].map((a) => <option key={a} value={a}>{a}</option>)}
            </select>
          </label>
          <label className="text-xs" style={{ color: "var(--muted)" }}>Refresh
            <select className={`${input} mt-1`} value={refreshFrequency} onChange={(e) => setRefreshFrequency(e.target.value)}>
              {["manual", "hourly", "daily", "weekly"].map((r) => <option key={r} value={r}>{r}</option>)}
            </select>
          </label>
          <div className="flex items-end">
            <button className="cc-btn cc-btn-primary" disabled={busy !== "" || ref === ""} onClick={createSource}>
              {busy === "create" ? "Creating…" : "Create source"}
            </button>
          </div>
        </div>
      </section>

      <section className="cc-card p-4">
        <h2 className="font-semibold mb-1">Retrieval playground</h2>
        <p className="text-xs mb-3" style={{ color: "var(--muted)" }}>
          Preview exactly what a scoped caller would receive — every citation carries its authority tier and provenance.
        </p>
        <div className="grid gap-3 md:grid-cols-5">
          <label className="text-xs md:col-span-2" style={{ color: "var(--muted)" }}>Query
            <input className={`${input} mt-1`} value={query} onChange={(e) => setQuery(e.target.value)} placeholder="e.g. filing deadlines" />
          </label>
          <label className="text-xs" style={{ color: "var(--muted)" }}>Business unit view
            <select className={`${input} mt-1`} value={scopeBu} onChange={(e) => setScopeBu(e.target.value)}>
              <option value="">all (admin)</option>
              {bus.map((b) => <option key={b.id} value={b.id}>{b.name}</option>)}
            </select>
          </label>
          <label className="text-xs" style={{ color: "var(--muted)" }}>Jurisdiction
            <input className={`${input} mt-1`} value={scopeJur} onChange={(e) => setScopeJur(e.target.value)} placeholder="empty = any" />
          </label>
          <div className="flex items-end gap-3">
            <label className="text-xs flex items-center gap-2" style={{ color: "var(--muted)" }}>
              <input type="checkbox" checked={scopePublic} onChange={(e) => setScopePublic(e.target.checked)} />
              public-only
            </label>
            <button className="cc-btn cc-btn-primary" disabled={busy !== "" || query === ""} onClick={search}>
              {busy === "search" ? "…" : "Search"}
            </button>
          </div>
        </div>
        {legs && (
          <div className="text-xs mt-3" style={{ color: "var(--muted)" }}>
            legs: vector {legs.vector ? "✓" : "✗ (degraded — keyword only)"} · keyword {legs.keyword ? "✓" : "✗"}
          </div>
        )}
        {citations && (
          <div className="mt-3 space-y-2">
            {citations.map((c) => (
              <div key={c.chunkId} className="rounded-lg border p-3 text-sm" style={{ borderColor: "rgba(255,255,255,0.1)" }}>
                <div className="flex flex-wrap items-center gap-2">
                  <span className="font-medium">{c.title}</span>
                  <span className="cc-badge cc-badge-muted">T{c.authorityTier}</span>
                  <span className="cc-badge cc-badge-muted">{c.accessLevel}</span>
                  {c.jurisdiction && <span className="cc-badge cc-badge-muted">{c.jurisdiction}</span>}
                  <span className="cc-badge cc-badge-muted">{c.verificationStatus}</span>
                  <span className="cc-badge cc-badge-muted">score {c.score.toFixed(4)}</span>
                </div>
                <div className="mt-1 line-clamp-3" style={{ color: "var(--muted)" }}>{c.content.slice(0, 240)}…</div>
                <div className="text-xs mt-1" style={{ color: "var(--muted)" }}>
                  doc #{c.documentId} · chunk #{c.chunkId}
                  {c.documentUrl ? <> · <a href={c.documentUrl} target="_blank" rel="noreferrer" className="underline">{c.documentUrl}</a></> : null}
                </div>
              </div>
            ))}
            {citations.length === 0 && <div className="text-sm" style={{ color: "var(--muted)" }}>No citations for this scope.</div>}
          </div>
        )}
      </section>
    </div>
  );
}
