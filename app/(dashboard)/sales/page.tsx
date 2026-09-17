"use client";

import { useCallback, useEffect, useState } from "react";

/**
 * /sales — Sales + customer workforce screen (Phase 12, roadmap P11 §909:
 * MVP use case #3 — inquiry → classified, scored lead with human escalation).
 *
 * Pipeline UI: inquiry queue (classify / escalate / resolve / dismiss),
 * lead pipeline (human-only stage FSM, §91), conversation transcripts
 * (visitor/assistant only — §65), manual inquiry + lead intake, and the
 * widget site-keys card (connector #1 registration state).
 */

type Inquiry = {
  id: number;
  businessUnitId: number;
  conversationId: number | null;
  name: string | null;
  email: string | null;
  subject: string | null;
  body: string;
  classification: string | null;
  urgency: string | null;
  status: string;
  source: string;
  summary: string | null;
  classifiedBy: string | null;
  createdAt: string;
};

type Lead = {
  id: number;
  businessUnitId: number;
  inquiryId: number | null;
  company: string | null;
  contactName: string | null;
  contactEmail: string | null;
  contactPhone: string | null;
  source: string;
  stage: string;
  leadScore: number;
  scoreBand: string;
  nextAction: string | null;
  scoreRationale: string | null;
  scoredBy: string | null;
  updatedAt: string;
};

type Conversation = {
  id: number;
  websiteId: number | null;
  visitorId: string | null;
  channel: string;
  status: string;
  updatedAt: string;
};

type Message = { id: number; role: string; content: string; createdAt: string };

type Summary = {
  inquiries: Record<string, number>;
  leads: Record<string, number>;
  conversations: { total: number; active: number };
  hotLeads: number;
};

type SiteIntegration = {
  websiteId: number;
  websiteName: string;
  status: string;
  siteKeyMasked: string | null;
};

const INQUIRY_STATUS_STYLES: Record<string, string> = {
  new: "cc-badge cc-badge-warn",
  classified: "cc-badge cc-badge-muted",
  escalated: "cc-badge cc-badge-danger",
  resolved: "cc-badge cc-badge-ok",
  dismissed: "cc-badge cc-badge-muted",
};

const CLASSIFICATION_STYLES: Record<string, string> = {
  sales: "cc-badge cc-badge-ok",
  support: "cc-badge",
  spam: "cc-badge cc-badge-danger",
  general: "cc-badge cc-badge-muted",
};

const STAGE_STYLES: Record<string, string> = {
  new: "cc-badge cc-badge-warn",
  qualified: "cc-badge",
  engaged: "cc-badge",
  proposal: "cc-badge",
  won: "cc-badge cc-badge-ok",
  lost: "cc-badge cc-badge-muted",
};

const BAND_STYLES: Record<string, string> = {
  hot: "cc-badge cc-badge-danger",
  warm: "cc-badge cc-badge-warn",
  cold: "cc-badge cc-badge-muted",
};

/** Inquiry FSM actions per status — escalate/resolve are the human loop. */
const INQUIRY_ACTIONS: Record<string, Array<{ to: string; label: string; primary?: boolean }>> = {
  new: [{ to: "escalated", label: "Escalate", primary: true }, { to: "dismissed", label: "Dismiss" }],
  classified: [{ to: "escalated", label: "Escalate", primary: true }, { to: "resolved", label: "Resolve" }, { to: "dismissed", label: "Dismiss" }],
  escalated: [{ to: "resolved", label: "Resolve (handled)", primary: true }, { to: "dismissed", label: "Dismiss" }],
  resolved: [],
  dismissed: [],
};

/** Lead funnel actions per stage (human-only doorway). */
const LEAD_ACTIONS: Record<string, string[]> = {
  new: ["qualified", "lost"],
  qualified: ["engaged", "lost"],
  engaged: ["proposal", "lost"],
  proposal: ["won", "lost"],
  won: [],
  lost: [],
};

