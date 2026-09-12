"use client";

import { useCallback, useEffect, useState } from "react";

/**
 * /gateway — AI Gateway control screen (Phase 4).
 * Spend/cost visibility from the llm_requests ledger (per agent / BU /
 * model, monthly windows), the latest gateway attempts (ok / error /
 * budget_blocked / rate_limited), and budgets as first-class objects
 * (create, re-price, enable/disable, delete). Server-side RBAC (llm.view /
 * budgets.manage) enforces access; this screen reads /api/admin/* only.
 */
type RollupRow = {
  bucket: string;
  label: string;
  calls: number;
  promptTokens: number;
  completionTokens: number;
  costUsd: number;
};
type RecentRow = {
  id: number;
  agentSlug: string | null;
  model: string;
  kind: string;
  status: string;
  errorCode: string | null;
  totalTokens: number | null;
  costUsd: number;
  latencyMs: number | null;
  attemptNo: number;
  createdAt: string;
};
type Budget = {
  id: number;
  scopeType: string;
  scopeId: number;
  scopeLabel: string | null;
  period: string;
  limitUsd: number;
  enabled: boolean;
  updatedAt: string;
};
type UsageData = {
  windowMonths: number;
  totals: { calls: number; costUsd: number; promptTokens: number; completionTokens: number };
  byAgent: RollupRow[];
  byBu: RollupRow[];
  byModel: RollupRow[];
  recent: RecentRow[];
};

const STATUS_STYLES: Record<string, string> = {
  ok: "cc-badge-ok",
  error: "cc-badge-warn",
  budget_blocked: "cc-badge-warn",
  rate_limited: "cc-badge-muted",
};

function Badge({ status }: { status: string }) {
  return <span className={`cc-badge ${STATUS_STYLES[status] ?? "cc-badge-muted"}`}>{status}</span>;
}

function usd(n: number): string {
  return `$${n.toFixed(n < 1 ? 4 : 2)}`;
}

