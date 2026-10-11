"use client";

import { useCallback, useEffect, useState } from "react";

/**
 * Add-Website wizard (Phase 14 — §121): information → agents → integrations →
 * knowledge → permissions → autonomy → activate. One guarded call to
 * POST /api/admin/websites/onboard executes the whole sequence as pure
 * configuration; this UI collects the inputs and renders the per-step
 * manifest plus the reveal-once connector credentials.
 */

type AgentOption = { id: number; slug: string; name: string; status: string };

type StepResult = {
  step: string;
  status: "created" | "existing" | "granted" | "skipped" | "failed";
  ref?: string;
  id?: number;
  detail?: string;
};

type OnboardResponse = {
  data?: {
    businessUnitId: number;
    websiteId: number;
    websiteSlug: string;
    websiteStatus: string;
    steps: StepResult[];
    signingSecret?: string;
    siteKey?: string;
  };
  errors?: { code?: string; detail?: string }[];
};

const CAPABILITY_CATALOG = [
  "READ_CONTENT",
  "CREATE_CONTENT",
  "UPDATE_CONTENT",
  "PUBLISH_CONTENT",
  "READ_LEADS",
  "CREATE_LEAD",
  "READ_ANALYTICS",
  "SEND_NOTIFICATION",
  "READ_PRODUCTS",
  "chat.answer",
];

const STATUS_CLASS: Record<StepResult["status"], string> = {
  created: "cc-badge cc-badge-ok",
  existing: "cc-badge",
  granted: "cc-badge cc-badge-ok",
  skipped: "cc-badge cc-badge-muted",
  failed: "cc-badge cc-badge-warn",
};

