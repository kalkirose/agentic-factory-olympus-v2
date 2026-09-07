# ADR-004: Admin authentication — Cloudflare Access SSO + Medusa native emailpass

**Status:** Accepted
**Date:** 2026-05-15
**Deciders:** Kalki, Claude
**Category:** Auth & Security (Step 4 Category 2)
**Related:** NFR24 (zero-trust admin proxy + 2FA), memory rule "Admin is English-only", Step 3 Medusa-first principle, `architecture.md` § Step 4 Category 2 (archived 2026-07-18; current planning canon: `cremerius-project/specs/`)

## Context

Medusa Admin is the operational surface for Felix (CEO, business + sales) and Jenny (Distribution Lead, customer support + logistics). Launch has exactly two daily users. NFR24 requires admin to sit behind a zero-trust proxy with 2FA. Earlier UX guidance suggested passwordless magic link, but the user explicitly opted out of magic-link login for admins during Step 4 Category 2 work — partner preference is for OAuth-driven SSO over magic-link UX.

Key constraints:

- **NFR24** — zero-trust proxy + 2FA
- **Memory rule "Admin is English-only"** — admin surfaces don't need to localize
- **Medusa-first principle** — try Gates 1→4 in order before custom code
- **2 daily users** — admin auth is a high-frequency interaction for a tiny audience; UX matters per-login
- **Cloudflare is in front** (Step 3 + Category 5 working assumption) — already provides edge / WAF; Cloudflare Access is the natural zero-trust layer

The key architectural insight that made this decision easy: **admin auth is actually two layers stacked**, not one. The "passwordless magic link" UX requirement and the "session identity for audit" requirement live in different places. Once seen this way, the design collapses into the most native components on each side.

## Decision

**Cloudflare Access with Google Workspace SSO (or GitHub OAuth) as the identity gate, plus Medusa's native `emailpass` provider for in-Medusa session + audit identity.** No custom Medusa auth provider; no magic-link infrastructure for admin login.

## Why this is the right call

**Two-layer architecture matches what NFR24 actually demands:**

```
Internet
   │
   ▼
┌──────────────────────────────────────────────────┐
│ Cloudflare Access (zero-trust proxy)             │
│  - Google Workspace SSO (identity + 2FA via      │
│    Google's own TOTP/passkey on the Workspace    │
│    account)                                       │
│  - Optional IP allowlist                         │
│  - Identity propagated as signed JWT header      │
└──────────────────────────────────────────────────┘
   │ (admin-allowlisted users only)
   ▼
┌──────────────────────────────────────────────────┐
│ Medusa Admin (emailpass — Medusa-first Gate 1)   │
│  - Session identity for audit trail              │
│  - Per-user RBAC (Medusa native)                 │
│  - Who-changed-what attribution                  │
└──────────────────────────────────────────────────┘
```

Cloudflare Access provides the high-stakes gate (identity + 2FA). Medusa provides the session and the audit log. Each component does exactly what it's good at; neither does work the other should do.

**One-click sign-in for daily-use admins.** Felix and Jenny click "Sign in with Google" once at the start of a session. Google's TOTP/passkey authenticates them transparently (already configured on their Workspace accounts). Cloudflare propagates identity. Medusa's session establishes via stored emailpass credentials. Day-to-day: no codes, no magic-link emails, no friction.

**Medusa stays Gate 1.** The Medusa Auth Module's default `emailpass` provider is unchanged. No custom auth provider, no community plugin, no maintenance burden — every Medusa version upgrade carries the auth surface forward automatically. This is the cheapest possible posture and matches the Medusa-first principle exactly.

**2FA comes from Google Workspace — but only if enforced.** SSO through Cloudflare Access does not itself prove a second factor: a Workspace account *without* 2-Step Verification would sail through the gate on password alone. NFR24's 2FA holds only when the Workspace org policy **enforces** 2-Step Verification (not merely allows it) for the admin accounts, with Cloudflare Access "require MFA" set independently as belt. Both settings are explicit items in the phase-0 provisioning guides (`cremerius-project/phase-0/cre-59-google-workspace.md`, `cre-62-cloudflare.md`). With that in place, we get NFR24 compliance without engineering anything ourselves. *(amended 2026-07-04)*

