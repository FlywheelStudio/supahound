# 029: Staff workspaces need no card while a staff member is their only owner

Amends [028](028-card-validated-trial.md), point 2 (a new workspace can do nothing until it has a
card). Issue #94.

Date: 2026-11-11

## Context

The hosted operator's staff test and use the hosted product every day. Under decision 028, every
staff workspace needs a validated card and pays per project after a 7-day trial. Erik decided on
2026-11-11 that staff workspaces must not pay. A customer's workspace must still pay when a staff
member joins it, for example to help the customer.

## Decision

1. **The rule.** A workspace is exempt from billing while it has exactly one owner, and that owner
   was granted the exemption. The web app grants it when the sole owner signs in with a verified
   email whose domain is on the deploy's list.
2. **The list is deploy config.** `SUPAHOUND_BILLING_EXEMPT_DOMAINS` on the web Worker holds a
   comma-separated list of domains. The public template leaves it empty. The hosted deploy sets it
   in its private config (decision 027). A malformed entry makes the billing page fail with an
   error instead of being ignored, so a typo shows at the first check after a deploy.
3. **The match is exact.** The app lowercases the part after the last `@` and compares it with
   each domain. Subdomains and look-alike domains do not match. The email comes only from
   `getClaims()`. Supabase Auth signs users in with a magic link, so the user proved control of
   the mailbox.
4. **Who can get it.** Only the owner, and only while they are the only owner. An admin or member
   on a staff domain changes nothing. A customer who opens a workspace and adds staff later pays.
   A workspace that staff set up for a customer is free until ownership moves to the customer.
   From then on, it needs a card.
5. **The exemption ends on its own.** The gate checks the sole-owner rule in the same transaction
   on every request. A trigger on `memberships` also clears the stored exemption when the owners
   change. So the scheduler, which cannot read memberships, stops polling the workspace too.
6. **Where it is granted.** On the billing page, which the gate already shows to a workspace
   without a card. A new staff workspace passes through it once and lands on the overview. The
   billing page shows "Complimentary". When the workspace still has a live Stripe subscription,
   the page keeps the Billing Portal button, so the owner can cancel the subscription.
7. **No Stripe.** An exempt workspace has no Stripe customer, no Checkout, no subscription and no
   daily usage count. The app does not change an existing subscription. Staff cancel it themselves.

## Alternatives considered

- **Any member on a staff domain exempts the workspace.** Rejected: a customer could get a free
  workspace by adding one staff member.
- **Grant once at creation and never check again.** Rejected: a workspace handed to a customer
  would stay free.
- **Hard-code the domain in the public code.** Rejected: self-hosters would inherit it, and a
  change would need a release.
- **A 100%-off Stripe coupon per staff workspace.** Still needs a card and a $1 hold for every
  workspace, and someone must add the coupon by hand each time.
- **Set the status to `active` in the database.** Rejected: it hides that the workspace is exempt,
  and the billing page would offer a Billing Portal with no Stripe customer.

## Consequences

- `billing_accounts` gains `exempt_owner` and `exempt_at`. The scheduler role can read
  `exempt_at`, not `exempt_owner`.
- Removing a domain from the list does not end existing exemptions. To end one, clear
  `exempt_owner` and `exempt_at` for that tenant (an approved write to production).
- Team invites and ownership transfer (#24) need no billing code: the trigger and the gate check
  already cover owner changes.
