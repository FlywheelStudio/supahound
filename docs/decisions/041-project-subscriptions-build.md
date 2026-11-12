# 041: How one subscription per project is built, and how seat subscriptions move

Date: 2026-11-12 · Issue #99 · Builds [032](032-subscription-per-project.md); amends
[028](028-card-validated-trial.md) points 1, 4 and 4a, [029](029-staff-billing-exemption.md)
points 6 and 7, and [037](037-data-controls.md) point 1

## Context

Decision 032 bills each watched project on its own Stripe subscription. Erik approved the build
on 2026-11-12 with these calls: one Stripe customer and one validated card per workspace; one
7-day trial per workspace; a project added after the trial bills from the day it is added; tier
changes at the next renewal; removing a project cancels its subscription at the period end;
closing cancels all of them at the period end; staff-exempt workspaces create no subscription;
"paying" (037) keeps working; existing seat subscriptions move with no double charge, through an
operator CLI with a dry run. This record fixes the parts those calls leave open.

## Decision

1. **Two models side by side.** `billing_accounts.billing_model` is `workspace` (the seat
   subscription of 028) or `project`. Existing rows and rows that older code inserts default to
   `workspace`, so the code before this change works on the new schema. A card check with no live
   seat subscription moves the workspace to `project`; the conversion CLI moves the rest. A seat
   workspace keeps its seat code (`syncSeats`) until it converts; `syncSeats` never touches a
   converted workspace's seat subscription again.
2. **The card check creates no subscription.** It saves the card as the customer's default
   payment method (`invoice_settings.default_payment_method`), so every project subscription and
   every card change in the portal reach all projects. It starts the workspace trial:
   `billing_accounts.trial_end` = the check + 7 days, set once (decision 037: one trial ever).
3. **One subscription per watched project.** One item at the project's tier price, quantity 1,
   metadata `tenant_id`, `project_id`, `supabase_ref`. Prices do not change (the Starter and Pro
   monthly prices of 028). A project added while the workspace trial runs gets `trial_end` = the
   workspace trial end; after it, no trial and the first charge at once. Within the last minute of
   the trial the project bills at once (Stripe needs a future trial end).
4. **A workspace with no billed project pays nothing.** This drops 028's minimum of one Starter
   seat: there is no object to bill it on, and per-project billing (PushFire, ULink) has none.
   Open question for Erik (see the PR).
5. **Standing, not status.** In the per-project model `billing_accounts.status` holds the
   workspace's standing: the worst status among the watched projects' current subscriptions,
   `none` when there are none. The gate gives full access to `none` with a validated card,
   `grace` to `past_due` and `incomplete` (a first charge pending, 23 hours), and blocks
   `canceled`, `unpaid`, `incomplete_expired` and `paused`: one card bills every project, so one
   project's failed card means all fail. The scheduler keeps reading `status`, so it needs no change.
6. **Reconcile.** One function makes Stripe match the watched (not paused) projects: create a
   missing subscription; cancel at the period end the subscription of a removed or paused project;
   resume one whose project is back; swap the item's price with `proration_behavior: none` on a
   tier change. It runs after a pick, a removal and a disconnect, on the overview when it sees
   drift (owners and admins), after the daily usage count (the poller), and after a new card. It
   does nothing for a seat, exempt, closing or blocked workspace (a new card comes first). Creates
   use the idempotency key `project-sub-<tenant>-<project>-<n>` (n counts the project's earlier
   subscriptions); before creating, it adopts a live subscription Stripe already has for the
   project, so a lost database write never makes a second one.
7. **Removal.** *Superseded by [042](042-project-removal-grace.md): the project stays active until
   its period ends and is deleted 7 days later; the rest of this point still holds.* ~~Decision 022
   still applies: the project's history goes at once, by the user's typed choice.~~ The subscription cancels at its period end (no refund, nothing more charged),
   and its row stays as payment history: `project_subscriptions` has no DELETE grant, and the
   project's removal only clears `project_id`. Re-adding the same Supabase project (same ref)
   while that period runs takes the subscription back and resumes it, so nothing is charged twice.
8. **Paying (amends 037 point 1).** A per-project workspace pays while any of its project
   subscriptions is `active` or `past_due`, a removed project's included until its period ends,
   or while it is exempt. `payingAccount` takes the project statuses as a required field.
9. **Closing and reopening (037 point 3).** Closing cancels every live project subscription at
   its period end; the workspace works until the latest one ends (or the trial end, if later).
   Reopening resumes the subscriptions of projects still watched, never a removed project's.
10. **Webhooks.** Events are routed by subscription: one with `metadata.project_id` updates its
    `project_subscriptions` row and the standing; a seat subscription of a converted workspace
    only runs out its period, and its events change nothing. Signature check and per-tenant event
    IDs as before (013, 028).
