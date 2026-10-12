"use client";

import { useCallback, useEffect, useState } from "react";

/**
 * /supervisor — Supervisor screen (Phase 15, roadmap P14: §57 bounded
 * planner/delegator, §23 handoff logging).
 *
 * State a goal → the supervisor plans a task graph (≤6 steps, worker agents
 * only) → delegates each step as a durable task → monitors deterministically
 * → escalates to a human on failure/ceiling. Worker agents produce DRAFTS and
 * analyses — publishing stays human-gated on the Approvals surface (nothing
 * in this screen can publish, schedule or send). Handoffs are all logged and
 * shown; spend is measured from the LLM ledger against the plan's ceiling.
 */

type PlanStep = { agent: string; objective: string; dependsOn: number[] };

type Plan = {
  id: number;
  business_unit_id: number;
  objective: string;
  status: string;
  budget_usd: string | null;
  deadline: string | null;
  plan: { steps: PlanStep[]; notes?: string | null } | null;
  generated_by: string | null;
  degraded: boolean;
  error: string | null;
  error_class: string | null;
  created_at: string;
};

type Handoff = {
  id: number; plan_id: number; task_id: number | null; step_index: number;
  from_agent: string; to_agent: string; objective: string; status: string;
  settled_at: string | null;
};

type ChildTask = { id: number; kind: string; status: string; error: string | null; budget_usd: string | null };

type PlanDetailPayload = {
  plan: Plan; handoffs: Handoff[]; spendUsd: number; childTasks: ChildTask[];
};

type ListPayload = {
  plans: Plan[];
  budgetCeilingUsd: number;
  flags: { supervisor: boolean };
};

type BuRow = { id: number; name: string; status: string };

const STATUS_STYLES: Record<string, string> = {
  planning: "cc-badge cc-badge-warn",
  active: "cc-badge cc-badge-warn",
  completed: "cc-badge cc-badge-ok",
  failed: "cc-badge cc-badge-danger",
  escalated: "cc-badge cc-badge-danger",
  cancelled: "cc-badge cc-badge-muted",
  delegated: "cc-badge cc-badge-warn",
  succeeded: "cc-badge cc-badge-ok",
  blocked: "cc-badge cc-badge-muted",
};

function errText(j: { errors?: { code?: string; detail?: string }[] }, fallback: string): string {
  const e = j?.errors?.[0];
  return e ? [e.code, e.detail].filter(Boolean).join(": ") : fallback;
}

