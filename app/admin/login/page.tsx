"use client";
import { useState } from "react";

export default function AdminLogin() {
  const [pw, setPw] = useState("");
  const [msg, setMsg] = useState("");
  async function submit() {
    const r = await fetch("/api/admin/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ password: pw }),
    });
    if (r.ok) {
      sessionStorage.setItem("agentos_admin_pw", pw);
      window.location.href = "/admin";
    } else {
      setMsg("Wrong password");
    }
  }
  return (
    <main style={{ fontFamily: "system-ui, sans-serif", padding: 24, maxWidth: 360, margin: "0 auto" }}>
      <h1>AgentOS admin</h1>
      <input type="password" value={pw} onChange={(e) => setPw(e.target.value)} placeholder="Admin password" />
      <button onClick={submit}>Log in</button>
      {msg && <p>{msg}</p>}
    </main>
  );
}