export default function GatewayPage() {
  const [usage, setUsage] = useState<UsageData | null>(null);
  const [budgets, setBudgets] = useState<Budget[]>([]);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [busy, setBusy] = useState("");
  const [months, setMonths] = useState(3);
  // budget form state
  const [scopeType, setScopeType] = useState("business_unit");
  const [scopeId, setScopeId] = useState("");
  const [period, setPeriod] = useState("monthly");
  const [limitUsd, setLimitUsd] = useState("");

  const load = useCallback(async function load() {
    setError("");
    const ru = await fetch(`/api/admin/llm/usage?months=${months}`);
    if (ru.status === 401) { window.location.href = "/login"; return; }
    if (ru.status === 403) { setError("Your role does not include gateway read access."); return; }
    if (ru.ok) setUsage(((await ru.json()) as { data?: UsageData }).data ?? null);
    const rb = await fetch("/api/admin/budgets");
    if (rb.ok) setBudgets(((await rb.json()) as { data?: { budgets: Budget[] } }).data?.budgets ?? []);
  }, [months]);

  useEffect(() => { void load(); }, [load]);

  async function createBudget() {
    setBusy("create"); setNotice(""); setError("");
    try {
      const res = await fetch("/api/admin/budgets", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          scopeType,
          scopeId: Number(scopeId),
          period,
          limitUsd: Number(limitUsd),
        }),
      });
      const j = (await res.json()) as { errors?: { code: string; detail?: string }[] };
      if (!res.ok) { setError(`Create failed: ${j.errors?.[0]?.code ?? res.status}`); return; }
      setNotice("Budget saved. The gateway enforces it on the next call.");
      setScopeId(""); setLimitUsd("");
      await load();
    } finally { setBusy(""); }
  }

  async function patchBudget(id: number, body: Record<string, unknown>) {
    setBusy(`b-${id}`); setNotice(""); setError("");
    try {
      const res = await fetch(`/api/admin/budgets/${id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      if (!res.ok && res.status !== 404) { setError(`Update failed (${res.status}).`); return; }
      await load();
    } finally { setBusy(""); }
  }

  async function deleteBudget(id: number) {
    setBusy(`b-${id}`); setError("");
    try {
      const res = await fetch(`/api/admin/budgets/${id}`, { method: "DELETE" });
      if (!res.ok && res.status !== 404) { setError(`Delete failed (${res.status}).`); return; }
      setNotice("Budget deleted.");
      await load();
    } finally { setBusy(""); }
  }

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <h1 className="text-xl font-semibold">AI Gateway</h1>
        <label className="text-xs flex items-center gap-2">
          Window
          <select
            className="cc-input text-xs"
            value={months}
            onChange={(e) => setMonths(Number(e.target.value))}
          >
            <option value={1}>1 month</option>
            <option value={3}>3 months</option>
            <option value={6}>6 months</option>
            <option value={12}>12 months</option>
          </select>
        </label>
      </div>

      {error && <div className="cc-card text-sm" style={{ color: "#b91c1c" }}>{error}</div>}
      {notice && <div className="cc-card text-sm" style={{ color: "#047857" }}>{notice}</div>}

      <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
        <div className="cc-card">
          <div className="text-xs" style={{ color: "var(--muted)" }}>Gateway calls</div>
          <div className="text-2xl font-semibold">{usage?.totals.calls ?? "—"}</div>
        </div>
        <div className="cc-card">
          <div className="text-xs" style={{ color: "var(--muted)" }}>Spend (window)</div>
          <div className="text-2xl font-semibold">{usage ? usd(usage.totals.costUsd) : "—"}</div>
        </div>
        <div className="cc-card">
          <div className="text-xs" style={{ color: "var(--muted)" }}>Prompt tokens</div>
          <div className="text-2xl font-semibold">{usage?.totals.promptTokens.toLocaleString() ?? "—"}</div>
        </div>
        <div className="cc-card">
          <div className="text-xs" style={{ color: "var(--muted)" }}>Completion tokens</div>
          <div className="text-2xl font-semibold">{usage?.totals.completionTokens.toLocaleString() ?? "—"}</div>
        </div>
      </div>

      <section className="cc-card">
        <h2 className="font-semibold mb-2">Spend budgets</h2>
        <p className="text-xs mb-3" style={{ color: "var(--muted)" }}>
          Hard-stop before a call when a scope is at/over its limit; ops is paged via the event bus.
          A $0 limit blocks every call for that scope (useful as an emergency brake).
        </p>
        <table className="cc-table w-full">
          <thead>
            <tr><th>Scope</th><th>Period</th><th>Limit</th><th>State</th><th></th></tr>
          </thead>
          <tbody>
            {budgets.map((b) => (
              <tr key={b.id}>
                <td className="font-mono text-xs">
                  {b.scopeType}#{b.scopeId}{b.scopeLabel ? ` (${b.scopeLabel})` : ""}
                </td>
                <td>{b.period}</td>
                <td>{usd(b.limitUsd)}</td>
                <td>{b.enabled ? <Badge status="ok" /> : <Badge status="rate_limited" />}</td>
                <td className="space-x-2">
                  <button
                    className="cc-btn text-xs"
                    disabled={busy === `b-${b.id}`}
                    onClick={() => patchBudget(b.id, { enabled: !b.enabled })}
                  >
                    {b.enabled ? "Disable" : "Enable"}
                  </button>
                  <button
                    className="cc-btn cc-btn-danger text-xs"
                    disabled={busy === `b-${b.id}`}
                    onClick={() => deleteBudget(b.id)}
                  >
                    Delete
                  </button>
                </td>
              </tr>
            ))}
            {budgets.length === 0 && <tr><td colSpan={5}>No budgets yet.</td></tr>}
          </tbody>
        </table>

        <div className="mt-4 flex flex-wrap items-end gap-3 text-xs">
          <label className="flex flex-col gap-1">
            Scope
            <select className="cc-input text-xs" value={scopeType} onChange={(e) => setScopeType(e.target.value)}>
              <option value="business_unit">business_unit</option>
              <option value="agent">agent</option>
            </select>
          </label>
          <label className="flex flex-col gap-1">
            Scope id
            <input className="cc-input text-xs w-24" value={scopeId} onChange={(e) => setScopeId(e.target.value)} placeholder="1" />
          </label>
          <label className="flex flex-col gap-1">
            Period
            <select className="cc-input text-xs" value={period} onChange={(e) => setPeriod(e.target.value)}>
              <option value="monthly">monthly</option>
              <option value="daily">daily</option>
            </select>
          </label>
          <label className="flex flex-col gap-1">
            Limit (USD)
            <input className="cc-input text-xs w-28" value={limitUsd} onChange={(e) => setLimitUsd(e.target.value)} placeholder="25.00" />
          </label>
          <button
            className="cc-btn cc-btn-primary text-xs"
            disabled={busy === "create" || !scopeId || !limitUsd}
            onClick={createBudget}
          >
            Save budget
          </button>
        </div>
      </section>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        <section className="cc-card">
          <h2 className="font-semibold mb-2">Cost by agent</h2>
          <table className="cc-table w-full">
            <thead><tr><th>Month</th><th>Agent</th><th>Calls</th><th>Tokens</th><th>Cost</th></tr></thead>
            <tbody>
              {(usage?.byAgent ?? []).map((r, i) => (
                <tr key={`${r.bucket}-${r.label}-${i}`}>
                  <td className="font-mono text-xs">{r.bucket}</td>
                  <td>{r.label}</td>
                  <td>{r.calls}</td>
                  <td className="text-xs">{(r.promptTokens + r.completionTokens).toLocaleString()}</td>
                  <td>{usd(r.costUsd)}</td>
                </tr>
              ))}
              {(usage?.byAgent.length ?? 0) === 0 && <tr><td colSpan={5}>No ledger rows yet.</td></tr>}
            </tbody>
          </table>
        </section>

        <section className="cc-card">
          <h2 className="font-semibold mb-2">Cost by business unit</h2>
          <table className="cc-table w-full">
            <thead><tr><th>Month</th><th>BU</th><th>Calls</th><th>Tokens</th><th>Cost</th></tr></thead>
            <tbody>
              {(usage?.byBu ?? []).map((r, i) => (
                <tr key={`${r.bucket}-${r.label}-${i}`}>
                  <td className="font-mono text-xs">{r.bucket}</td>
                  <td>{r.label}</td>
                  <td>{r.calls}</td>
                  <td className="text-xs">{(r.promptTokens + r.completionTokens).toLocaleString()}</td>
                  <td>{usd(r.costUsd)}</td>
                </tr>
              ))}
              {(usage?.byBu.length ?? 0) === 0 && <tr><td colSpan={5}>No ledger rows yet.</td></tr>}
            </tbody>
          </table>
        </section>
      </div>

      <section className="cc-card">
        <h2 className="font-semibold mb-2">Cost by model</h2>
        <table className="cc-table w-full">
          <thead><tr><th>Month</th><th>Model</th><th>Calls</th><th>Prompt</th><th>Completion</th><th>Cost</th></tr></thead>
          <tbody>
            {(usage?.byModel ?? []).map((r, i) => (
              <tr key={`${r.bucket}-${r.label}-${i}`}>
                <td className="font-mono text-xs">{r.bucket}</td>
                <td className="font-mono text-xs">{r.label}</td>
                <td>{r.calls}</td>
                <td className="text-xs">{r.promptTokens.toLocaleString()}</td>
                <td className="text-xs">{r.completionTokens.toLocaleString()}</td>
                <td>{usd(r.costUsd)}</td>
              </tr>
            ))}
            {(usage?.byModel.length ?? 0) === 0 && <tr><td colSpan={6}>No ledger rows yet.</td></tr>}
          </tbody>
        </table>
      </section>

      <section className="cc-card">
        <h2 className="font-semibold mb-2">Latest gateway attempts</h2>
        <table className="cc-table w-full">
          <thead>
            <tr><th>#</th><th>At</th><th>Agent</th><th>Kind</th><th>Model</th><th>Status</th><th>Attempt</th><th>Tokens</th><th>Cost</th><th>Latency</th></tr>
          </thead>
          <tbody>
            {(usage?.recent ?? []).map((r) => (
              <tr key={r.id}>
                <td>{r.id}</td>
                <td className="text-xs">{new Date(r.createdAt).toLocaleString()}</td>
                <td className="font-mono text-xs">{r.agentSlug ?? "—"}</td>
                <td>{r.kind}</td>
                <td className="font-mono text-xs">{r.model}</td>
                <td>
                  <Badge status={r.status} />
                  {r.errorCode && <span className="text-xs ml-1" style={{ color: "var(--muted)" }}>{r.errorCode}</span>}
                </td>
                <td>{r.attemptNo}</td>
                <td className="text-xs">{r.totalTokens?.toLocaleString() ?? "—"}</td>
                <td>{usd(r.costUsd)}</td>
                <td className="text-xs">{r.latencyMs != null ? `${r.latencyMs}ms` : "—"}</td>
              </tr>
            ))}
            {(usage?.recent.length ?? 0) === 0 && <tr><td colSpan={10}>No gateway traffic yet.</td></tr>}
          </tbody>
        </table>
      </section>
    </div>
  );
}
