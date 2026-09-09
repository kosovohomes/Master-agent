"use client";
import { useEffect, useState } from "react";

type Draft = { id: number; agent: string; channel: string; content: string; status: string; review_notes: string | null };

function authHeaders(): HeadersInit {
  const pw = sessionStorage.getItem("agentos_admin_pw") ?? "";
  return { "Content-Type": "application/json", Authorization: `Bearer ${pw}` };
}

export default function Admin() {
  const [tenantId, setTenantId] = useState("");
  const [drafts, setDrafts] = useState<Draft[]>([]);
  async function load() {
    const r = await fetch(`/api/admin/drafts?tenantId=${tenantId}`, { headers: authHeaders() });
    if (r.status === 401) { window.location.href = "/admin/login"; return; }
    if (r.ok) setDrafts((await r.json()).data ?? []);
  }
  async function act(id: number, action: string, comment = "") {
    await fetch(`/api/admin/drafts/${id}`, { method: "POST", headers: authHeaders(), body: JSON.stringify({ action, comment }) });
    load();
  }
  useEffect(() => { if (!sessionStorage.getItem("agentos_admin_pw")) window.location.href = "/admin/login"; }, []);
  return (
    <main style={{ fontFamily: "system-ui, sans-serif", padding: 24, maxWidth: 720, margin: "0 auto" }}>
      <h1>AgentOS approval queue</h1>
      <input value={tenantId} onChange={(e) => setTenantId(e.target.value)} placeholder="Tenant id" />
      <button onClick={load}>Load</button>
      {drafts.map((d) => (
        <article key={d.id} style={{ border: "1px solid #ccc", borderRadius: 8, padding: 12, margin: "8px 0" }}>
          <p><strong>{d.agent}</strong> → {d.channel} · {d.status}</p>
          <pre style={{ whiteSpace: "pre-wrap" }}>{d.content}</pre>
          {d.status === "pending" && (
            <p><button onClick={() => act(d.id, "approve")}>Approve</button> <button onClick={() => act(d.id, "reject", "tone")}>Reject</button></p>
          )}
          {d.status === "approved" && <button onClick={() => act(d.id, "schedule")}>Schedule</button>}
        </article>
      ))}
    </main>
  );
}