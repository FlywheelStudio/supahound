# WIP: Web app (auth, onboarding, dashboard)

Goal: a clear path from email to a watched project: sign in → workspace → connect Supabase →
choose projects → plan → alerts. Decisions 009, 010, 012, 013, 014.

## Status — 2026-10-27

- Built: `apps/web` (Next.js App Router on Workers, vinext 1.3.1, Wrangler config). Magic-link
  sign-in, `/auth/confirm`, sign-out, the signed Send Email Hook route, onboarding step 1 (create
  workspace), workspace overview (projects, open incidents, setup checklist).
- Built: Supabase OAuth connect. "Connect Supabase" (owners and admins) → Supabase consent →
  `/api/supabase/callback` → sealed credentials on a new connection. The poller refreshes tokens
  under the connection's row lock.
- Built: the project picker (#9, [features/project-picker.md](../features/project-picker.md)).
- Built: ownership refresh (#10): the poller loads `pg_policies` on a project's first poll; the
  overview shows detector 2 coverage ([feature doc](../features/ownership-refresh.md)).
- **Next step:** Stripe (#25), then alert email (#16).
- Not verified end to end: the real magic-link round trip and the database-backed pages. Both
  need Supahound's Supabase project and a Hyperdrive config.

## How it works

- `lib/supabase.ts`: the server client; users come only from `getClaims()` (verifies the JWT).
- `lib/db.ts`: one pool per request through Hyperdrive (app role). Tenant pages use
  `withTenantForUser`; a non-member gets a 404, same as a missing workspace.
- `middleware.ts`: rejects cross-origin non-GET requests (CSRF), refreshes the session, and sets
  `Cache-Control: private, no-store` on signed-in paths. The signed hook route is exempt from
  the origin check only.
- Send Email Hook (`lib/email/hook.ts`): verifies the Standard Webhooks signature, accepts only
  `magiclink`, `signup` and `email`, builds the link to OUR `/auth/confirm` (ignores
  `redirect_to`), sends through `env.EMAIL` (Cloudflare Email Service), returns an empty 200.
- Scaffolded with `--data-cache none --cdn-cache none --no-prerender`: no shared caching of pages.

## Setup (Erik)

0. Register the Supabase OAuth app (PRD "This week" task) with scopes `analytics:read`,
   `database:read` and `projects:read` (the project picker lists projects), redirect URI `<APP_URL>/api/supabase/callback`. Put the client ID in both
   `wrangler.jsonc` files and `wrangler secret put SUPABASE_OAUTH_CLIENT_SECRET` in both Workers.

1. Supabase (Supahound project): Auth → Hooks → Send Email Hook → HTTPS,
   `https://<app>/api/auth/send-email-hook`. Copy the secret to
   `wrangler secret put SEND_EMAIL_HOOK_SECRET`.
2. Auth → URL configuration: site URL = `APP_URL`; add `<APP_URL>/auth/confirm` to redirect URLs.
3. Cloudflare: `wrangler email sending enable <domain>`; set `EMAIL_FROM_ADDRESS` on that domain.
4. Supabase → Settings → JWT keys: use asymmetric signing keys, so `getClaims()` verifies locally
   instead of calling the Auth server on every request (the middleware runs it on every route).
5. Supabase → Settings → API → Exposed schemas: `supahound` must NOT be listed. All access goes
   through the Workers with the `supahound_app` role.
6. Hyperdrive: `wrangler hyperdrive create supahound-app --caching-disabled --connection-string ...`
   (Supabase direct or session connection, `supahound_app` login role). Put the ID in both
   `wrangler.jsonc` files.

## Verification log

- Unit tests (16): hook signature (valid, wrong secret, tampered body, missing headers, replay
  outside the timestamp window), unsupported types, send failure, HTML escaping, origin check,
  `safeNext`, onboarding order. Mutation checks: skipped signature, prefix origin match and open
  redirect each fail the suite.
- Ran the built Worker locally (`wrangler dev`): `/` and `/login` 200; `/app`, `/onboarding`,
  `/w/x` 307 → `/login` with `private, no-store`; cross-origin POST 403; unsigned hook 401; bad
  confirm link → `/login?error=link`.

- OAuth callback (`lib/connect.ts`): 9 tests over no session, malformed state, missing code,
  unknown state, non-member, failed exchange and replay. Exchanging before consuming fails 3.
- OAuth: 13 core tests. PKCE S256, state parsing, authorize URL (no deprecated `scope`), Basic
  auth token exchange, refresh rotation, errors. In Postgres: state single-use; rejected for
  another user, a colleague in the same workspace, another tenant, or after expiry; two
  concurrent refreshes call Supabase once and both get the new token; a failed refresh keeps the
  stored credentials. Mutation checks: no row lock, no user binding, no single-use each fail.
- Running Worker: callback without a session → `/login`, `private, no-store`; cross-origin
  server-action POST → 403.

## Gotchas

- vinext's `cf` CLI (beta) needs Node ≥ 24.22; this machine has 24.19. We use the Wrangler setup
  (`--legacy-wrangler-cloudflare-init`), which matches the poller.
- shadcn/ui not added yet; plain Tailwind for now.
- Not yet: Turnstile on the sign-in form (Supabase rate-limits sends per address and project).
