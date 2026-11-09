# Testing

Updated 2026-11-09. CI runs every tier below on each pull request
([`.github/workflows/ci.yml`](../.github/workflows/ci.yml)). A PR merges only when CI is green.

## Tiers

| Tier | What it proves | Where | Command | Count |
| --- | --- | --- | --- | --- |
| Unit | Pure logic: detectors, parser, ownership, engine, explainer, vault, OAuth, web helpers | `packages/core/test/*.test.ts`, `apps/web/test/` | `pnpm -r test` | 229 core (unit + Postgres), 25 web |
| Postgres | RLS, isolation, repositories, the poller end to end | `packages/core/test/db/` | `pnpm -r test` | within the 229 |
| workerd | Core runs inside the Workers runtime (vault, detectors, AI SDK with ZDR) | `apps/poller/test/` | `pnpm -r test` | 6 |
| UAT, detection | PRD outcomes over the full poll pipeline | `packages/core/test/uat/` | `pnpm -r test` | 6 |
| E2E, signed out | The built web Worker: redirects, CSRF, cache headers, hook signature | `apps/web/e2e/specs/public.spec.ts` | `pnpm e2e` | 10 |
| UAT, web journey | Sign-in → workspace → connect → incident, in a real browser | `apps/web/e2e/specs/journey.uat.spec.ts` | `pnpm e2e` | 10 |

`pnpm -r test` and `pnpm e2e` stay separate. E2E needs a build and a browser.

### Postgres

The database suites start a throwaway Postgres 17 cluster and apply every migration in
`supabase/migrations/` in order. They log in as roles that are not superusers and own nothing, so
forced RLS applies as in production. `initdb` comes from `SUPAHOUND_PG_BIN`, then
`/opt/homebrew/opt/postgresql@17/bin`, then `/usr/lib/postgresql/17/bin`.

`SUPAHOUND_SKIP_DB_TESTS=1` skips them on a machine with no Postgres. CI never sets it, and the CI job
fails if any suite reports skipped tests.

### E2E stack

`pnpm e2e` runs `vite build`, then Playwright. The global setup (`apps/web/e2e/support/globalSetup.ts`) starts:

1. **Postgres 17 on TCP.** The Worker reaches it through the local Hyperdrive binding
   (`CLOUDFLARE_HYPERDRIVE_LOCAL_CONNECTION_STRING_HYPERDRIVE_APP`).
2. **A fake Supabase Auth** (`support/fakeAuth.ts`). It issues ES256 tokens, and `getClaims()` verifies
   them against its JWKS endpoint, as with Supabase's asymmetric keys. On `/otp` it calls our Send
   Email Hook with a real Standard Webhooks signature and records the HTTP status.
3. **The built Worker** under `wrangler dev`, with test-only secrets in a temp env file.

Nothing calls a real Supabase, Stripe or model API. UAT-W5 stops the browser at
`api.supabase.com` with a route stub. UAT-W8 runs core's real `pollProject` against synthetic
rollup rows, with the template explainer in place of the model.

First run on a new machine: `pnpm --filter @supahound/web exec playwright install chromium-headless-shell`.
Set `E2E_DEBUG=1` to print the wrangler output.

## Rules

- Every feature ships with tests. Each acceptance criterion in its issue maps to a test or to a
  manual UAT row below.
- **Prove a new check can fail.** Break the code it guards, see the test fail, then restore the
  code. Record the mutation in the PR or the WIP doc. A check that passes on the first run proves
  nothing until it has failed once.
- Synthetic data only. Never commit real log rows, user IDs, IPs or emails.
- Mock external services in unit tests. Use test-mode keys only, never live mode.

## UAT catalogue

Scenario IDs are stable. Add new ones at the end. Use the "UAT scenario" issue template.

### Detection (automated, `packages/core/test/uat/detection.uat.test.ts`)

| ID | Scenario |
| --- | --- |
| UAT-D1 | A user who reads another user's rows raises one critical incident and one page |
| UAT-D2 | The service key used from a browser on a home network raises a critical incident |
| UAT-D3 | Normal app and server traffic raises nothing, and the project reads as assessed |
| UAT-D4 | The same attack minutes later updates the open incident and does not page again |
| UAT-D5 | A Supabase logs outage reads as "unable to assess", never as an all-clear |
| UAT-D6 | An agency and its client watching one Supabase project each see only their own incidents |

### Web journey (automated, `apps/web/e2e/specs/journey.uat.spec.ts`)

| ID | Scenario |
| --- | --- |
| UAT-W1 | A new user signs in with a magic link and lands on onboarding; the signed hook returns 200 |
| UAT-W2 | A sign-in link works once |
| UAT-W3 | A signed-in user who opens /login goes straight to the app |
| UAT-W4 | A new user creates a workspace and sees the setup checklist; a second visit creates no second workspace |
| UAT-W5 | Connect Supabase goes to Supabase consent with PKCE S256 and a hashed, bound, short-lived state |
| UAT-W6 | A callback with a forged state connects nothing |
| UAT-W7 | Another user gets the same 404 for my workspace as for a missing one |
| UAT-W8 | The owner sees a critical incident after the poller catches a scrape; no raw IDs or user agents on the page |
| UAT-W9 | Signing out ends the session |
| UAT-W10 | The magic-link form gives the same answer for a known and an unknown address |

### Manual (needs a live service)

| ID | Scenario | Needs | Issue |
| --- | --- | --- | --- |
| UAT-M1 | A real magic-link email arrives from Cloudflare Email Service, and the link works once | Supahound's Supabase project, email domain | #21 |
| UAT-M2 | Connect Supabase completes the real consent and stores a sealed token | Registered OAuth app | #4 |
| UAT-M3 | The poller reads a live project's edge logs and records an `ok` run | Live token with `analytics:read` | #3 |
| UAT-M4 | One explainer call routes with ZDR on both models | AI Gateway Pro key | #6 |

## Mutation checks on record

| Check | Mutation | Result |
| --- | --- | --- |
| `getClaims()` verifies the signature | Fake Auth signs with a key that is not in its JWKS | UAT-W1 fails |
| Hook checks its signature | Fake Auth signs the hook with the wrong secret | UAT-W1 fails (401) |
| No shared caching of signed-in pages | Middleware stops setting `private, no-store` | 3 E2E checks fail |
| No second page for a repeat | Engine pages on every update at high or above | UAT-D4 fails |

Older mutation checks (RLS, vault, OAuth, ZDR guard, windows) are listed in each WIP doc's build log.
