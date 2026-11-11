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
- 2026-11-10, later: Erik replaced the plans: no Agency; per project $19.99 (Starter) up to 1M
  edge-log requests in 30 days, $99 (Pro, SMS coming soon) above, Enterprise above 10M (stays on Pro,
  we contact them). Thresholds from real traffic in Flywheel's own Supabase projects (counts only,
  via `supabase logs --remote`): most under 400k/month, the busiest production app about 3.4M.
  Tier moves take effect at the next renewal (no proration); adding a project is prorated.
- The rollup cannot measure usage (it filters traffic and stops at 5,000 templates), so the poller
  counts each project's requests once a day (00:20 UTC, previous UTC day; the logs API caps a
  query at 24 hours and free Supabase projects keep 1 day of logs).
- Wrangler passes only declared secrets to a Worker, and a deploy fails when a required secret is
  missing. So the public template leaves the Stripe secrets undeclared (self-hosters need none),
  E2E declares them in a copy of the built config, and Flywheel's private config requires them.
- Stripe SDK 23.0.1 (API 2026-09-30.endive) has no `payment_method_types` on Checkout; it is
  `allowed_payment_method_types`. A non-card payment method fails the check (fail closed).
- The middleware's same-origin check blocked the Stripe webhook (403): it is now in `SIGNED_ROUTES`.
- 2026-11-11: Erik: staff workspaces must not pay, but a customer workspace must still pay when
  staff join it. Decision 029, issue #94: exempt while the sole owner's verified email is on
  `SUPAHOUND_BILLING_EXEMPT_DOMAINS`; migration `20261111010000_billing_exempt.sql` adds
  `exempt_owner`/`exempt_at` and a membership trigger that clears them when the owners change.
  The one staff subscription that existed before this gets a 100%-off coupon in Stripe (Erik, by
  hand), so its trial end charges nothing.

## Next

1. Merge PR #88 (hook fix), then this branch, into `develop`, then release to `main`.
2. Erik runs `scripts/stripe-setup.sh` in the private deploy repo with a test key, then tests.
3. Live cutover: the same script with a live key, after Erik approves (CLAUDE.md).
4. SMS alerts: an issue and a provider decision before Pro's "coming soon" can flip.
5. Staff exemption (#94): apply the migration to production, set the domain list in the private
   deploy config, deploy (each needs Erik's approval). Then the staff owner opens the billing page
   once and cancels the old Stripe subscription.
