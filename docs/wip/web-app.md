# WIP: Web app (auth, onboarding, dashboard)

Goal: a clear path from email to a watched project: sign in → workspace → connect Supabase →
choose projects → plan → alerts. Decisions 009, 010, 012, 013, 014.

## Status — 2026-10-27

- Built: `apps/web` (Next.js App Router on Workers, vinext 1.3.1, Wrangler config). Magic-link
  sign-in, `/auth/confirm`, sign-out, the signed Send Email Hook route, onboarding step 1 (create
  workspace), workspace overview (projects, open incidents, setup checklist).
- **Next step:** Supabase OAuth connect (`/api/supabase/connect` and callback) with state bound
  to user + tenant, PKCE, sealed tokens and locked refresh. Then the project picker, Stripe, and
  alert email.
- Not verified end to end: the real magic-link round trip and the database-backed pages. Both
  need Guardbase's Supabase project and a Hyperdrive config.

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

1. Supabase (Guardbase project): Auth → Hooks → Send Email Hook → HTTPS,
   `https://<app>/api/auth/send-email-hook`. Copy the secret to
   `wrangler secret put SEND_EMAIL_HOOK_SECRET`.
2. Auth → URL configuration: site URL = `APP_URL`; add `<APP_URL>/auth/confirm` to redirect URLs.
3. Cloudflare: `wrangler email sending enable <domain>`; set `EMAIL_FROM_ADDRESS` on that domain.
4. Hyperdrive: `wrangler hyperdrive create guardbase-app --caching-disabled --connection-string ...`
   (Supabase direct or session connection, `guardbase_app` login role). Put the ID in both
   `wrangler.jsonc` files.

## Verification log

- Unit tests (16): hook signature (valid, wrong secret, tampered body, missing headers, replay
  outside the timestamp window), unsupported types, send failure, HTML escaping, origin check,
  `safeNext`, onboarding order. Mutation checks: skipped signature, prefix origin match and open
  redirect each fail the suite.
- Ran the built Worker locally (`wrangler dev`): `/` and `/login` 200; `/app`, `/onboarding`,
  `/w/x` 307 → `/login` with `private, no-store`; cross-origin POST 403; unsigned hook 401; bad
  confirm link → `/login?error=link`.

## Gotchas

- vinext's `cf` CLI (beta) needs Node ≥ 24.22; this machine has 24.19. We use the Wrangler setup
  (`--legacy-wrangler-cloudflare-init`), which matches the poller.
- shadcn/ui not added yet; plain Tailwind for now.
- Not yet: Turnstile on the sign-in form (Supabase rate-limits sends per address and project).
