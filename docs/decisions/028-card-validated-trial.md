# 028: A validated card before any use; 7-day trial; per-project pricing by traffic

Supersedes the plan list in [013](013-billing-stripe.md). Amends [016](016-scan-funnel.md) (the
scan funnel also needs a card).

Date: 2026-11-10

## Context

Decision 013 planned three plans: Free, Builder and Agency. Erik decided on 2026-11-10 that every
use of the hosted product needs a credit card, and that the card must be **validated with the
issuer**, not only entered. A card number that passes the Luhn check, or a card the issuer would
decline, must not open a workspace.

## Decision

1. **No Free plan, no Agency plan. Per-project pricing by traffic.** Each watched project bills at
   its own tier, from its edge-log requests in the last 30 days:
   - **Starter**, $19.99 per project per month: up to 1 million requests.
   - **Pro**, $99 per project per month: above 1 million. Includes SMS alerts (coming soon).
   - **Enterprise**: above 10 million. The project stays on Pro, the app says we will make
     contact, and nothing above $99 is charged automatically.
   A workspace pays for at least one Starter project, so a workspace with no projects pays $19.99
   after the trial. Erik set the thresholds on 2026-11-10 from real traffic: of the projects in
   Flywheel's own Supabase account, most send under 400,000 requests a month; the busiest
   production app sends about 3.4 million.
2. **7-day trial with a validated card.** A new workspace can do nothing until an owner or admin
   adds a card: no dashboard, no Connect Supabase, no project picker, no polling. The workspace
   itself exists, so billing has a tenant to attach to.
3. **How the card is validated.** Stripe Checkout in `payment` mode takes a **$1 authorization**
   (`capture_method: manual`) and saves the card (`setup_future_usage: off_session`). 3-D Secure runs
   on Stripe's page when the issuer asks for it. The card is valid when all of these hold:
   - the issuer approved the hold (the PaymentIntent is `requires_capture`);
   - the CVC check, read from the charge, is not `fail` (`pass`, `unavailable` and `unchecked`
     pass: many real issuers do not report the check);
   - the card's funding type is not `prepaid`.
   The server releases the hold at once, whatever the result. Nothing is ever captured.
4. **Then the subscription.** The server creates it with `trial_period_days: 7`, the saved card as
   the default payment method, the tenant ID in the metadata, and two items: the Starter price and
   the Pro price, each with a quantity (projects at that tier). Stripe charges on day 8 unless the
   customer cancels. A missing payment method at the trial end cancels the subscription.
4a. **How a project's tier changes.** At 00:20 UTC the poller counts each billed project's
   edge-log requests for the previous UTC day (one count query per project, audited). The sum of
   the last 30 days sets the tier. A tier change updates the quantities with
   `proration_behavior: none`, so it takes effect at the next monthly charge, in both directions.
   A project the customer adds or removes is billed at once, pro rata. A day whose count fails is
   missing from the sum, which can only lower it.
5. **What each status allows.** `trialing` and `active`: everything. `past_due`: everything, with
   a banner, while Stripe retries the payment. Every other status, and no subscription: the billing
   page only. The poller skips those tenants.
6. **The terms are on our page, not only Stripe's.** Payment-mode Checkout shows "$1.00", not the
   trial. Our billing page states the hold, the trial, the price after it and how to cancel, and the
   owner ticks a box that accepts the Terms. The time and terms version are stored. Checkout repeats
   the terms next to its pay button.
7. **One gate.** `withPaidTenantForUser` (packages/core) is the only tenant entry point for
   signed-in pages and actions. ESLint blocks `withTenantForUser` in the web app outside the billing
   routes.
8. **Self-hosting.** `SUPAHOUND_BILLING` must be set to `stripe` or `off`; there is no default. Off
   turns the gate and the poller's billing filter off. Flywheel's hosted deploy sets `stripe`.
9. **The scan funnel (hackme.si) also needs a validated card.** It shares the account and the gate
   (decision 016). The funnel's web part is not built yet; this decision binds it when it is.

## Alternatives considered

- **Subscription Checkout with a trial.** Stripe saves the card with a SetupIntent and may run a $0
  verification, but it does not promise one, and a $0 check proves no funds. Rejected: not
  "validated" in Erik's sense.
- **A $1 charge, refunded.** Proves funds too, but shows as a charge and a refund on the
  statement, and costs fees. A hold that is released shows as pending at most.
- **Require CVC `pass`.** Strictest, but it refuses real cards whose issuer does not report CVC
  results. Erik chose "not failed".
- **Builder and Agency per project, with no usage tiers** (the first draft of this decision).
  Replaced the same day: Erik wanted one entry price and tiers that follow traffic.
- **One tier for the whole workspace, from its total traffic.** Rejected: a single busy project
  would move every small project to $99.
- **Change tiers at once, pro rata.** Rejected: a customer could get a charge mid-month without
  doing anything.

## Consequences

- The marketing site and the Terms drop the Free plan, the Agency plan and the free posture scan,
  and describe the hold, the trial, the tiers and cancellation (repo FlywheelStudio/supahound-site;
  legal review in #81).
- SMS alerts are promised as "coming soon" for Pro; they need their own issue and a decision on the
  SMS provider (CLAUDE.md: no new service without asking).
- Test-mode keys let anyone in with Stripe's test cards. The requirement holds only after the live
  cutover, which needs Erik's approval (CLAUDE.md).
- A card fingerprint can open one trial per workspace, not one per person. Checking a fingerprint
  across tenants would cross tenant data (decision 007), so this decision does not.
