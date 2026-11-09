# 020 — E2E tests run the real Worker against a fake Supabase Auth

Date: 2026-11-09. Status: accepted (Erik).

## Context

The web app's signed-in pages need Supabase Auth and Postgres. Supahound's own Supabase project does
not exist yet. Docker is not available, so `supabase start` cannot run. The magic-link round trip
was verified only by hand.

## Decision

- Playwright drives the **built** web Worker under `wrangler dev`. It is the same bundle that deploys.
- Postgres 17 runs as a throwaway cluster on TCP, with every migration applied. The Worker reaches it
  through the local Hyperdrive binding as a non-superuser role, so forced RLS applies.
- A small **fake Supabase Auth** (`apps/web/e2e/support/fakeAuth.ts`) serves only what the app calls:
  `/otp`, `/verify`, `/token`, `/logout` and the JWKS. Tokens are ES256, and `getClaims()` verifies them
  against the JWKS, as with Supabase's asymmetric keys. `/otp` calls our Send Email Hook with a real
  Standard Webhooks signature.
- Detection UAT runs in Vitest over `pollProject` with Postgres, not in the browser.
- Live-only checks (real email, real OAuth consent, live logs, live gateway) are manual UAT rows in
  `docs/TESTING.md`, each linked to an issue.

## Alternatives considered

- A Supabase test project in CI. Rejected for now: it is a new hosted dependency, and it does not exist yet.
- Only signed-out E2E checks. Rejected: the onboarding and isolation journeys would stay untested.
- Mock `getClaims()` in the app. Rejected: it would skip the signature check that keeps users honest.

## Consequences

- The fake must track the Supabase Auth API as the app uses more of it. A drift shows up as an E2E failure.
- Mutation checks prove that a wrong JWT key and a wrong hook secret each fail the suite.
