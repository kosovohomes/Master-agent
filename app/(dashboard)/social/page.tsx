"use client";

import { useCallback, useEffect, useState } from "react";

/**
 * /social — Social workforce control screen (Phase 10, roadmap §466).
 * Accounts (health + OAuth lifecycle), campaigns, the scheduling calendar
 * (time semantics), the post queue with FSM status, and the on-demand sweep
 * trigger. Reads and writes /api/admin/social* (social.manage server-side).
 */
type Account = {
  id: number;
  businessUnitId: number;
  platform: string;
  displayName: string | null;
  accountRef: string | null;
  oauthStatus: string;
  source: string;
  health: string;
  tokenExpiresAt: string | null;
};

type Campaign = {
  id: number;
  businessUnitId: number;
  name: string;
  objective: string | null;
  status: string;
  startsAt: string | null;
  endsAt: string | null;
};

type Post = {
  id: number;
  businessUnitId: number;
  contentItemId: number;
  campaignId: number | null;
  platform: string;
  body: string;
  status: string;
  scheduledAt: string | null;
  publishedAt: string | null;
  externalId: string | null;
  externalUrl: string | null;
  error: string | null;
};

type CalendarData = {
  from: string;
  to: string;
  days: { date: string; posts: Post[] }[];
};

type Metrics = {
  posts: number;
  totals: { impressions: number; likes: number; comments: number; shares: number; clicks: number };
};

type BusinessUnit = { id: number; name: string; slug: string };

const STATUS_STYLES: Record<string, string> = {
  draft: "cc-badge-muted",
  scheduled: "cc-badge-ok",
  publishing: "cc-badge-warn",
  posted: "cc-badge-ok",
  failed: "cc-badge-danger",
  cancelled: "cc-badge-muted",
};

const HEALTH_STYLES: Record<string, string> = {
  healthy: "cc-badge-ok",
  unhealthy: "cc-badge-danger",
};

const PLATFORMS = ["linkedin", "x", "instagram", "tiktok"];

function Badge({ cls, children }: { cls: string; children: React.ReactNode }) {
  return <span className={`cc-badge ${cls}`}>{children}</span>;
}