export default function OnboardWizard({ bus, canCreateBu, onDone }: {
  bus: { id: number; name: string }[];
  canCreateBu: boolean;
  onDone: () => Promise<void> | void;
}) {
  const [open, setOpen] = useState(false);
  const [agents, setAgents] = useState<AgentOption[]>([]);
  const [agentsLoadError, setAgentsLoadError] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [result, setResult] = useState<OnboardResponse["data"] | null>(null);

  // step 1 — information
  const [buMode, setBuMode] = useState<"existing" | "new">("existing");
  const [buId, setBuId] = useState("");
  const [buName, setBuName] = useState("");
  const [siteName, setSiteName] = useState("");
  const [siteSlug, setSiteSlug] = useState("");
  const [domain, setDomain] = useState("");
  const [locale, setLocale] = useState("en");
  const [businessType, setBusinessType] = useState("");
  const [jurisdiction, setJurisdiction] = useState("");
  const [market, setMarket] = useState("");
  const [brand, setBrand] = useState("");
  // step 2 — agents
  const [selectedAgents, setSelectedAgents] = useState<string[]>([]);
  // step 3 — integrations
  const [wantWebhook, setWantWebhook] = useState(true);
  const [wantWidget, setWantWidget] = useState(false);
  // step 4 — knowledge
  const [kKind, setKKind] = useState("");
  const [kRef, setKRef] = useState("");
  const [kJurisdiction, setKJurisdiction] = useState("");
  // step 5 — permissions
  const [caps, setCaps] = useState<string[]>(["chat.answer", "CREATE_LEAD"]);
  // step 6 — autonomy (single legal value until P15)

  const loadAgents = useCallback(async function loadAgents() {
    setAgentsLoadError(false);
    const r = await fetch("/api/admin/agents");
    if (!r.ok) {
      setAgentsLoadError(true); // caller may lack agents.read — free-text fallback
      return;
    }
    const j = (await r.json()) as { data?: AgentOption[] };
    setAgents((j.data ?? []).filter((a) => a.status === "active"));
  }, []);

  useEffect(() => {
    if (open) void loadAgents();
  }, [open, loadAgents]);

  function toggleAgent(slug: string) {
    setSelectedAgents((prev) => (prev.includes(slug) ? prev.filter((s) => s !== slug) : [...prev, slug]));
  }
  function toggleCap(c: string) {
    setCaps((prev) => (prev.includes(c) ? prev.filter((x) => x !== c) : [...prev, c]));
  }

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setError("");
    setResult(null);
    if (!siteName.trim()) return setError("Website name is required.");
    if (buMode === "existing" && !buId) return setError("Pick a business unit (or switch to “New business unit”).");
    if (buMode === "new" && !buName.trim()) return setError("New business unit name is required.");

    const payload: Record<string, unknown> = {
      businessUnit: buMode === "existing"
        ? { id: Number(buId) }
        : { name: buName.trim() },
      website: {
        name: siteName.trim(),
        slug: siteSlug.trim() || undefined,
        domain: domain.trim() || undefined,
        defaultLocale: locale.trim() || undefined,
        businessType: businessType.trim() || undefined,
        jurisdiction: jurisdiction.trim() || undefined,
        market: market.trim() || undefined,
        brand: brand.trim() || undefined,
      },
      agents: agentsLoadError
        ? (selectedAgents.length > 0 ? selectedAgents : undefined)
        : (selectedAgents.length > 0 ? selectedAgents : undefined),
      integrations: { webhook: wantWebhook, widget: wantWidget },
      capabilities: caps,
      autonomy: "approval_required",
      activate: true,
    };
    if (kKind && kRef.trim()) {
      payload.knowledge = [{
        kind: kKind,
        ref: kRef.trim(),
        jurisdiction: kJurisdiction.trim() || null,
        accessLevel: "public",
      }];
    }

    setBusy(true);
    try {
      const r = await fetch("/api/admin/websites/onboard", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      const j = (await r.json().catch(() => ({}))) as OnboardResponse;
      if (!r.ok && !j.data) {
        setError(j.errors?.[0]?.detail ?? j.errors?.[0]?.code ?? `Onboarding failed (${r.status})`);
        return;
      }
      if (j.data) setResult(j.data);
      await onDone();
    } finally {
      setBusy(false);
    }
  }

  if (!open) {
    return (
      <button type="button" className="cc-btn cc-btn-primary" onClick={() => setOpen(true)}>
        Add Website (wizard)
      </button>
    );
  }

  return (
    <form onSubmit={submit} className="mt-4 space-y-4">
      {/* §121 step 1 — Enter information */}
      <fieldset className="cc-card space-y-3">
        <legend className="text-sm font-semibold px-1">1 · Information</legend>
        <div className="grid gap-3 sm:grid-cols-3">
          <div>
            <label className="cc-label" htmlFor="ob-bu-mode">Business unit</label>
            <select id="ob-bu-mode" className="cc-input" value={buMode} onChange={(e) => setBuMode(e.target.value as "existing" | "new")}>
              <option value="existing">Existing…</option>
              {canCreateBu && <option value="new">New business unit</option>}
            </select>
          </div>
          {buMode === "existing" ? (
            <div>
              <label className="cc-label" htmlFor="ob-bu">Choose unit</label>
              <select id="ob-bu" className="cc-input" value={buId} onChange={(e) => setBuId(e.target.value)}>
                <option value="">Choose…</option>
                {bus.map((b) => <option key={b.id} value={b.id}>{b.name}</option>)}
              </select>
            </div>
          ) : (
            <div>
              <label className="cc-label" htmlFor="ob-bu-name">New unit name</label>
              <input id="ob-bu-name" className="cc-input" value={buName} onChange={(e) => setBuName(e.target.value)} placeholder="WakeelyPro" />
            </div>
          )}
          <div>
            <label className="cc-label" htmlFor="ob-name">Website name *</label>
            <input id="ob-name" className="cc-input" value={siteName} onChange={(e) => setSiteName(e.target.value)} placeholder="AI News Platform" />
          </div>
          <div>
            <label className="cc-label" htmlFor="ob-slug">Slug (optional)</label>
            <input id="ob-slug" className="cc-input" value={siteSlug} onChange={(e) => setSiteSlug(e.target.value)} placeholder="auto from name" />
          </div>
          <div>
            <label className="cc-label" htmlFor="ob-domain">Domain</label>
            <input id="ob-domain" className="cc-input" value={domain} onChange={(e) => setDomain(e.target.value)} placeholder="news.example.com" />
          </div>
          <div>
            <label className="cc-label" htmlFor="ob-locale">Language / locale</label>
            <input id="ob-locale" className="cc-input" value={locale} onChange={(e) => setLocale(e.target.value)} placeholder="en" />
          </div>
          <div>
            <label className="cc-label" htmlFor="ob-type">Business type</label>
            <input id="ob-type" className="cc-input" value={businessType} onChange={(e) => setBusinessType(e.target.value)} placeholder="AI / Legal AI" />
          </div>
          <div>
            <label className="cc-label" htmlFor="ob-jur">Jurisdiction</label>
            <input id="ob-jur" className="cc-input" value={jurisdiction} onChange={(e) => setJurisdiction(e.target.value)} placeholder="USA, Jordan, UAE" />
          </div>
          <div>
            <label className="cc-label" htmlFor="ob-market">Market</label>
            <input id="ob-market" className="cc-input" value={market} onChange={(e) => setMarket(e.target.value)} placeholder="Global" />
          </div>
          <div>
            <label className="cc-label" htmlFor="ob-brand">Brand</label>
            <input id="ob-brand" className="cc-input" value={brand} onChange={(e) => setBrand(e.target.value)} placeholder="Voice / positioning" />
          </div>
        </div>
      </fieldset>

      {/* §121 step 2 — Select agents */}
      <fieldset className="cc-card space-y-2">
        <legend className="text-sm font-semibold px-1">2 · Agents</legend>
        {agentsLoadError ? (
          <div>
            <label className="cc-label" htmlFor="ob-agents-free">Agent slugs (comma-separated — registry list unavailable)</label>
            <input id="ob-agents-free" className="cc-input" value={selectedAgents.join(", ")} onChange={(e) => setSelectedAgents(e.target.value.split(",").map((s) => s.trim()).filter(Boolean))} placeholder="research, content" />
          </div>
        ) : (
          <div className="flex flex-wrap gap-2">
            {agents.map((a) => (
              <label key={a.slug} className={`cc-btn text-xs ${selectedAgents.includes(a.slug) ? "cc-btn-primary" : ""}`}>
                <input type="checkbox" className="mr-1" checked={selectedAgents.includes(a.slug)} onChange={() => toggleAgent(a.slug)} />
                {a.name}
              </label>
            ))}
            {agents.length === 0 && <span className="text-sm" style={{ color: "var(--muted)" }}>No active agents visible.</span>}
          </div>
        )}
        <p className="text-xs" style={{ color: "var(--muted)" }}>Selection is recorded as site configuration; execution binding arrives with the Supervisor (P14).</p>
      </fieldset>

      {/* §121 step 3 — Connect integrations */}
      <fieldset className="cc-card space-y-2">
        <legend className="text-sm font-semibold px-1">3 · Integrations</legend>
        <div className="flex flex-wrap gap-4 text-sm">
          <label className="flex items-center gap-2">
            <input type="checkbox" checked={wantWebhook} onChange={(e) => setWantWebhook(e.target.checked)} />
            Signed webhook connector (site → platform events)
          </label>
          <label className="flex items-center gap-2">
            <input type="checkbox" checked={wantWidget} onChange={(e) => setWantWidget(e.target.checked)} />
            Widget connector (chat + lead intake, site key)
          </label>
        </div>
      </fieldset>

      {/* §121 step 4 — Add knowledge (optional) */}
      <fieldset className="cc-card space-y-3">
        <legend className="text-sm font-semibold px-1">4 · Knowledge (optional seed source)</legend>
        <div className="grid gap-3 sm:grid-cols-3">
          <div>
            <label className="cc-label" htmlFor="ob-k-kind">Kind</label>
            <select id="ob-k-kind" className="cc-input" value={kKind} onChange={(e) => setKKind(e.target.value)}>
              <option value="">None</option>
              <option value="sitemap">sitemap</option>
              <option value="url">url</option>
              <option value="rss">rss</option>
              <option value="api">api</option>
            </select>
          </div>
          <div className="sm:col-span-2">
            <label className="cc-label" htmlFor="ob-k-ref">Ref (URL)</label>
            <input id="ob-k-ref" className="cc-input" value={kRef} onChange={(e) => setKRef(e.target.value)} placeholder="https://news.example.com/sitemap.xml" disabled={!kKind} />
          </div>
          <div>
            <label className="cc-label" htmlFor="ob-k-jur">Jurisdiction (optional)</label>
            <input id="ob-k-jur" className="cc-input" value={kJurisdiction} onChange={(e) => setKJurisdiction(e.target.value)} disabled={!kKind} />
          </div>
        </div>
      </fieldset>

      {/* §121 step 5 — Set permissions (capability grants, §12) */}
      <fieldset className="cc-card space-y-2">
        <legend className="text-sm font-semibold px-1">5 · Permissions (capability grants)</legend>
        <div className="flex flex-wrap gap-2">
          {CAPABILITY_CATALOG.map((c) => (
            <label key={c} className={`cc-btn text-xs ${caps.includes(c) ? "cc-btn-primary" : ""}`}>
              <input type="checkbox" className="mr-1" checked={caps.includes(c)} onChange={() => toggleCap(c)} />
              {c}
            </label>
          ))}
        </div>
        <p className="text-xs" style={{ color: "var(--muted)" }}>chat.answer / CREATE_LEAD gate the widget chat and lead intake for key-bearing embeds (enforced server-side).</p>
      </fieldset>

      {/* §121 step 6 — Set autonomy */}
      <fieldset className="cc-card space-y-2">
        <legend className="text-sm font-semibold px-1">6 · Autonomy</legend>
        <label className="flex items-center gap-2 text-sm">
          <input type="radio" checked readOnly />
          Approval required — generation autonomous, publication human-gated (levels arrive at P15)
        </label>
      </fieldset>

      {/* §121 step 7 — Activate */}
      <div className="flex items-center gap-3">
        <button type="submit" className="cc-btn cc-btn-primary" disabled={busy}>
          {busy ? "Onboarding…" : "Review & Activate"}
        </button>
        <button type="button" className="cc-btn" onClick={() => { setOpen(false); setResult(null); setError(""); }}>
          Close
        </button>
      </div>

      {error && <div className="cc-card text-sm font-medium" style={{ borderColor: "var(--danger)", color: "var(--danger)" }}>{error}</div>}

      {result && (
        <div className="cc-card space-y-3">
          <h3 className="text-sm font-semibold">Onboarding result — website #{result.websiteId} “{result.websiteSlug}” ({result.websiteStatus})</h3>
          <table className="cc-table">
            <thead><tr><th>Step</th><th>Status</th><th>Ref</th><th>Detail</th></tr></thead>
            <tbody>
              {result.steps.map((s, i) => (
                <tr key={`${s.step}-${i}`}>
                  <td>{s.step}</td>
                  <td><span className={STATUS_CLASS[s.status]}>{s.status}</span></td>
                  <td>{s.ref ?? s.id ?? "—"}</td>
                  <td className="text-xs">{s.detail ?? "—"}</td>
                </tr>
              ))}
            </tbody>
          </table>
          {result.signingSecret && (
            <div className="text-sm">
              <span className="cc-label">Webhook signing secret (shown once):</span>{" "}
              <code className="text-xs break-all">{result.signingSecret}</code>
            </div>
          )}
          {result.siteKey && (
            <div className="text-sm">
              <span className="cc-label">Widget site key (shown once):</span>{" "}
              <code className="text-xs break-all">{result.siteKey}</code>
            </div>
          )}
          <p className="text-xs" style={{ color: "var(--muted)" }}>
            Credentials are never stored in plaintext or shown again — rotate from the Connectors screen if lost.
          </p>
        </div>
      )}
    </form>
  );
}
