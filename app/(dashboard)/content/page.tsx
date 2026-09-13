"use client";

import { useCallback, useEffect, useState } from "react";

/**
 * /content — Content workforce control screen (Phase 8, roadmap P7).
 * Versioned content items (never-overwrite), the strategy → content →
 * fact_check chain (create & run / reprocess), the §60 lifecycle with the
 * transactional FSM, and the approval center v2 (approve / request-changes /
 * reject with immutable decision rows + the approval_actions trail).
 * Reads and writes /api/admin/content* (content.manage server-side).
 */
type Item = {
  id: number;
  businessUnitId: number;
  websiteId: number | null;
  researchItemId: number | null;
  type: string;
  title: string | null;
  lifecycle: string;
  brief: Record<string, unknown>;
  createdByAgent: string | null;
  currentVersionId: number | null;
  unprocessedReason: string | null;
  taskId: number | null;
  createdAt: string;
  updatedAt: string;
  reviewedAt: string | null;
  reviewedBy: string | null;
};

type Version = {
  id: number;
  contentItemId: number;
  version: number;
  title: string | null;
  body: string;
  metadata: Record<string, unknown>;
  createdByAgent: string | null;
  changeNote: string | null;
  createdAt: string;
};

type Detail = {
  item: Item;
  versions: Version[];
  approvals: { id: number; decision: string; riskLevel: string | null; decisionReason: string | null; decidedAt: string }[];
  actions: { id: number; action: string; actorLabel: string | null; note: string | null; createdAt: string }[];
};

type BusinessUnit = { id: number; name: string; slug: string };

const LIFECYCLE_STYLES: Record<string, string> = {
  IDEA: "cc-badge-muted",
  RESEARCHING: "cc-badge-warn",
  DRAFT: "cc-badge-warn",
  FACT_CHECK: "cc-badge-warn",
  REVIEW: "cc-badge-danger",
  APPROVED: "cc-badge-ok",
  SCHEDULED: "cc-badge-ok",
  PUBLISHED: "cc-badge-ok",
  ARCHIVED: "cc-badge-muted",
};

const RISK_STYLES: Record<string, string> = {
  low: "cc-badge-ok",
  medium: "cc-badge-warn",
  high: "cc-badge-danger",
};

function LcBadge({ lc }: { lc: string }) {
  return <span className={`cc-badge ${LIFECYCLE_STYLES[lc] ?? "cc-badge-muted"}`}>{lc}</span>;
}

const input = "cc-input";

