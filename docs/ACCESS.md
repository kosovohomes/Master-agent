# Access Guide — Command Center (masteragent-nine.vercel.app)

**Owner-facing, current as of the Access & Identity Overhaul.** Three ways in,
no DB access and no curl-foo required for day-one use.

## 1. Sign in with Google (recommended once configured)

The `/login` page shows **Continue with Google** when the server has the OAuth
client configured. First sign-in with a Google account whose email matches an
existing user links that identity automatically (the password keeps working —
both methods coexist). A Google account listed in `OWNER_EMAILS` can
provision itself as the first owner when the platform has no users yet.

**One-time setup (owner, ~3 minutes):**

1. Open <https://console.cloud.google.com/apis/credentials> → **Create
   credentials → OAuth client ID → Web application**.
2. **Authorized redirect URI** — add exactly:
   `https://masteragent-nine.vercel.app/api/auth/oauth/google/callback`
3. Copy the **Client ID** and **Client secret** and hand them over (or set
   them in Vercel → Project `masteragent` → Settings → Environment
   Variables): `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`.
4. Optionally set `OWNER_EMAILS` (comma-separated Google emails allowed to
   self-provision as owner on a fresh install).

Until then the login page simply hides the Google button (fail-closed) and
email + password works.

## 2. Email + password (works today)

1. Open <https://masteragent-nine.vercel.app/login>.
2. Sign in with your owner email and password.
3. Forgot the password? → §Recovery below. Accounts lock for 15 minutes after
   5 failed attempts; that lock also clears on recovery.

## 3. Recovery (ops bearer — guaranteed path)

The Vercel environment holds `OPS_TOKEN` (and `ADMIN_PASSWORD`). Either is
accepted as `Authorization: Bearer …` by the recovery endpoint — the same
root ops trust as `/api/admin/migrate`.

```bash
# a) Which accounts exist? (no mutation)
curl -sS -X POST https://masteragent-nine.vercel.app/api/admin/recover \
  -H "Authorization: Bearer $OPS_TOKEN" -H "Content-Type: application/json" -d '{}'

# b) Rotate a password → returns a one-time initial password
curl -sS -X POST https://masteragent-nine.vercel.app/api/admin/recover \
  -H "Authorization: Bearer $OPS_TOKEN" -H "Content-Type: application/json" \
  -d '{"email":"owner@yourdomain.com"}'
```

Rotation also destroys all the user's sessions and clears lockout. The
response is the only place the new password ever appears (never stored in
plaintext, never audited). `POST /api/admin/bootstrap` remains for a
pre-first-user install.

## What changed under the hood (for the record)

- **Before:** password-only login; first owner required a curl bootstrap; no
  recovery once a user existed; no federated identity.
- **After:** OAuth 2.0 authorization-code flow with PKCE (S256), HMAC-signed
  10-minute state with httpOnly double-submit nonce binding, verified-email
  enforcement, strict identity linking (a different Google `sub` on an
  already-linked account is refused, not silently re-linked), owner
  allowlist provisioning, full audit on every leg (`auth.oauth.start`,
  `auth.oauth.callback`, `auth.recover`), rate limits on all three legs.
- Migration `053 auth_identity` adds `users.provider` / `users.provider_id`
  (unique where present). Password hashes are untouched by Google linking.

## Security notes

- Google access tokens/codes are never logged or audited; audit entries carry
  codes and emails only.
- The Google button appears only when the server-side client credentials are
  present — there is no dead-end button state.
- The start leg redirects unconfigured installs back to
  `/login?error=oauth_unconfigured` (audited), rate limited 10 / 5 min / IP.
- `OWNER_EMAILS` is exact-match and case-insensitive; a non-listed Google
  account cannot create a user, ever.

## Related env vars (Vercel project `masteragent`)

| Key | Purpose |
|-----|---------|
| `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET` | Enable Sign-in with Google |
| `OWNER_EMAILS` | Google emails that may self-provision as first owner |
| `GOOGLE_OAUTH_STATE_SECRET` | Optional; state-MAC key (defaults to a key derived from `CHANNEL_ENC_KEY`) |
| `OPS_TOKEN` | Ops bearer for migrate/seed/bootstrap/recover |
| `ADMIN_PASSWORD` | Legacy admin bearer (transition flag) |