export default function SupervisorPage() {
  const [data, setData] = useState<ListPayload | null>(null);
  const [bus, setBus] = useState<BuRow[]>([]);
  const [detail, setDetail] = useState<PlanDetailPayload | null>(null);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [busy, setBusy] = useState("");

  // goal form
  const [objective, setObjective] = useState("");
  const [buId, setBuId] = useState("");
  const [budget, setBudget] = useState("");
  const [deadline, setDeadline] = useState("");

  const load = useCallback(async function load() {
    const res = await fetch("/api/admin/supervisor/plans");
    if (res.status === 401) { window.location.href = "/login"; return; }
    const j = (await res.json()) as { data?: ListPayload; errors?: { code?: string; detail?: string }[] };
    if (!res.ok || !j.data) { setError(errText(j, `Load failed (${res.status})`)); return; }
    setData(j.data);
  }, []);

  useEffect(() => {
    void load();
    void (async () => {
      const res = await fetch("/api/admin/business-units");
      if (!res.ok) return;
      const j = (await res.json()) as { data?: BuRow[] };
      setBus((j.data ?? []).filter((b) => b.status === "active"));
    })();
  }, [load]);

  async function stateGoal() {
    setBusy("goal"); setError(""); setNotice("");
    try {
      const body = {
        objective,
        businessUnitId: Number(buId),
        budgetUsd: budget.trim() === "" ? null : Number(budget),
        deadline: deadline.trim() === "" ? null : new Date(deadline).toISOString(),
      };
      const res = await fetch("/api/admin/supervisor/plans", {
        method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
      });
      const j = (await res.json()) as { data?: { planId: number; budgetUsd: number }; errors?: { code?: string; detail?: string }[] };
      if (!res.ok || !j.data) { setError(errText(j, `Goal refused (${res.status})`)); return; }
      setNotice(`Plan #${j.data.planId} created — the supervisor is planning (budget $${j.data.budgetUsd.toFixed(2)}).`);
      setObjective("");
      await load();
      await openDetail(j.data.planId);
    } finally { setBusy(""); }
  }

  async function openDetail(id: number) {
    setBusy(`view-${id}`); setError("");
    try {
      const res = await fetch(`/api/admin/supervisor/plans/${id}`);
      const j = (await res.json()) as { data?: PlanDetailPayload; errors?: { code?: string; detail?: string }[] };
      if (!res.ok || !j.data) { setError(errText(j, `Load failed (${res.status})`)); return; }
      setDetail(j.data);
    } finally { setBusy(""); }
  }

  async function cancelPlan(id: number) {
    setBusy(`cancel-${id}`); setError(""); setNotice("");
    try {
      const res = await fetch(`/api/admin/supervisor/plans/${id}/cancel`, { method: "POST" });
      const j = (await res.json()) as { data?: { ok: boolean; tasksCancelled: number }; errors?: { code?: string; detail?: string }[] };
      if (!res.ok || !j.data) { setError(errText(j, `Cancel failed (${res.status})`)); return; }
      setNotice(j.data.ok ? `Plan #${id} cancelled (${j.data.tasksCancelled} task(s) stopped).` : `Plan #${id} was already closed.`);
      await load();
      if (detail?.plan.id === id) await openDetail(id);
    } finally { setBusy(""); }
  }

  if (!data) {
    return (
      <div className="max-w-6xl">
        <h1 className="text-2xl font-semibold">Supervisor</h1>
        {error ? <div className="cc-badge cc-badge-danger px-3 py-2 rounded-lg text-sm mt-3">{error}</div> : <p className="text-sm mt-3">Loading…</p>}
      </div>
    );
  }

  const flag = data.flags.supervisor;
  const isOpen = (p: Plan) => p.status === "planning" || p.status === "active";

  return (
    <div className="space-y-6 max-w-6xl">
      <div>
        <h1 className="text-2xl font-semibold">Supervisor</h1>
        <p className="text-sm mt-1">
          State a goal; the supervisor plans a bounded task graph (≤6 steps, worker agents only),
          delegates each step as a durable task, monitors deterministically and escalates to a human
          on failure or ceiling (§57). Every handoff is logged (§23). Worker output parks as drafts and
          analyses — publishing stays human-gated on Approvals.
        </p>
        <div className="flex flex-wrap items-center gap-2 mt-2">
          <span className={flag ? "cc-badge cc-badge-ok" : "cc-badge cc-badge-muted"}>
            supervisor planning: {flag ? "ON" : "OFF (new goals 423; in-flight plans keep settling)"}
          </span>
          <span className="cc-badge cc-badge-muted">hard budget ceiling: ${data.budgetCeilingUsd.toFixed(2)} / plan</span>
        </div>
      </div>

      {error && <div className="cc-badge cc-badge-danger px-3 py-2 rounded-lg text-sm">{error}</div>}
      {notice && <div className="cc-badge cc-badge-ok px-3 py-2 rounded-lg text-sm">{notice}</div>}

      {/* State a goal */}
      <section className="cc-card p-4">
        <h2 className="font-semibold mb-2">State a goal</h2>
        <div className="grid gap-3" style={{ gridTemplateColumns: "1fr" }}>
          <div>
            <label className="cc-label" htmlFor="sv-objective">Objective</label>
            <textarea
              id="sv-objective" className="cc-input" rows={2} maxLength={500}
              placeholder="e.g. research this week's AI legal developments and draft a blog post summarizing the top three"
              value={objective} onChange={(e) => setObjective(e.target.value)}
            />
          </div>
          <div className="flex flex-wrap items-end gap-3">
            <div>
              <label className="cc-label" htmlFor="sv-bu">Business unit</label>
              <select id="sv-bu" className="cc-input" value={buId} onChange={(e) => setBuId(e.target.value)}>
                <option value="">— select —</option>
                {bus.map((b) => (
                  <option key={b.id} value={String(b.id)}>#{b.id} {b.name}</option>
                ))}
              </select>
            </div>
            <div>
              <label className="cc-label" htmlFor="sv-budget">Budget $ (optional)</label>
              <input id="sv-budget" className="cc-input" type="number" step="0.01" min={0} max={data.budgetCeilingUsd}
                placeholder={`≤ ${data.budgetCeilingUsd.toFixed(2)}`} value={budget} onChange={(e) => setBudget(e.target.value)} />
            </div>
            <div>
              <label className="cc-label" htmlFor="sv-deadline">Deadline (optional)</label>
              <input id="sv-deadline" className="cc-input" type="datetime-local" value={deadline} onChange={(e) => setDeadline(e.target.value)} />
            </div>
            <button className="cc-btn cc-btn-primary" disabled={busy === "goal" || !objective.trim() || !buId}
              onClick={() => void stateGoal()}>
              {busy === "goal" ? "Planning…" : "Delegate to Supervisor"}
            </button>
          </div>
        </div>
      </section>

      {/* Plan list */}
      <section className="cc-card p-4">
        <h2 className="font-semibold mb-2">Plans ({data.plans.length})</h2>
        {data.plans.length === 0 ? (
          <p className="text-sm" style={{ color: "var(--muted)" }}>No plans yet — state a goal above.</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="cc-table">
              <thead>
                <tr><th>#</th><th>Objective</th><th>Status</th><th>Planner</th><th>Budget</th><th>Deadline</th><th>Created</th><th></th></tr>
              </thead>
              <tbody>
                {data.plans.map((p) => (
                  <tr key={p.id}>
                    <td>{p.id}</td>
                    <td style={{ maxWidth: 360, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{p.objective}</td>
                    <td><span className={STATUS_STYLES[p.status] ?? "cc-badge cc-badge-muted"}>{p.status}</span></td>
                    <td>{p.generated_by ?? "—"}{p.degraded ? " (degraded)" : ""}</td>
                    <td>{p.budget_usd != null ? `$${Number(p.budget_usd).toFixed(2)}` : "—"}</td>
                    <td>{p.deadline ? new Date(p.deadline).toLocaleString() : "—"}</td>
                    <td>{new Date(p.created_at).toLocaleString()}</td>
                    <td className="space-x-2 whitespace-nowrap">
                      <button className="cc-btn" onClick={() => void openDetail(p.id)}>View</button>
                      {isOpen(p) && (
                        <button className="cc-btn cc-btn-danger" disabled={busy === `cancel-${p.id}`} onClick={() => void cancelPlan(p.id)}>
                          {busy === `cancel-${p.id}` ? "…" : "Cancel"}
                        </button>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      {/* Plan detail */}
      {detail && (
        <section className="cc-card p-4">
          <div className="flex items-start justify-between gap-3 flex-wrap">
            <div>
              <h2 className="font-semibold">Plan #{detail.plan.id}</h2>
              <p className="text-sm mt-1" style={{ maxWidth: 640 }}>{detail.plan.objective}</p>
            </div>
            <div className="flex items-center gap-2">
              <span className={STATUS_STYLES[detail.plan.status] ?? "cc-badge cc-badge-muted"}>{detail.plan.status}</span>
              <span className="cc-badge cc-badge-muted">
                spend ${detail.spendUsd.toFixed(4)}{detail.plan.budget_usd != null ? ` / $${Number(detail.plan.budget_usd).toFixed(2)}` : ""}
              </span>
              {detail.plan.degraded && <span className="cc-badge cc-badge-warn">degraded (deterministic floor)</span>}
            </div>
          </div>
          {detail.plan.error && (
            <div className="cc-badge cc-badge-danger px-3 py-2 rounded-lg text-sm mt-2">{detail.plan.error_class}: {detail.plan.error}</div>
          )}

          {/* Task graph */}
          <h3 className="font-semibold mt-4 mb-2 text-sm">Task graph</h3>
          {detail.plan.plan ? (
            <div className="space-y-1">
              {detail.plan.plan.steps.map((s, i) => {
                const h = detail.handoffs.find((x) => x.step_index === i);
                return (
                  <div key={i} className="flex items-center gap-2 text-sm flex-wrap">
                    <span className="cc-badge cc-badge-muted">step {i}</span>
                    <span className="font-medium">{s.agent}</span>
                    <span style={{ color: "var(--muted)" }}>{s.objective}</span>
                    {s.dependsOn.length > 0 && <span className="cc-badge cc-badge-muted">after {s.dependsOn.join(",")}</span>}
                    {h && <span className={STATUS_STYLES[h.status] ?? "cc-badge cc-badge-muted"}>{h.status}{h.task_id ? ` (task #${h.task_id})` : ""}</span>}
                  </div>
                );
              })}
              {detail.plan.plan.notes && (
                <p className="text-xs mt-2" style={{ color: "var(--muted)" }}>Planner notes: {detail.plan.plan.notes}</p>
              )}
            </div>
          ) : (
            <p className="text-sm" style={{ color: "var(--muted)" }}>Planning in progress — the graph appears when the supervisor activates the plan.</p>
          )}

          {/* §23 handoff log */}
          <h3 className="font-semibold mt-4 mb-2 text-sm">Handoff log (§23)</h3>
          {detail.handoffs.length === 0 ? (
            <p className="text-sm" style={{ color: "var(--muted)" }}>No handoffs yet.</p>
          ) : (
            <div className="overflow-x-auto">
              <table className="cc-table">
                <thead><tr><th>Step</th><th>From</th><th>To</th><th>Objective</th><th>Status</th><th>Settled</th></tr></thead>
                <tbody>
                  {detail.handoffs.map((h) => (
                    <tr key={h.id}>
                      <td>{h.step_index}</td><td>{h.from_agent}</td><td>{h.to_agent}</td>
                      <td style={{ maxWidth: 320, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{h.objective}</td>
                      <td><span className={STATUS_STYLES[h.status] ?? "cc-badge cc-badge-muted"}>{h.status}</span></td>
                      <td>{h.settled_at ? new Date(h.settled_at).toLocaleString() : "—"}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}

          {/* Child tasks */}
          {detail.childTasks.length > 0 && (
            <>
              <h3 className="font-semibold mt-4 mb-2 text-sm">Delegated tasks</h3>
              <div className="overflow-x-auto">
                <table className="cc-table">
                  <thead><tr><th>Task</th><th>Kind</th><th>Status</th><th>Child ceiling</th><th>Error</th></tr></thead>
                  <tbody>
                    {detail.childTasks.map((t) => (
                      <tr key={t.id}>
                        <td>#{t.id}</td><td>{t.kind}</td>
                        <td><span className={STATUS_STYLES[t.status] ?? "cc-badge cc-badge-muted"}>{t.status}</span></td>
                        <td>{t.budget_usd != null ? `$${Number(t.budget_usd).toFixed(2)}` : "—"}</td>
                        <td style={{ maxWidth: 280, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{t.error ?? ""}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </>
          )}

          <p className="text-xs mt-3" style={{ color: "var(--muted)" }}>
            Worker drafts land on Approvals for a human decision — the supervisor path cannot publish,
            schedule or send. Refresh this view to settle after tasks complete.
          </p>
        </section>
      )}
    </div>
  );
}
