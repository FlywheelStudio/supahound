# WIP: billing with a validated card (#25)

Decision [028](../decisions/028-card-validated-trial.md). Branch `feature/billing`, cut from
`fix/hook-json-response` (PR #88, not merged when this started).

## Goal

No use of the hosted app without a card the issuer has approved. A 7-day trial, then Builder or
Agency per watched project.

## Approach

- `supabase/migrations/20261111000000_billing.sql`: `billing_accounts` (one row per tenant) and
  `stripe_events` (processed event IDs per tenant). Forced RLS. The scheduler reads
  `billing_accounts (tenant_id, status)` only.
- `packages/core/src/billing/`: plan and access rules, the card check, seat counts (pure); the
  flow (checkout, verification, subscription refresh, seat sync) behind a small Stripe interface,
  so the tests use fakes.
- `packages/core/src/db/billing.ts`: the repository and `withPaidTenantForUser`.
- `apps/web`: the Stripe client (`stripe` 23.0.1, fetch HTTP client, SubtleCrypto webhooks), the
  billing page, the Checkout return route, the webhook route, the Billing Portal, and the gate on
  every `/w/*` page and action and on the OAuth callback.
- `apps/poller`: `dueProjects` skips tenants that have not paid.
- E2E: a fake Stripe (like the fake Auth). Specs that are not about billing seed a paid state.

## Files expected to change

Migration, `packages/core/src/{billing,db}`, `apps/web/app/w/[tenantId]/**`,
`apps/web/app/api/{stripe,supabase}/**`, `apps/web/lib/`, `eslint.config.js`, both
`wrangler.jsonc`, `apps/web/e2e/**`, docs.

## Open questions

- None blocking. Live-mode products, prices and webhook need Erik's approval.

## Build log

- 2026-11-10: Erik's answers: card before any use; 7-day trial; Builder $29 / Agency $19 (min 10);
  Builder minimum 1 project; CVC "not failed"; refuse prepaid; new Stripe account for Supahound;
  Hack-me also needs a card.
