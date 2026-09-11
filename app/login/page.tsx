"use client";

import { useState } from "react";

/**
 * /login — the only sign-in surface (Phase 1 M1).
 * Email + password → POST /api/auth/login → httpOnly session cookie.
 * The password is sent once over the wire and never stored anywhere in
 * the browser (the sessionStorage pattern is deleted).
 */
export default function LoginPage() {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError("");
    try {
      const r = await fetch("/api/auth/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email, password }),
      });
      if (r.ok) {
        window.location.href = "/dashboard";
        return;
      }
      const j = (await r.json().catch(() => ({}))) as { errors?: { code?: string }[] };
      const code = j.errors?.[0]?.code;
      setError(
        code === "ACCOUNT_LOCKED"
          ? "Account temporarily locked. Try again in 15 minutes."
          : code === "RATE_LIMITED"
            ? "Too many attempts. Wait a few minutes and retry."
            : "Invalid email or password."
      );
    } catch {
      setError("Network error. Please try again.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <main className="min-h-screen flex items-center justify-center p-6" style={{ background: "var(--shell)" }}>
      <div className="w-full max-w-sm">
        <div className="text-center mb-6">
          <h1 className="text-2xl font-semibold" style={{ color: "var(--shell-foreground)" }}>
            AgentOS Command Center
          </h1>
          <p className="text-sm mt-1" style={{ color: "var(--muted)" }}>
            Sign in with your platform account
          </p>
        </div>
        <form onSubmit={submit} className="cc-card space-y-4">
          <div>
            <label className="cc-label" htmlFor="email">Email</label>
            <input
              id="email"
              type="email"
              className="cc-input"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              autoComplete="email"
              required
            />
          </div>
          <div>
            <label className="cc-label" htmlFor="password">Password</label>
            <input
              id="password"
              type="password"
              className="cc-input"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              autoComplete="current-password"
              required
            />
          </div>
          {error && (
            <p className="text-sm font-medium" style={{ color: "var(--danger)" }} role="alert">
              {error}
            </p>
          )}
          <button type="submit" className="cc-btn cc-btn-primary w-full" disabled={busy}>
            {busy ? "Signing in…" : "Sign in"}
          </button>
        </form>
      </div>
    </main>
  );
}