export default function SocialPage() {
  const [accounts, setAccounts] = useState<Account[]>([]);
  const [campaigns, setCampaigns] = useState<Campaign[]>([]);
  const [posts, setPosts] = useState<Post[]>([]);
  const [cal, setCal] = useState<CalendarData | null>(null);
  const [metrics, setMetrics] = useState<Metrics | null>(null);
  const [flags, setFlags] = useState<{ social: boolean; social_publish_ig_tiktok: boolean }>({ social: false, social_publish_ig_tiktok: false });
  const [oauth, setOauth] = useState<Record<string, boolean>>({});
  const [bus, setBus] = useState<BusinessUnit[]>([]);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [busy, setBusy] = useState("");
  // connect form
  const [accBu, setAccBu] = useState("");
  const [platform, setPlatform] = useState("linkedin");
  const [token, setToken] = useState("");
  const [accountRef, setAccountRef] = useState("");
  const [displayName, setDisplayName] = useState("");
  // campaign form
  const [campBu, setCampBu] = useState("");
  const [campName, setCampName] = useState("");
  const [campObjective, setCampObjective] = useState("");

  const load = useCallback(async function load() {
    setError("");
    const rc = await fetch("/api/admin/social");
    if (rc.status === 401) { window.location.href = "/login"; return; }
    if (rc.status === 403) { setError("Your role does not include social manage access."); return; }
    if (rc.ok) {
      const j = (await rc.json()) as {
        data?: {
          accounts: Account[]; campaigns: Campaign[]; posts: Post[]; calendar: CalendarData;
          metrics: Metrics; flags: { social: boolean; social_publish_ig_tiktok: boolean };
          oauthConfigured: Record<string, boolean>;
        };
      };
      const d = j.data;
      if (d) {
        setAccounts(d.accounts ?? []);
        setCampaigns(d.campaigns ?? []);
        setPosts(d.posts ?? []);
        setCal(d.calendar ?? null);
        setMetrics(d.metrics ?? null);
        setFlags(d.flags ?? { social: false, social_publish_ig_tiktok: false });
        setOauth(d.oauthConfigured ?? {});
      }
    }
    const rb = await fetch("/api/admin/business-units");
    if (rb.ok) {
      const j = (await rb.json()) as { data?: BusinessUnit[] };
      setBus(j.data ?? []);
    }
  }, []);

  useEffect(() => { void load(); }, [load]);

  async function connectAccount() {
    setBusy("connect"); setNotice(""); setError("");
    try {
      const res = await fetch("/api/admin/social/accounts", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          businessUnitId: Number(accBu), platform, token,
          accountRef: accountRef || null, displayName: displayName || null,
        }),
      });
      const j = (await res.json()) as { data?: { account: Account }; errors?: { code?: string; detail?: string }[] };
      if (!res.ok || !j.data) { setError(j.errors?.[0]?.detail ?? j.errors?.[0]?.code ?? `Connect failed (${res.status})`); return; }
      setToken(""); setAccountRef(""); setDisplayName("");
      setNotice(`${platform} account connected (credentials encrypted at rest).`);
      await load();
    } finally { setBusy(""); }
  }

  async function disconnect(id: number) {
    setBusy(`acc-${id}`); setNotice(""); setError("");
    try {
      const res = await fetch(`/api/admin/social/accounts/${id}`, { method: "DELETE" });
      if (!res.ok) { setError(`Disconnect failed (${res.status})`); return; }
      setNotice("Account disconnected.");
      await load();
    } finally { setBusy(""); }
  }

  async function createCampaign() {
    setBusy("campaign"); setNotice(""); setError("");
    try {
      const res = await fetch("/api/admin/social/campaigns", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ businessUnitId: Number(campBu), name: campName, objective: campObjective || null }),
      });
      const j = (await res.json()) as { errors?: { code?: string }[] };
      if (!res.ok) { setError(j.errors?.[0]?.code === "DUPLICATE" ? "A campaign with that name already exists in this BU." : `Create failed (${res.status})`); return; }
      setCampName(""); setCampObjective("");
      setNotice("Campaign created.");
      await load();
    } finally { setBusy(""); }
  }

  async function postAction(p: Post, action: "cancel") {
    setBusy(`post-${p.id}`); setNotice(""); setError("");
    try {
      const res = await fetch(`/api/admin/social/posts/${p.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action }),
      });
      const j = (await res.json()) as { errors?: { code?: string; detail?: string }[] };
      if (!res.ok) { setError(j.errors?.[0]?.detail ?? j.errors?.[0]?.code ?? `Action failed (${res.status})`); return; }
      setNotice(`Post #${p.id} cancelled.`);
      await load();
    } finally { setBusy(""); }
  }

  async function sweepNow() {
    setBusy("sweep"); setNotice(""); setError("");
    try {
      const res = await fetch("/api/admin/social/sweep", { method: "POST" });
      const j = (await res.json()) as { data?: { taskId: number; socialFlag: boolean }; errors?: { detail?: string }[] };
      if (!res.ok || !j.data) { setError(j.errors?.[0]?.detail ?? `Sweep failed (${res.status})`); return; }
      setNotice(j.data.socialFlag
        ? `Social sweep spawned as task #${j.data.taskId} — due posts publish when the engine tick processes it.`
        : `Sweep task #${j.data.taskId} spawned, but the social flag is OFF — the handler will skip fail-closed.`);
      await load();
    } finally { setBusy(""); }
  }

  const input = "cc-input";
  const buName = (id: number) => bus.find((b) => b.id === id)?.name ?? `BU #${id}`;

  return (
    <div className="space-y-6 max-w-6xl">
      <div>
        <h1 className="text-2xl font-semibold">Social</h1>
        <p className="text-sm mt-1" style={{ color: "var(--muted)" }}>
          Platform accounts, campaigns and the scheduling calendar for the social workforce.
          Nothing publishes without an approved content item behind it.
          <span className={`cc-badge ml-2 ${flags.social ? "cc-badge-ok" : "cc-badge-muted"}`}>social {flags.social ? "ON" : "OFF"}</span>
          <span className={`cc-badge ml-1 ${flags.social_publish_ig_tiktok ? "cc-badge-warn" : "cc-badge-muted"}`}>IG/TikTok {flags.social_publish_ig_tiktok ? "publish" : "draft-only"}</span>
        </p>
      </div>

      {error && <div className="cc-badge cc-badge-danger px-3 py-2 rounded-lg text-sm">{error}</div>}
      {notice && <div className="cc-badge cc-badge-ok px-3 py-2 rounded-lg text-sm">{notice}</div>}

      {/* Metrics */}
      <section className="grid gap-3" style={{ gridTemplateColumns: "repeat(auto-fit, minmax(150px, 1fr))" }}>
        {[
          { label: "Impressions", value: metrics?.totals.impressions ?? 0 },
          { label: "Likes", value: metrics?.totals.likes ?? 0 },
          { label: "Comments", value: metrics?.totals.comments ?? 0 },
          { label: "Shares", value: metrics?.totals.shares ?? 0 },
          { label: "Clicks", value: metrics?.totals.clicks ?? 0 },
        ].map((c) => (
          <div key={c.label} className="cc-card p-3">
            <div className="text-xs" style={{ color: "var(--muted)" }}>{c.label}</div>
            <div className="text-xl font-semibold">{c.value.toLocaleString()}</div>
          </div>
        ))}
      </section>

      {/* Accounts */}
      <section className="cc-card p-4">
        <h2 className="font-semibold mb-3">Accounts</h2>
        {accounts.length === 0 && <p className="text-sm" style={{ color: "var(--muted)" }}>No connected accounts yet.</p>}
        {accounts.length > 0 && (
          <table className="w-full text-sm">
            <thead>
              <tr className="text-left" style={{ color: "var(--muted)" }}>
                <th className="py-1 pr-3">Platform</th><th className="py-1 pr-3">BU</th><th className="py-1 pr-3">Display</th>
                <th className="py-1 pr-3">Account ref</th><th className="py-1 pr-3">Source</th><th className="py-1 pr-3">OAuth</th>
                <th className="py-1 pr-3">Health</th><th className="py-1"></th>
              </tr>
            </thead>
            <tbody>
              {accounts.map((a) => (
                <tr key={a.id} className="border-t" style={{ borderColor: "var(--border)" }}>
                  <td className="py-1.5 pr-3 font-medium">{a.platform}</td>
                  <td className="py-1.5 pr-3">{buName(a.businessUnitId)}</td>
                  <td className="py-1.5 pr-3">{a.displayName ?? "—"}</td>
                  <td className="py-1.5 pr-3 font-mono text-xs">{a.accountRef ?? "—"}</td>
                  <td className="py-1.5 pr-3">{a.source}</td>
                  <td className="py-1.5 pr-3">{a.oauthStatus}</td>
                  <td className="py-1.5 pr-3"><Badge cls={HEALTH_STYLES[a.health] ?? "cc-badge-muted"}>{a.health}</Badge></td>
                  <td className="py-1.5 text-right">
                    <button className="cc-btn cc-btn-danger" disabled={busy === `acc-${a.id}`} onClick={() => disconnect(a.id)}>Disconnect</button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
        <div className="mt-4 grid gap-2" style={{ gridTemplateColumns: "repeat(auto-fit, minmax(170px, 1fr))" }}>
          <select className={input} value={accBu} onChange={(e) => setAccBu(e.target.value)}>
            <option value="">Business unit…</option>
            {bus.map((b) => <option key={b.id} value={b.id}>{b.name}</option>)}
          </select>
          <select className={input} value={platform} onChange={(e) => setPlatform(e.target.value)}>
            {PLATFORMS.map((p) => <option key={p} value={p}>{p}{oauth[p] === false ? " (manual connect)" : ""}</option>)}
          </select>
          <input className={input} type="password" placeholder="Access token / PAT" value={token} onChange={(e) => setToken(e.target.value)} />
          <input className={input} placeholder="Account ref (LinkedIn URN, IG id)…" value={accountRef} onChange={(e) => setAccountRef(e.target.value)} />
          <input className={input} placeholder="Display name (optional)" value={displayName} onChange={(e) => setDisplayName(e.target.value)} />
          <button className="cc-btn cc-btn-primary" disabled={!accBu || !token || busy === "connect"} onClick={connectAccount}>Connect account</button>
        </div>
        {platform === "linkedin" && <p className="text-xs mt-2" style={{ color: "var(--muted)" }}>LinkedIn requires an account ref (author URN, e.g. urn:li:person:xxxx) — posts publish as that identity.</p>}
      </section>

      {/* Calendar */}
      <section className="cc-card p-4">
        <h2 className="font-semibold mb-3">Calendar <span className="text-xs font-normal" style={{ color: "var(--muted)" }}>next 14 days (UTC)</span></h2>
        {(!cal || cal.days.length === 0) && <p className="text-sm" style={{ color: "var(--muted)" }}>Nothing scheduled in the window.</p>}
        <div className="grid gap-2" style={{ gridTemplateColumns: "repeat(auto-fill, minmax(160px, 1fr))" }}>
          {cal?.days.map((d) => (
            <div key={d.date} className="cc-card p-2">
              <div className="text-xs font-semibold mb-1">{d.date}</div>
              {d.posts.map((p) => (
                <div key={p.id} className="text-xs mb-1 flex items-center gap-1">
                  <Badge cls={STATUS_STYLES[p.status] ?? "cc-badge-muted"}>{p.platform}</Badge>
                  <span style={{ color: "var(--muted)" }}>{new Date(p.scheduledAt as string).toISOString().slice(11, 16)}</span>
                </div>
              ))}
            </div>
          ))}
        </div>
      </section>

      {/* Posts */}
      <section className="cc-card p-4">
        <div className="flex items-center justify-between mb-3">
          <h2 className="font-semibold">Posts</h2>
          <button className="cc-btn cc-btn-primary" disabled={busy === "sweep"} onClick={sweepNow}>Run social sweep now</button>
        </div>
        {posts.length === 0 && <p className="text-sm" style={{ color: "var(--muted)" }}>No posts yet. Schedule one from an approved content item via the API (POST /api/admin/social/posts).</p>}
        {posts.length > 0 && (
          <table className="w-full text-sm">
            <thead>
              <tr className="text-left" style={{ color: "var(--muted)" }}>
                <th className="py-1 pr-3">#</th><th className="py-1 pr-3">Item</th><th className="py-1 pr-3">Platform</th>
                <th className="py-1 pr-3">Status</th><th className="py-1 pr-3">Scheduled (UTC)</th>
                <th className="py-1 pr-3">Body</th><th className="py-1"></th>
              </tr>
            </thead>
            <tbody>
              {posts.map((p) => (
                <tr key={p.id} className="border-t" style={{ borderColor: "var(--border)" }}>
                  <td className="py-1.5 pr-3">{p.id}</td>
                  <td className="py-1.5 pr-3">#{p.contentItemId}</td>
                  <td className="py-1.5 pr-3 font-medium">{p.platform}</td>
                  <td className="py-1.5 pr-3">
                    <Badge cls={STATUS_STYLES[p.status] ?? "cc-badge-muted"}>{p.status}</Badge>
                    {p.error && <div className="text-xs mt-1" style={{ color: "var(--danger)" }}>{p.error.slice(0, 120)}</div>}
                  </td>
                  <td className="py-1.5 pr-3">{p.scheduledAt ? new Date(p.scheduledAt).toISOString().replace("T", " ").slice(0, 16) : "—"}</td>
                  <td className="py-1.5 pr-3 max-w-xs truncate" title={p.body}>{p.body}</td>
                  <td className="py-1.5 text-right">
                    {(p.status === "draft" || p.status === "scheduled" || p.status === "failed") && (
                      <button className="cc-btn cc-btn-danger" disabled={busy === `post-${p.id}`} onClick={() => postAction(p, "cancel")}>Cancel</button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>

      {/* Campaigns */}
      <section className="cc-card p-4">
        <h2 className="font-semibold mb-3">Campaigns</h2>
        {campaigns.length === 0 && <p className="text-sm" style={{ color: "var(--muted)" }}>No campaigns yet.</p>}
        {campaigns.length > 0 && (
          <table className="w-full text-sm">
            <thead>
              <tr className="text-left" style={{ color: "var(--muted)" }}>
                <th className="py-1 pr-3">Name</th><th className="py-1 pr-3">BU</th><th className="py-1 pr-3">Objective</th><th className="py-1 pr-3">Status</th>
              </tr>
            </thead>
            <tbody>
              {campaigns.map((c) => (
                <tr key={c.id} className="border-t" style={{ borderColor: "var(--border)" }}>
                  <td className="py-1.5 pr-3 font-medium">{c.name}</td>
                  <td className="py-1.5 pr-3">{buName(c.businessUnitId)}</td>
                  <td className="py-1.5 pr-3">{c.objective ?? "—"}</td>
                  <td className="py-1.5 pr-3"><Badge cls="cc-badge-muted">{c.status}</Badge></td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
        <div className="mt-4 grid gap-2" style={{ gridTemplateColumns: "repeat(auto-fit, minmax(170px, 1fr))" }}>
          <select className={input} value={campBu} onChange={(e) => setCampBu(e.target.value)}>
            <option value="">Business unit…</option>
            {bus.map((b) => <option key={b.id} value={b.id}>{b.name}</option>)}
          </select>
          <input className={input} placeholder="Campaign name" value={campName} onChange={(e) => setCampName(e.target.value)} />
          <input className={input} placeholder="Objective (optional)" value={campObjective} onChange={(e) => setCampObjective(e.target.value)} />
          <button className="cc-btn cc-btn-primary" disabled={!campBu || !campName.trim() || busy === "campaign"} onClick={createCampaign}>Create campaign</button>
        </div>
      </section>
    </div>
  );
}
