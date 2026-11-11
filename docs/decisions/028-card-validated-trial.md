# 028: A validated card before any use; 7-day trial; no Free plan

Supersedes the plan list in [013](013-billing-stripe.md). Amends [016](016-scan-funnel.md) (the
scan funnel also needs a card).

Date: 2026-11-10

## Context

Decision 013 planned three plans: Free, Builder and Agency. Erik decided on 2026-11-10 that every
use of the hosted product needs a credit card, and that the card must be **validated with the
issuer**, not only entered. A card number that passes the Luhn check, or a card the issuer would
decline, must not open a workspace.

## Decision

1. **No Free plan.** Two plans: Builder at $29 per watched project per month, and Agency at $19
   per watched project per month with a 10-project minimum. Builder bills at least 1 project, so a
   workspace with no projects still pays $29 after the trial.
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
   the default payment method, and the tenant ID in the metadata. Stripe charges on day 8 unless
   the customer cancels. A missing payment method at the trial end cancels the subscription.
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

## Consequences

- The marketing site and the Terms drop the Free plan and the free posture scan, and describe the
  hold, the trial and cancellation (repo FlywheelStudio/supahound-site; legal review in #81).
- Test-mode keys let anyone in with Stripe's test cards. The requirement holds only after the live
  cutover, which needs Erik's approval (CLAUDE.md).
- A card fingerprint can open one trial per workspace, not one per person. Checking a fingerprint
  across tenants would cross tenant data (decision 007), so this decision does not.
