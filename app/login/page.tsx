"use client";

import { Suspense, useEffect, useState } from "react";
import { useSearchParams } from "next/navigation";

/**
 * /login — the sign-in surface (Phase 1 M1; overhauled by the Access &
 * Identity Overhaul).
 *
 * Two methods, fail-closed:
 *  - "Continue with Google" renders only when the server reports the OAuth
 *    client configured (GET /api/auth/providers) — the button is never a
 *    dead end.
 *  - Email + password → POST /api/auth/login → httpOnly session cookie.
 *
 * Errors coming back from the OAuth round trip (?error=...) map to friendly
 * copy; the password path keeps the generic no-enumeration message.
 */

const ERROR_COPY: Record<string, string> = {
  oauth_unconfigured: "Google sign-in is not configured on the server yet. Use email and password, or add GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET.",
  oauth_state: "Sign-in attempt expired or was tampered with. Please try again.",
  oauth_exchange: "Google sign-in failed during token exchange. Please try again.",
  provider_unreachable: "Google was unreachable. Please try again in a moment.",
  oauth_cancelled: "Google sign-in was cancelled.",
  oauth_error: "Google sign-in failed. Please try again.",
  email_unverified: "Your Google account email is not verified. Verify it at Google and retry.",
  not_authorized: "This Google account is not authorized for the Command Center. Ask the owner to add it to OWNER_EMAILS.",
  identity_conflict: "This Google account is linked to a different identity. Contact operations.",
  account_disabled: "This account is disabled. Contact the owner.",
  rate_limited: "Too many attempts. Wait a few minutes and retry.",
};

function LoginInner() {
  const params = useSearchParams();
  const queryError = params.get("error");
  const [googleReady, setGoogleReady] = useState(false);
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (queryError) setError(ERROR_COPY[queryError] ?? "Sign-in failed. Please try again.");
    fetch("/api/auth/providers")
      .then((r) => (r.ok ? r.json() : null))
      .then((j) => { if (j?.data?.google) setGoogleReady(true); })
      .catch(() => { /* password path stays available */ });
  }, [queryError]);

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
    <div className="w-full max-w-sm">
      <div className="text-center mb-6">
        <h1 className="text-2xl font-semibold" style={{ color: "var(--shell-foreground)" }}>
          AgentOS Command Center
        </h1>
        <p className="text-sm mt-1" style={{ color: "var(--muted)" }}>
          Sign in with your platform account
        </p>
      </div>

      {googleReady && (
        <>
          <a
            href="/api/auth/oauth/google/start"
            data-testid="google-signin"
            className="cc-btn w-full flex items-center justify-center gap-3"
            style={{
              background: "#ffffff",
              color: "#1f1f1f",
              border: "1px solid #dadce0",
              borderRadius: 8,
              padding: "10px 16px",
              fontWeight: 500,
              boxShadow: "0 1px 2px rgba(0,0,0,0.08)",
            }}
          >
            <svg width="18" height="18" viewBox="0 0 48 48" aria-hidden="true">
              <path fill="#FFC107" d="M43.6 20.1H42V20H24v8h11.3C33.7 32.7 29.2 36 24 36c-6.6 0-12-5.4-12-12s5.4-12 12-12c3.1 0 5.9 1.2 8 3l5.7-5.7C34.2 6.1 29.3 4 24 4 13 4 4 13 4 24s9 20 20 20 20-9 20-20c0-1.3-.1-2.6-.4-3.9z"/>
              <path fill="#FF3D00" d="M6.3 14.7l6.6 4.8C14.7 15.1 19 12 24 12c3.1 0 5.9 1.2 8 3l5.7-5.7C34.2 6.1 29.3 4 24 4 16.3 4 9.7 8.3 6.3 14.7z"/>
              <path fill="#4CAF50" d="M24 44c5.2 0 9.9-2 13.4-5.2l-6.2-5.2C29.2 35.1 26.7 36 24 36c-5.2 0-9.6-3.3-11.3-8l-6.5 5C9.5 39.6 16.2 44 24 44z"/>
              <path fill="#1976D2" d="M43.6 20.1H42V20H24v8h11.3c-.8 2.3-2.3 4.3-4.1 5.7l6.2 5.2C36.9 39.2 44 34 44 24c0-1.3-.1-2.6-.4-3.9z"/>
            </svg>
            Continue with Google
          </a>
          <div className="flex items-center gap-3 my-4" aria-hidden="true">
            <div className="h-px flex-1" style={{ background: "var(--border, #e5e7eb)" }} />
            <span className="text-xs" style={{ color: "var(--muted)" }}>or</span>
            <div className="h-px flex-1" style={{ background: "var(--border, #e5e7eb)" }} />
          </div>
        </>
      )}

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
          <p className="text-sm font-medium" style={{ color: "var(--danger)" }} role="alert" data-testid="login-error">
            {error}
          </p>
        )}
        <button type="submit" className="cc-btn cc-btn-primary w-full" disabled={busy}>
          {busy ? "Signing in…" : "Sign in"}
        </button>
      </form>
    </div>
  );
}

export default function LoginPage() {
  return (
    <main className="min-h-screen flex items-center justify-center p-6" style={{ background: "var(--shell)" }}>
      <Suspense fallback={<div className="w-full max-w-sm" />}>
        <LoginInner />
      </Suspense>
    </main>
  );
}