**Audit identity flows correctly.** Cloudflare propagates the authenticated email; Medusa's session stores the matching user record. "Felix changed order #123 status" attributes correctly in Medusa's order audit log — necessary for partner accountability and incident response.

**Cost: zero new lines for what NFR24 mandates.** Cloudflare Access free tier covers up to 50 users (we have 2). Google Workspace is already paid (assumed for the partner team's email).

## How it works

**Cloudflare Access configuration:**

| Setting | Value |
|---|---|
| Application | `admin.cremeriusequestrian.com` (and any admin subpath) |
| Identity providers | Google Workspace (primary); GitHub OAuth (backup) |
| Session duration | 24h (longer than Medusa's 8h; Cloudflare carries long-haul identity) |
| Optional: IP allowlist | Office IPs + partners' home IPs (configurable in Cloudflare dashboard) |
| Service tokens | None at launch (no machine-to-machine admin access) |
| MFA enforcement *(amended 2026-07-04)* | Workspace org policy: 2-Step Verification **enforced** for admin accounts + Cloudflare Access policy: require MFA. The Access require-MFA check reads the IdP's `amr` claim, so it is only as strong as what the IdP reports — it holds with Workspace SSO because 2SV is enforced there; Access's own email-OTP login carries no MFA claim and never satisfies it. Phase-0 provisioning guides (cre-59, cre-62) |

When a request hits `admin.cremeriusequestrian.com`, Cloudflare verifies the Access JWT cookie. If absent or expired, redirects to Google Workspace SSO. After auth, Cloudflare injects `Cf-Access-Authenticated-User-Email` header into the request before it reaches Medusa.

**Medusa configuration:**

- Auth Module ships with `emailpass` as default — no config change required
- Admin users provisioned at deploy time via `medusa user --create`:
  ```bash
  medusa user --create --email felix@cremeriusequestrian.com --password <strong-generated>
  medusa user --create --email jenny@cremeriusequestrian.com --password <strong-generated>
  ```
- Strong-password policy enforced at provisioning (16+ chars, generated via passwordstore on partner machines)
- Medusa session cookie attributes per ADR-006

**Two-cookie reality at first login:**

1. Cloudflare Access JWT cookie (`CF_Authorization`) — 24h
2. Medusa session cookie (`__Host-medusa_admin_sess`) — 8h fixed, `rolling: false` (D5, ADR-006)

After first login, both cookies persist; subsequent visits are silent until either expires. Net UX: occasional re-auth on Cloudflare (every 24h), more frequent on Medusa (every 8h), neither requires interactive credentials when Workspace SSO is current.

**Admin user provisioning runbook:**

- Documented in `docs/adr/adr-004-admin-auth.md` (this file) and replicated as a Medusa runbook
- New admin: add email to Cloudflare Access policy + `medusa user --create` with generated password + share via passwordstore
- Removal: remove from Cloudflare Access policy + `medusa user --delete`

## Trade-offs accepted

- **Cloudflare service dependency.** If Cloudflare Access has an outage, admins can't log in. Mitigated by Cloudflare's strong reliability record; further mitigated by the fallback path which removes the SSO dependency.
- **Two cookies on first login.** Slightly higher first-login latency than a single-cookie model. Subsequent visits are silent; acceptable for 2 daily users.
- **Medusa password still exists.** It's effectively a low-stakes second factor behind the Cloudflare gate. Mitigated by strong-password generation at provisioning; the Medusa password is never typed by a human after initial setup (browser stored).
- **Google Workspace lock-in.** If we move off Workspace, Cloudflare Access identity-provider configuration changes. Low-cost adjustment; documented in fallback.

## Alternatives (one line each)

- **Passwordless magic link in Medusa (custom auth provider, Gate 4)** — adds maintenance burden for a UX win we don't need; user explicitly preferred OAuth-driven SSO.
- **Email + password only, no zero-trust gate** — fails NFR24 (no 2FA + zero-trust requirement).
- **GitHub OAuth instead of Workspace SSO** — equivalent capability; Workspace is preferred because the team already uses it for email.
- **Medusa native TOTP 2FA without Cloudflare gate** — satisfies the 2FA half of NFR24 but not the zero-trust-proxy half.
- **Custom passkey-only login** — over-engineering for 2 users; Cloudflare Access already exposes passkey via Workspace.

## Fallback path

If Cloudflare Access SSO proves problematic, switch to **Cloudflare Access with email-OTP login + Medusa native emailpass with mandatory TOTP 2FA enabled in Medusa**. Email-OTP is single-factor on its own (no `amr` MFA claim); the Medusa TOTP supplies the second factor in this configuration.

**Switch triggers (any one of):**
1. Cloudflare Access pricing or availability changes that break the cost/access model
2. Admin team grows beyond what Workspace SSO licenses cover (>50 users on free tier, currently a non-issue)
3. Workspace ↔ Cloudflare Access integration breaks for an extended period
4. Cloudflare outages exceed acceptable thresholds

**What we lose on reversal:** one-click sign-in UX. Admins enter email + receive OTP email + click + TOTP code in Medusa each login.

**Reversal cost:** small. Reconfigure Cloudflare Access identity provider to email-OTP; enable Medusa Auth Module TOTP provider; communicate the change to Felix and Jenny; document new login flow in runbook.

## References

- `architecture.md` § Step 4 Category 2 (decision summary; archived 2026-07-18 — current planning canon: `cremerius-project/specs/`)
- PRD NFR24 (zero-trust admin proxy + 2FA)
- Memory: "Admin is English-only"
- ADR-006 (session cookies — Medusa admin session attributes)
- [Cloudflare Access docs](https://developers.cloudflare.com/cloudflare-one/policies/access/)
- [Medusa Auth Module — emailpass](https://docs.medusajs.com/resources/commerce-modules/auth/auth-providers/emailpass)

## Tech re-validation amendment (2026-06-12)

The pre-[C] technology re-validation (`tech-revalidation-report-2026-06-12.md`) tested whether Google Workspace could be dropped as IdP: Cloudflare Access remains free to 50 users and its built-in **One-Time PIN (email OTP)** login needs no external IdP, a potential ~€18/mo saving for 3 Workspace seats. Verified caveat: OTP is possession-of-mailbox single-factor, so "MFA-protected admin" (NFR24) would need a second factor layered — Cloudflare Independent MFA or Medusa's native admin MFA (source-verified at 2.15.5: the auth module ships TOTP + recovery-code providers, `/auth/mfa/*` core routes, and dashboard UI).

**Decision (user, 2026-06-12): Workspace stays.** The team already runs Google Workspace for email on the production domain (`felix@`/`jenny@cremeriusequestrian.com` are active), so the seat cost is not attributable to auth and the saving is not real. The decision above is unchanged.

**Fallback path strengthened by the same evidence:** the email-OTP fallback is verified current (2026-06-12), and "Medusa Auth Module TOTP provider" in the reversal steps can now read **Medusa native admin MFA** — source-verified in 2.15.5 (TOTP + recovery-code auth providers, `/auth/mfa/*` core routes, dashboard UI; verification pass 2026-07-19), a Gate 1 capability that didn't exist when this ADR was written.

## Amendment (2026-07-04) — pre-development review

Finding I-7 (`architecture-review-2026-07-04.html`). The ADR implied 2FA "falls out of" Workspace SSO, but SSO alone does not prove a second factor — an un-enrolled Workspace account passes Cloudflare Access on password only. Body text fixed in place where marked:

- NFR24's 2FA claim now made conditional and explicit: Workspace org policy must **enforce** 2-Step Verification for the admin accounts, and the Cloudflare Access policy sets require-MFA independently as belt.
- Both settings added as a row in the Cloudflare Access configuration table and written into the phase-0 provisioning guides (cre-59, cre-62).

Decision unchanged: Cloudflare Access + Workspace SSO + Medusa emailpass remains the architecture.