export default function SalesPage() {
  const [summary, setSummary] = useState<Summary | null>(null);
  const [inquiries, setInquiries] = useState<Inquiry[]>([]);
  const [leads, setLeads] = useState<Lead[]>([]);
  const [conversations, setConversations] = useState<Conversation[]>([]);
  const [siteKeys, setSiteKeys] = useState<SiteIntegration[]>([]);
  const [flag, setFlag] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [busy, setBusy] = useState("");
  const [openConv, setOpenConv] = useState<{ id: number; messages: Message[] } | null>(null);
  // manual intake forms
  const [inqName, setInqName] = useState("");
  const [inqEmail, setInqEmail] = useState("");
  const [inqBody, setInqBody] = useState("");
  const [leadCompany, setLeadCompany] = useState("");
  const [leadName, setLeadName] = useState("");
  const [leadEmail, setLeadEmail] = useState("");
  const [leadScore, setLeadScore] = useState("");

  const load = useCallback(async function load() {
    setError("");
    const rc = await fetch("/api/admin/sales");
    if (rc.status === 401) { window.location.href = "/login"; return; }
    if (rc.status === 403) { setError("Your role does not include Sales manage access."); return; }
    if (rc.ok) {
      const j = (await rc.json()) as {
        data?: {
          summary: Summary;
          inquiries: Inquiry[];
          leads: Lead[];
          conversations: Conversation[];
          widgetIntegrations: SiteIntegration[];
          flags: { sales: boolean };
        };
      };
      setSummary(j.data?.summary ?? null);
      setInquiries(j.data?.inquiries ?? []);
      setLeads(j.data?.leads ?? []);
      setConversations(j.data?.conversations ?? []);
      setSiteKeys(j.data?.widgetIntegrations ?? []);
      setFlag(j.data?.flags?.sales ?? false);
    }
  }, []);

  useEffect(() => { void load(); }, [load]);

  function errText(j: { errors?: { code?: string; detail?: string }[] }, fallback: string): string {
    const e = j.errors?.[0];
    const map: Record<string, string> = {
      BAD_TRANSITION: "That transition is not legal from the current state.",
      BAD_STATE: "The record is not in a state that allows this action.",
      NOT_FOUND: "Record not found.",
      FLAG_DISABLED: "The sales workforce flag is OFF — the LLM classify leg did not run.",
      BUDGET_EXCEEDED: "Budget hard-stop reached — classification skipped.",
      INVALID_LEAD_INPUT: "Provide at least a company, contact name, or email.",
    };
    return e?.detail ?? map[e?.code ?? ""] ?? fallback;
  }

  async function transitionInquiry(i: Inquiry, to: string) {
    setBusy(`i${i.id}`); setNotice(""); setError("");
    try {
      const res = await fetch(`/api/admin/sales/inquiries/${i.id}`, {
        method: "PATCH", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ to }),
      });
      const j = (await res.json()) as { errors?: { code?: string; detail?: string }[] };
      if (!res.ok) { setError(errText(j, `Transition failed (${res.status})`)); return; }
      setNotice(`Inquiry #${i.id} → ${to}.`);
      await load();
    } finally { setBusy(""); }
  }

  async function classifyInquiry(i: Inquiry) {
    setBusy(`ci${i.id}`); setNotice(""); setError("");
    try {
      const res = await fetch("/api/admin/sales/classify", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ inquiryId: i.id }),
      });
      const j = (await res.json()) as { data?: { outcome: { classification: { classification: string; degraded: boolean }; leadId: number | null; escalated: boolean } }; errors?: { code?: string; detail?: string }[] };
      if (!res.ok || !j.data) { setError(errText(j, `Classify failed (${res.status})`)); return; }
      const o = j.data.outcome;
      setNotice(
        `Inquiry #${i.id} → ${o.classification.classification}` +
        (o.classification.degraded ? " (deterministic — LLM unavailable)" : " (LLM)") +
        (o.leadId ? `, lead #${o.leadId} scored` : "") +
        (o.escalated ? ", ESCALATED to a human" : "")
      );
      await load();
    } finally { setBusy(""); }
  }

  async function transitionLead(l: Lead, to: string) {
    setBusy(`l${l.id}`); setNotice(""); setError("");
    try {
      const res = await fetch(`/api/admin/sales/leads/${l.id}`, {
        method: "PATCH", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ to }),
      });
      const j = (await res.json()) as { errors?: { code?: string; detail?: string }[] };
      if (!res.ok) { setError(errText(j, `Stage transition failed (${res.status})`)); return; }
      setNotice(`Lead #${l.id} → ${to}.`);
      await load();
    } finally { setBusy(""); }
  }

  async function viewConversation(id: number) {
    setBusy(`v${id}`); setError("");
    try {
      const res = await fetch(`/api/admin/sales/conversations?id=${id}`);
      const j = (await res.json()) as { data?: { conversation: Conversation; messages: Message[] }; errors?: { code?: string }[] };
      if (!res.ok || !j.data) { setError(errText(j, `Load failed (${res.status})`)); return; }
      setOpenConv({ id, messages: j.data.messages });
    } finally { setBusy(""); }
  }

  async function createManualInquiry() {
    setBusy("minq"); setNotice(""); setError("");
    try {
      const res = await fetch("/api/admin/sales/inquiries", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: inqName || undefined, email: inqEmail || undefined, body: inqBody }),
      });
      const j = (await res.json()) as { errors?: { code?: string; detail?: string }[] };
      if (!res.ok) { setError(errText(j, `Create failed (${res.status})`)); return; }
      setNotice("Inquiry recorded and classified.");
      setInqName(""); setInqEmail(""); setInqBody("");
      await load();
    } finally { setBusy(""); }
  }

  async function createManualLead() {
    setBusy("mlead"); setNotice(""); setError("");
    try {
      const res = await fetch("/api/admin/sales/leads", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          company: leadCompany || undefined,
          contactName: leadName || undefined,
          contactEmail: leadEmail || undefined,
          leadScore: leadScore ? Number(leadScore) : undefined,
        }),
      });
      const j = (await res.json()) as { data?: { created: boolean }; errors?: { code?: string; detail?: string }[] };
      if (!res.ok || !j.data) { setError(errText(j, `Create failed (${res.status})`)); return; }
      setNotice(j.data.created ? "Lead created." : "Existing lead for that email was updated (score ratchets up, never down).");
      setLeadCompany(""); setLeadName(""); setLeadEmail(""); setLeadScore("");
      await load();
    } finally { setBusy(""); }
  }

  return (
    <div className="space-y-6 max-w-6xl">
      <div>
        <h1 className="text-2xl font-semibold">Sales</h1>
        <p className="text-sm mt-1">
          Inquiries → classified, scored leads → human escalation. Widget chats persist as conversations;
          hot leads and high-urgency inquiries page ops automatically.
        </p>
        <div className="flex flex-wrap items-center gap-2 mt-2">
          <span className={flag ? "cc-badge cc-badge-ok" : "cc-badge cc-badge-muted"}>
            sales workforce: {flag ? "ON" : "OFF (deterministic-only classification)"}
          </span>
        </div>
      </div>

      {error && <div className="cc-badge cc-badge-danger px-3 py-2 rounded-lg text-sm">{error}</div>}
      {notice && <div className="cc-badge cc-badge-ok px-3 py-2 rounded-lg text-sm">{notice}</div>}

      {summary && (
        <div className="grid gap-2" style={{ gridTemplateColumns: "repeat(auto-fit, minmax(140px, 1fr))" }}>
          <div className="cc-card p-3">
            <div className="text-xs">New inquiries</div>
            <div className="text-2xl font-semibold">{summary.inquiries["new"] ?? 0}</div>
          </div>
          <div className="cc-card p-3">
            <div className="text-xs">Escalated</div>
            <div className="text-2xl font-semibold">{summary.inquiries["escalated"] ?? 0}</div>
          </div>
          <div className="cc-card p-3">
            <div className="text-xs">Open leads</div>
            <div className="text-2xl font-semibold">
              {(summary.leads["new"] ?? 0) + (summary.leads["qualified"] ?? 0) + (summary.leads["engaged"] ?? 0) + (summary.leads["proposal"] ?? 0)}
            </div>
          </div>
          <div className="cc-card p-3">
            <div className="text-xs">Hot leads</div>
            <div className="text-2xl font-semibold">{summary.hotLeads}</div>
          </div>
          <div className="cc-card p-3">
            <div className="text-xs">Conversations</div>
            <div className="text-2xl font-semibold">{summary.conversations.total}</div>
            <div className="text-xs mt-1">{summary.conversations.active} active</div>
          </div>
        </div>
      )}

      {/* ---------------- Inquiries ---------------- */}
      <section className="cc-card p-4">
        <h2 className="font-semibold mb-3">Inquiries</h2>
        <div className="overflow-x-auto">
          <table className="cc-table w-full">
            <thead>
              <tr>
                <th>#</th><th>Status</th><th>Class</th><th>Urgency</th><th>Contact</th><th>Summary</th><th>By</th><th>Actions</th>
              </tr>
            </thead>
            <tbody>
              {inquiries.map((i) => (
                <tr key={i.id}>
                  <td>{i.id}{i.conversationId ? <span className="text-xs block">conv #{i.conversationId}</span> : null}</td>
                  <td><span className={INQUIRY_STATUS_STYLES[i.status] ?? "cc-badge"}>{i.status}</span></td>
                  <td>{i.classification ? <span className={CLASSIFICATION_STYLES[i.classification] ?? "cc-badge"}>{i.classification}</span> : <span className="cc-badge cc-badge-muted">—</span>}</td>
                  <td className="text-xs">{i.urgency ?? "—"}</td>
                  <td className="text-xs">{i.name ?? "—"}<br />{i.email ?? ""}</td>
                  <td className="text-xs">{i.summary ?? i.body.slice(0, 120)}</td>
                  <td className="text-xs">{i.classifiedBy ?? "—"}</td>
                  <td>
                    <div className="flex flex-wrap gap-1 mt-2">
                      {(INQUIRY_ACTIONS[i.status] ?? []).map((a) => (
                        <button
                          key={a.to}
                          className={a.primary ? "cc-btn cc-btn-primary" : "cc-btn"}
                          disabled={busy === `i${i.id}`}
                          onClick={() => void transitionInquiry(i, a.to)}
                        >
                          {a.label}
                        </button>
                      ))}
                      {(i.status === "new" || i.status === "classified") && (
                        <button className="cc-btn" disabled={busy === `ci${i.id}`} onClick={() => void classifyInquiry(i)}>
                          Classify
                        </button>
                      )}
                      {i.conversationId && (
                        <button className="cc-btn" disabled={busy === `v${i.conversationId}`} onClick={() => void viewConversation(i.conversationId as number)}>
                          Transcript
                        </button>
                      )}
                    </div>
                  </td>
                </tr>
              ))}
              {inquiries.length === 0 && (
                <tr><td colSpan={8} className="text-sm">No inquiries yet — they arrive from the widget follow-up form or manual intake below.</td></tr>
              )}
            </tbody>
          </table>
        </div>
      </section>

      {/* ---------------- Leads pipeline ---------------- */}
      <section className="cc-card p-4">
        <h2 className="font-semibold mb-3">Lead pipeline</h2>
        <div className="overflow-x-auto">
          <table className="cc-table w-full">
            <thead>
              <tr><th>#</th><th>Stage</th><th>Score</th><th>Contact</th><th>Next action</th><th>By</th><th>Move</th></tr>
            </thead>
            <tbody>
              {leads.map((l) => (
                <tr key={l.id}>
                  <td>{l.id}</td>
                  <td><span className={STAGE_STYLES[l.stage] ?? "cc-badge"}>{l.stage}</span></td>
                  <td>
                    <span className={BAND_STYLES[l.scoreBand] ?? "cc-badge"}>{l.scoreBand}</span>
                    <span className="text-xs block">{l.leadScore}/100</span>
                  </td>
                  <td className="text-xs">
                    {l.company ?? "—"}<br />
                    {l.contactName ?? ""}{l.contactEmail ? ` · ${l.contactEmail}` : ""}
                  </td>
                  <td className="text-xs">{l.nextAction ?? "—"}{l.scoreRationale ? <span className="text-xs block mt-1">({l.scoreRationale})</span> : null}</td>
                  <td className="text-xs">{l.scoredBy ?? "—"}</td>
                  <td>
                    <div className="flex flex-wrap gap-1 mt-2">
                      {(LEAD_ACTIONS[l.stage] ?? []).map((to) => (
                        <button
                          key={to}
                          className={to === "won" ? "cc-btn cc-btn-primary" : "cc-btn"}
                          disabled={busy === `l${l.id}`}
                          onClick={() => void transitionLead(l, to)}
                        >
                          {to}
                        </button>
                      ))}
                    </div>
                  </td>
                </tr>
              ))}
              {leads.length === 0 && (
                <tr><td colSpan={7} className="text-sm">No leads yet — sales-classified inquiries with an email create them automatically.</td></tr>
              )}
            </tbody>
          </table>
        </div>
      </section>

      {/* ---------------- Conversations ---------------- */}
      <section className="cc-card p-4">
        <h2 className="font-semibold mb-3">Conversations</h2>
        <div className="space-y-2">
          {conversations.map((c) => (
            <div key={c.id} className="flex flex-wrap items-center gap-2">
              <span className="text-sm font-medium">#{c.id}</span>
              <span className={c.status === "active" ? "cc-badge cc-badge-ok" : "cc-badge cc-badge-muted"}>{c.status}</span>
              <span className="text-xs">{c.channel}{c.websiteId ? ` · website #${c.websiteId}` : ""}</span>
              <button className="cc-btn" disabled={busy === `v${c.id}`} onClick={() => void viewConversation(c.id)}>View transcript</button>
            </div>
          ))}
          {conversations.length === 0 && <div className="text-sm">No conversations yet.</div>}
        </div>
        {openConv && (
          <div className="mt-3 space-y-2 cc-card p-3">
            <div className="flex flex-wrap items-center justify-between">
              <div className="text-sm font-semibold">Transcript #{openConv.id}</div>
              <button className="cc-btn" onClick={() => setOpenConv(null)}>Close</button>
            </div>
            {openConv.messages.map((m) => (
              <div key={m.id} className="text-xs">
                <strong>{m.role === "visitor" ? "Visitor" : "Assistant"}</strong>: {m.content}
              </div>
            ))}
            {openConv.messages.length === 0 && <div className="text-xs">No messages.</div>}
          </div>
        )}
      </section>

      {/* ---------------- Manual intake + site keys ---------------- */}
      <div className="grid gap-2" style={{ gridTemplateColumns: "repeat(auto-fit, minmax(320px, 1fr))" }}>
        <section className="cc-card p-4">
          <h2 className="font-semibold mb-3">Manual inquiry</h2>
          <div className="grid gap-2">
            <input className="cc-btn" placeholder="Contact name (optional)" value={inqName} onChange={(e) => setInqName(e.target.value)} />
            <input className="cc-btn" placeholder="Email (optional)" value={inqEmail} onChange={(e) => setInqEmail(e.target.value)} />
            <textarea className="cc-btn" rows={3} placeholder="What did they ask for?" value={inqBody} onChange={(e) => setInqBody(e.target.value)} />
            <button className="cc-btn cc-btn-primary" disabled={busy === "minq" || !inqBody.trim()} onClick={() => void createManualInquiry()}>
              Record + classify
            </button>
          </div>
        </section>
        <section className="cc-card p-4">
          <h2 className="font-semibold mb-3">Manual lead</h2>
          <div className="grid gap-2">
            <input className="cc-btn" placeholder="Company" value={leadCompany} onChange={(e) => setLeadCompany(e.target.value)} />
            <input className="cc-btn" placeholder="Contact name" value={leadName} onChange={(e) => setLeadName(e.target.value)} />
            <input className="cc-btn" placeholder="Contact email" value={leadEmail} onChange={(e) => setLeadEmail(e.target.value)} />
            <input className="cc-btn" placeholder="Score 0-100 (optional)" value={leadScore} onChange={(e) => setLeadScore(e.target.value)} />
            <button className="cc-btn cc-btn-primary" disabled={busy === "mlead"} onClick={() => void createManualLead()}>
              Save lead
            </button>
          </div>
        </section>
      </div>

      <section className="cc-card p-4">
        <h2 className="font-semibold mb-3">Widget site registrations (connector #1)</h2>
        {siteKeys.length === 0 && <div className="text-sm">No widget integrations registered yet — add one under Websites.</div>}
        <div className="space-y-2">
          {siteKeys.map((s) => (
            <div key={`${s.websiteId}-${s.siteKeyMasked}`} className="flex flex-wrap items-center gap-2">
              <span className="text-sm font-medium">{s.websiteName}</span>
              <span className={s.status === "active" ? "cc-badge cc-badge-ok" : "cc-badge cc-badge-muted"}>{s.status}</span>
              <span className="text-xs">site key: {s.siteKeyMasked ?? "(not generated)"}</span>
            </div>
          ))}
        </div>
      </section>
    </div>
  );
}