export default function ContentPage() {
  const [items, setItems] = useState<Item[]>([]);
  const [bus, setBus] = useState<BusinessUnit[]>([]);
  const [flag, setFlag] = useState(false);
  const [statRows, setStatRows] = useState<{ lifecycle: string; n: number }[]>([]);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [busy, setBusy] = useState("");
  const [detail, setDetail] = useState<Detail | null>(null);
  const [comment, setComment] = useState("");
  // create / run form
  const [buId, setBuId] = useState("");
  const [type, setType] = useState("article");
  const [brief, setBrief] = useState("");
  const [researchItemId, setResearchItemId] = useState("");

  const load = useCallback(async function load() {
    setError("");
    const rc = await fetch("/api/admin/content");
    if (rc.status === 401) { window.location.href = "/login"; return; }
    if (rc.status === 403) { setError("Your role does not include content manage access."); return; }
    if (rc.ok) {
      const j = (await rc.json()) as { data?: { items: Item[]; stats: { lifecycle: string; n: number }[]; flag: boolean } };
      setItems(j.data?.items ?? []);
      setStatRows(j.data?.stats ?? []);
      setFlag(j.data?.flag ?? false);
    } else {
      setError(`Failed to load content (${rc.status}).`);
    }
    const rb = await fetch("/api/admin/business-units");
    if (rb.ok) {
      const jb = (await rb.json()) as { data?: { businessUnits?: BusinessUnit[] } | BusinessUnit[] };
      const list = Array.isArray(jb.data) ? jb.data : jb.data?.businessUnits ?? [];
      setBus(list);
    }
  }, []);

  useEffect(() => { void load(); }, [load]);

  async function post(url: string, body: unknown, done: string, key: string) {
    setBusy(key); setError(""); setNotice("");
    try {
      const r = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
      const j = (await r.json().catch(() => ({}))) as { errors?: { code: string; detail?: string }[]; data?: unknown };
      if (!r.ok) {
        setError(`${done} failed: ${j.errors?.[0]?.code ?? r.status}${j.errors?.[0]?.detail ? ` — ${j.errors[0].detail}` : ""}`);
        return false;
      }
      setNotice(done + ".");
      await load();
      return true;
    } finally {
      setBusy("");
    }
  }

  async function createItemAndRun(run: boolean) {
    if (!buId || !brief.trim()) return;
    const ok = await post(
      "/api/admin/content",
      run
        ? { mode: "run", businessUnitId: Number(buId), type, brief }
        : { mode: "item", businessUnitId: Number(buId), type, brief },
      run ? "Chain queued" : "Item created",
      run ? "create-run" : "create-item"
    );
    if (ok) setBrief("");
  }

  async function runFromResearch() {
    if (!buId || !researchItemId.trim()) return;
    const ok = await post(
      "/api/admin/content",
      { mode: "run", businessUnitId: Number(buId), type, researchItemId: Number(researchItemId) },
      "Chain queued from research",
      "run-research"
    );
    if (ok) setResearchItemId("");
  }

  async function openDetail(id: number) {
    setBusy(`detail-${id}`); setError("");
    try {
      const r = await fetch(`/api/admin/content/${id}`);
      if (r.ok) {
        const j = (await r.json()) as { data?: Detail };
        setDetail(j.data ?? null);
      }
    } finally {
      setBusy("");
    }
  }

  async function decide(id: number, decision: "approve" | "reject" | "request_changes") {
    if (decision !== "approve" && !comment.trim()) { setError("A comment is required to reject or request changes."); return; }
    const ok = await post(`/api/admin/content/${id}/decide`, { decision, comment }, `Decision recorded: ${decision}`, `decide-${id}`);
    if (ok) { setComment(""); await openDetail(id); }
  }

  async function transition(id: number, lifecycle: string) {
    setBusy(`tr-${id}`); setError(""); setNotice("");
    try {
      const r = await fetch(`/api/admin/content/${id}`, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ lifecycle }) });
      if (r.ok) { setNotice(`Item moved to ${lifecycle}.`); await load(); await openDetail(id); }
      else {
        const j = (await r.json().catch(() => ({}))) as { errors?: { code: string }[] };
        setError(`Transition failed: ${j.errors?.[0]?.code ?? r.status}`);
      }
    } finally { setBusy(""); }
  }

  async function runItem(it: Item) {
    await post(`/api/admin/content/${it.id}/run`, {}, it.unprocessedReason ? "Reprocess queued" : "Chain queued", `run-${it.id}`);
  }

  const buName = (id: number) => bus.find((b) => b.id === id)?.name ?? `#${id}`;
  const statFor = (lc: string) => statRows.find((s) => s.lifecycle === lc)?.n ?? 0;
  const factCheckOf = (d: Detail) => {
    const v = d.versions.find((x) => x.id === d.item.currentVersionId) ?? d.versions[0];
    return (v?.metadata as { factCheck?: { status?: string; summary?: string } })?.factCheck ?? null;
  };

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-3">
        <h1 className="text-xl font-semibold">Content</h1>
        <span className={`cc-badge ${flag ? "cc-badge-ok" : "cc-badge-danger"}`}>{flag ? "content flag ON" : "content flag OFF"}</span>
        <span className="text-xs" style={{ color: "var(--muted)" }}>strategy → content → fact_check · never-overwrite versions · approval-gated</span>
      </div>
      {error && <div className="cc-card p-3 text-sm" style={{ borderColor: "rgba(239,68,68,0.4)" }}>{error}</div>}
      {notice && <div className="cc-card p-3 text-sm">{notice}</div>}

      <div className="grid gap-2" style={{ gridTemplateColumns: "repeat(auto-fit, minmax(140px, 1fr))" }}>
        {["IDEA", "RESEARCHING", "DRAFT", "FACT_CHECK", "REVIEW", "APPROVED", "SCHEDULED", "PUBLISHED", "ARCHIVED"].map((lc) => (
          <div key={lc} className="cc-card p-3">
            <div className="text-xs" style={{ color: "var(--muted)" }}>{lc}</div>
            <div className="text-lg font-semibold">{statFor(lc)}</div>
          </div>
        ))}
      </div>

      <section className="cc-card p-4">
        <h2 className="font-semibold mb-3">Create &amp; run</h2>
        <div className="grid gap-2" style={{ gridTemplateColumns: "repeat(auto-fit, minmax(180px, 1fr))" }}>
          <select className={input} value={buId} onChange={(e) => setBuId(e.target.value)}>
            <option value="">Business unit…</option>
            {bus.map((b) => <option key={b.id} value={b.id}>{b.name}</option>)}
          </select>
          <select className={input} value={type} onChange={(e) => setType(e.target.value)}>
            <option value="article">article</option>
            <option value="social_post">social_post</option>
            <option value="email">email</option>
            <option value="page_copy">page_copy</option>
            <option value="other">other</option>
          </select>
          <input className={input} placeholder="Research item id (optional — runs from a finding)" value={researchItemId} onChange={(e) => setResearchItemId(e.target.value)} />
          <textarea
            className={input}
            placeholder="Brief — what should the piece say, for whom, in what tone? (research-sourced runs also accept this as an operator brief)"
            value={brief}
            onChange={(e) => setBrief(e.target.value)}
            style={{ gridColumn: "1 / -1", minHeight: 72 }}
          />
          <button className="cc-btn" disabled={busy !== "" || !buId || !brief.trim()} onClick={() => createItemAndRun(false)}>
            {busy === "create-item" ? "…" : "Create item only"}
          </button>
          <button className="cc-btn cc-btn-primary" disabled={busy !== "" || !buId || !brief.trim() || !flag} onClick={() => createItemAndRun(true)} title={flag ? "" : "content flag is OFF"}>
            {busy === "create-run" ? "…" : "Create & run chain"}
          </button>
          <button className="cc-btn" disabled={busy !== "" || !buId || !researchItemId.trim() || !flag} onClick={runFromResearch} title={flag ? "" : "content flag is OFF"}>
            {busy === "run-research" ? "…" : "Run from research finding"}
          </button>
        </div>
      </section>

      <section className="cc-card p-4">
        <h2 className="font-semibold mb-3">Content items ({items.length})</h2>
        <div className="space-y-2">
          {items.length === 0 && <p className="text-sm" style={{ color: "var(--muted)" }}>No content items yet.</p>}
          {items.map((it) => (
            <div key={it.id} className="cc-card p-3" style={{ borderColor: "rgba(255,255,255,0.08)" }}>
              <div className="flex flex-wrap items-center gap-2">
                <LcBadge lc={it.lifecycle} />
                <button className="text-sm font-medium underline-offset-2 hover:underline" onClick={() => openDetail(it.id)}>
                  {it.title ?? `item #${it.id}`}
                </button>
                <span className="cc-badge cc-badge-muted">{it.type}</span>
                {it.researchItemId != null && <span className="cc-badge cc-badge-muted">research #{it.researchItemId}</span>}
                {(it.brief as { riskLevel?: string })?.riskLevel && (
                  <span className={`cc-badge ${RISK_STYLES[(it.brief as { riskLevel?: string }).riskLevel ?? "medium"] ?? "cc-badge-muted"}`}>
                    risk {(it.brief as { riskLevel?: string }).riskLevel}
                  </span>
                )}
                {it.unprocessedReason && <span className="text-xs" style={{ color: "var(--muted)" }} title={it.unprocessedReason}>degraded — reprocess available</span>}
                <span className="text-xs ml-auto" style={{ color: "var(--muted)" }}>{buName(it.businessUnitId)} · {new Date(it.updatedAt).toLocaleString()}</span>
              </div>
              <div className="flex flex-wrap gap-1 mt-2">
                {["IDEA", "RESEARCHING", "DRAFT", "FACT_CHECK"].includes(it.lifecycle) && (
                  <button className="cc-btn cc-btn-primary" disabled={busy !== "" || !flag} onClick={() => runItem(it)} title={flag ? "" : "content flag is OFF"}>
                    {busy === `run-${it.id}` ? "…" : it.unprocessedReason ? "Reprocess" : "Run chain"}
                  </button>
                )}
                {!["ARCHIVED", "PUBLISHED"].includes(it.lifecycle) && (
                  <button className="cc-btn" disabled={busy !== ""} onClick={() => transition(it.id, "ARCHIVED")}>Archive</button>
                )}
              </div>
            </div>
          ))}
        </div>
      </section>

      {detail && (
        <section className="cc-card p-4">
          <div className="flex flex-wrap items-center gap-2 mb-2">
            <LcBadge lc={detail.item.lifecycle} />
            <h2 className="font-semibold">{detail.item.title ?? `item #${detail.item.id}`}</h2>
            <button className="cc-btn ml-auto" onClick={() => setDetail(null)}>Close</button>
          </div>

          {detail.item.lifecycle === "REVIEW" && (
            <div className="cc-card p-3 mb-3" style={{ borderColor: "rgba(255,255,255,0.12)" }}>
              <div className="text-sm font-medium mb-2">Approval decision (v2 — immutable decision rows)</div>
              <textarea className={input} placeholder="Decision reason (required for reject / request changes)" value={comment} onChange={(e) => setComment(e.target.value)} style={{ minHeight: 56 }} />
              <div className="flex flex-wrap gap-1 mt-2">
                <button className="cc-btn cc-btn-primary" disabled={busy !== ""} onClick={() => decide(detail.item.id, "approve")}>Approve</button>
                <button className="cc-btn" disabled={busy !== ""} onClick={() => decide(detail.item.id, "request_changes")}>Request changes</button>
                <button className="cc-btn" disabled={busy !== ""} onClick={() => decide(detail.item.id, "reject")}>Reject</button>
              </div>
            </div>
          )}

          {(() => {
            const fc = factCheckOf(detail);
            if (!fc) return null;
            return (
              <div className="text-sm mb-3">
                <span className={`cc-badge ${fc.status === "pass" ? "cc-badge-ok" : fc.status === "fail" ? "cc-badge-danger" : "cc-badge-warn"}`}>fact-check: {fc.status}</span>
                {fc.summary && <span className="ml-2" style={{ color: "var(--muted)" }}>{fc.summary}</span>}
              </div>
            );
          })()}

          <h3 className="text-sm font-semibold mt-3 mb-2">Versions ({detail.versions.length}) — never-overwrite</h3>
          <div className="space-y-2">
            {detail.versions.map((v) => (
              <div key={v.id} className="cc-card p-3" style={{ borderColor: "rgba(255,255,255,0.08)" }}>
                <div className="flex flex-wrap items-center gap-2 text-xs" style={{ color: "var(--muted)" }}>
                  <span className="cc-badge cc-badge-muted">v{v.version}</span>
                  {detail.item.currentVersionId === v.id && <span className="cc-badge cc-badge-ok">current</span>}
                  <span>{v.createdByAgent ?? "unknown"}</span>
                  <span>{new Date(v.createdAt).toLocaleString()}</span>
                  {v.changeNote && <span>· {v.changeNote}</span>}
                </div>
                {v.title && <div className="text-sm font-medium mt-1">{v.title}</div>}
                <pre className="text-xs mt-1 whitespace-pre-wrap" style={{ color: "var(--muted)", maxHeight: 180, overflow: "auto" }}>{v.body.slice(0, 2000)}{v.body.length > 2000 ? "…" : ""}</pre>
              </div>
            ))}
          </div>

          <h3 className="text-sm font-semibold mt-4 mb-2">Decisions &amp; trail</h3>
          <div className="text-xs space-y-1" style={{ color: "var(--muted)" }}>
            {detail.approvals.length === 0 && detail.actions.length === 0 && <p>No decisions or actions yet.</p>}
            {detail.approvals.map((a) => (
              <div key={`a-${a.id}`}>decision: <span style={{ color: "var(--fg)" }}>{a.decision}</span>{a.riskLevel ? ` · risk ${a.riskLevel}` : ""}{a.decisionReason ? ` · "${a.decisionReason}"` : ""} · {new Date(a.decidedAt).toLocaleString()}</div>
            ))}
            {detail.actions.map((a) => (
              <div key={`t-${a.id}`}>action: <span style={{ color: "var(--fg)" }}>{a.action}</span>{a.actorLabel ? ` · ${a.actorLabel}` : ""}{a.note ? ` · "${a.note}"` : ""} · {new Date(a.createdAt).toLocaleString()}</div>
            ))}
          </div>

          {detail.item.lifecycle === "APPROVED" && (
            <div className="flex flex-wrap gap-1 mt-3">
              <button className="cc-btn" disabled={busy !== ""} onClick={() => transition(detail.item.id, "SCHEDULED")}>Mark scheduled</button>
              <button className="cc-btn" disabled={busy !== ""} onClick={() => transition(detail.item.id, "PUBLISHED")}>Mark published</button>
            </div>
          )}
        </section>
      )}
    </div>
  );
}