11. **Plan & billing.** The project page shows the plan, the subscription status, the next
    charge (or the end, or the first charge after the trial) and the project's invoices
    (`invoices.list` by subscription). Workspace owners and admins open the Billing Portal (it
    covers the whole customer). A project's Owners and Admins also see its invoices; Editors and
    Viewers see the plan and status. The workspace billing page lists every project's
    subscription, removed projects still running out their period, and the monthly total.

### Conversion of seat subscriptions (`pnpm convert-subscriptions`)

- **Reads:** workspaces from `billing_accounts` (scheduler login), each workspace through
  `withTenant` (app login), and the seat subscription live from Stripe, never from the database.
- **Skips, with the reason printed:** an exempt workspace; a workspace whose sole owner's
  recorded email is on `SUPAHOUND_BILLING_EXEMPT_DOMAINS` but whose exemption is not granted yet;
  a closing or closed workspace; no customer; no live seat subscription; a seat subscription
  the owner already set to cancel; any status but `trialing` or `active`; a period end within
  the hour; a seat subscription with a discount (the coupon would not carry over to the new
  subscriptions: move it by hand); a seat subscription with no default card (the new ones could
  not charge); a workspace with no watched project, unless `--include-empty` is passed
  (converting it ends the minimum charge, which point 4 leaves open); a workspace already converted.
- **No double charge, no skipped day.** A paid (`active`) seat subscription: each project's new
  subscription starts now with `billing_cycle_anchor` = the seat subscription's period end and
  `proration_behavior: none`: Stripe charges nothing until the anchor, then monthly. A trialing
  one: each new subscription gets `trial_end` = the seat trial end. Then the seat subscription
  gets `cancel_at_period_end` (and `metadata.converted`), so it ends exactly when the new ones
  first charge. Pending proration items from seat changes stay owed and go on the customer's
  next invoice. The `anchor` form shows "active", not "trial", to the customer and sends no
  trial-ending email.
- **Order, each step recorded as Stripe answers:** default card from the seat subscription;
  create each project subscription (key `convert-<seat>-<project>`); cancel the seat one at the
  period end (key `convert-cancel-<seat>`); mark the workspace `project`.
- **Idempotent and resumable.** The plan is rebuilt from Stripe on every run: project
  subscriptions found by metadata are kept, a seat subscription marked `converted` is not canceled
  again. Stripe forgets idempotency keys after 24 hours; this does not depend on them.
- **Safety.** A dry run is the default and sends no write. `--apply` with a live key needs
  `--confirm-live`. Run it only after the new web Worker and poller are deployed: old code
  would prorate seat changes onto a converted seat subscription.

### The portal and staff workspaces (amends 029 points 6 and 7)

The portal configuration turns subscription cancellation off (point 11 and the alternatives
below). Decision 029 relies on the portal for staff to cancel a seat subscription left from before
their exemption. So the rollout changes the portal last, after the conversion. Until then staff
cancel a leftover seat subscription through the portal button on the "Complimentary" billing page;
after it, an operator cancels it in the Stripe Dashboard.

## Alternatives considered

- **Keep a workspace subscription for the minimum charge.** Rejected for now (point 4): two
  objects to keep in step, and the customer sees a charge with no project.
- **Store each project's Stripe status as the gate.** Rejected: the scheduler and the old code
  read `billing_accounts.status`; a standing there keeps both working with no new grant.
- **Convert with `trial_end` for paid workspaces too.** Works, but Stripe would show the paid
  month as a trial and can send trial reminders.
- **Cancel the seat subscription now with a prorated credit.** Rejected: a credit and new
  charges in the same month look like a double charge on the statement.
- **Recreate a subscription whenever Stripe ends one.** Rejected: with a failing card it would
  loop a failed charge at every overview visit; a new card comes first.
- **Let the portal cancel a project's subscription.** Rejected: a watched project with an ended
  subscription blocks the workspace. Removing the project is the cancel; the portal configuration
  turns cancellation off (rollout step).

## Consequences

- Migration `20261112050000_project_subscriptions.sql` is additive: one column with a default, one
  table, two indexes, guarded policies and a grant. No DROP; no existing row changes. The code
  before it passes its suites on it, except two tests that list every table (the isolation
  catalog and the purge test's "every table has rows").
- Live Stripe needs: the portal configuration without subscription cancellation; dunning set to
  cancel after the last retry; optionally `invoice.payment_action_required` on the webhook. No new
  price, product or secret.
- A staff-exempt workspace (029) is skipped. A seat subscription it still has charges at its
  trial or period end unless its owner cancels it (029 point 7, before the portal change).
- The poller's daily job now reconciles (a revoked grant's paused projects cancel within a day).
- A project whose first charge is `incomplete` is in grace but is not polled (the scheduler polls
  `trialing`, `active` and `past_due`).
