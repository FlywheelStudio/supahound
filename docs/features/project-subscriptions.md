# One Stripe subscription per project (#99)

Decisions [032](../decisions/032-subscription-per-project.md) (what) and
[041](../decisions/041-project-subscriptions-build.md) (how). Built 2026-11-12. The production
rollout waits for Erik: see "Rollout" below.

## What it does

- The workspace keeps one Stripe customer and the card the $1 hold validated (decision 028). The
  card check starts the workspace's one 7-day trial and creates no subscription.
- Each watched project gets its own monthly subscription at its tier: Starter $19.99 (up to 1M
  edge requests in 30 days) or Pro $99 (above; above 10M it stays Pro and we contact the customer).
- A project added during the trial is free until the trial ends; one added after it is billed
  from the day it is added. A tier change applies at the next renewal.
- Removing a project cancels its subscription at its period end. Adding the same Supabase project
  back within that period resumes the same subscription. Pausing (disconnect, revoked grant)
  cancels at the period end; reconnecting resumes.
- Closing the workspace cancels every subscription at its period end; reopening resumes the ones
  whose projects are still watched.
- Staff-exempt workspaces (decision 029) create no subscription.
- Project Settings → Plan & billing: plan, status, next charge, invoices; the Billing Portal for
  workspace owners and admins. The workspace billing page lists every project's subscription and
  the monthly total.
- `pnpm convert-subscriptions` moves workspaces still on a seat subscription, with no double charge.

## How it works

| Piece | File |
| --- | --- |
| Pure rules: trial for a new project, standing, reconcile plan, conversion plan | `packages/core/src/billing/projects.ts` |
| Access and "paying" per model | `packages/core/src/billing/policy.ts` (`accessForAccount`, `payingAccount`) |
| Card check, reconcile, webhook routing, model router | `packages/core/src/billing/flow.ts` (`completeVerification`, `reconcileProjects`, `refreshSubscription`, `syncBilling`) |
| Stripe calls | `packages/core/src/billing/stripeGateway.ts`; mapping in `stripeMap.ts` |
| Rows | `packages/core/src/db/billing.ts` (`listProjectSubscriptions`, `saveProjectSubscription`, `refreshStanding`, `projectBillingDrift`) |
| Close and reopen | `packages/core/src/datacontrols/flow.ts` |
| Conversion | `packages/core/src/billing/convert.ts`, `packages/core/src/cli.ts` (`runConvertSubscriptions`) |
| Pages | `apps/web/app/w/[tenantId]/p/[projectId]/settings/plan/` (page, portal action), `apps/web/app/w/[tenantId]/billing/page.tsx`, `apps/web/lib/projectBilling.ts` |

Data flow:

1. The owner picks a project (`projects/actions.ts`) → the insert commits → `syncBillingAfterChange`
   → `syncBilling` → `reconcileProjects`.
2. `reconcileProjects` reads the billing row, the watched projects and the subscription rows in one
   tenant transaction, plans (`planReconcile`), closes the transaction, calls Stripe per action,
   writes each answer in its own transaction, then stores the standing. No Stripe call runs inside
   a transaction.
3. Stripe's webhook (`/api/stripe/webhook`) → signature check → `handleBillingEvent` →
   `refreshSubscription`, which reads the subscription from Stripe and routes it by
   `metadata.project_id`.
4. Safety nets: the overview reconciles when it sees drift (owners and admins); the poller's daily
   usage job reconciles after it sets tiers.

## Data model and RLS

Migration `supabase/migrations/20261112050000_project_subscriptions.sql` (additive, no DROP).

| Object | What |
| --- | --- |
| `billing_accounts.billing_model` | `workspace` (default; the seat model) or `project` |
| `billing_accounts.status` | Per-project model: the standing (worst status of the watched projects' current subscriptions, `none` when none) |
| `billing_accounts.trial_end` | Per-project model: the workspace trial end, set once |
| `project_subscriptions` | `tenant_id`, `project_id` (nullable; `ON DELETE SET NULL (project_id)`), `supabase_ref`, `subscription_id` (unique), `tier`, `status`, `trial_end`, `current_period_end`, `cancel_at_period_end` |
| `project_subscriptions_one_live` | Unique: one live subscription per project |

Policies on `project_subscriptions`: `tenant_isolation`; `project_access` (RESTRICTIVE SELECT,
decision 036: a signed-in user sees a row with a role on its project; rows without a project are
for workspace owners and admins); `subscription_insert` and `subscription_update` (RESTRICTIVE: no
signed-in user, or a workspace owner or admin). No DELETE grant: the rows are payment history
(decision 037). The scheduler reads nothing new.

## External services (Stripe)

- Prices: the existing Starter and Pro monthly prices, one item per subscription, quantity 1.
- Metadata on each project subscription: `tenant_id`, `project_id`, `supabase_ref`.
- The card is the customer's `invoice_settings.default_payment_method`.
- Webhook events used: `customer.subscription.*` and `invoice.*` (already on the endpoint).
- Portal: workspace owners and admins; cancellation in the portal must be off (rollout step).

## Rollout (needs Erik's approval at each step)

0. Independent of this change: a staff owner whose workspace still has a seat subscription opens
   Billing (the exemption is granted there) and cancels it with the portal button before it charges.
1. Apply the migration to production (additive; the code before it keeps working).
2. Deploy the web Worker and the poller together from this code.
3. Rehearse in Stripe test mode: one `--apply` on a test seat subscription, then preview the next
   invoice of the seat subscription and of each new one: no charge before the anchor, no final
   seat invoice, pending prorations on the next invoice.
4. `pnpm convert-subscriptions` dry run with the live key; read every line. A staff workspace must
   read "skip (staff exemption ...)".
5. `pnpm convert-subscriptions --apply --confirm-live`; run it again to see "already converted".
6. Stripe live: turn off subscription cancellation in the portal configuration (last, see decision
   041 on 029); set dunning to cancel after the last retry; optionally add
   `invoice.payment_action_required` to the webhook.

Rollback: the migration can stay in place whatever happens (the old code passes on it). The old
code can be redeployed only until the first per-project workspace exists: its gate blocks status
`none`, so a new workspace with no project would be locked out. After `--apply`, only a forward fix
is safe: old code would prorate seat changes onto converted seat subscriptions.

## Testing

| Tier | File | What |
| --- | --- | --- |
| Unit | `packages/core/test/billing/projects.test.ts` | Trial for a new project, standing, reconcile plan, conversion planner (anchor = old period end, trial mode, every skip, interrupted run, same keys on repeat, no projects) |
| Unit | `packages/core/test/billing/policy.test.ts` | Access and paying under both models |
| Unit | `apps/web/test/stripe.test.ts` | Project subscription mapping, fail-closed rows, invoice links, project webhook events, terms text |
| Unit | `apps/web/test/projectBilling.test.ts` | Subscription lines, totals, summary rows, who manages billing |
| Postgres | `packages/core/test/db/projectSubscriptions.test.ts` | Add during and after the trial, remove, re-add, pause, tier, outage, orphan adoption, exempt, lapse and new card; RLS (owner, admin, viewer, member, cross-tenant, no delete, one live per project); paying and the data job under both models; webhooks; close and reopen; conversion dry run, apply, repeat, resume, trial mode, exempt skips; CLI guards |
| Postgres | `billing.test.ts`, `people.test.ts`, `isolation.test.ts`, `dataControls.test.ts` | Card check in the new model; seat model kept; the table in every RLS and purge check |
| UAT | `apps/web/e2e/specs/projectBilling.uat.spec.ts` | W45–W49, B15 |
| UAT | `billing.uat.spec.ts`, `dataControls.uat.spec.ts` | B3, B4, B8, B10, B12 and W34–W37 on the new model |

## Gotchas

- **Run the conversion only after the new code is deployed.** Old code would prorate a seat
  change onto a converted seat subscription. Tested: "apply" checks `syncSeats` leaves it alone.
- **Stripe forgets idempotency keys after 24 hours.** Reconcile adopts a live subscription Stripe
  already has for the project; the CLI rebuilds its plan from Stripe. Tested: "adopts a
  subscription Stripe made", "resumes an interrupted run".
- **A watched project with an ended subscription blocks the workspace.** Reconcile does not
  recreate it by itself (a failing card would loop); a new card does. Tested: "blocks the
  workspace when a watched project's subscription ends unpaid".
- **A lapse inside the trial keeps the trial.** A new card during the original trial window gives
  new subscriptions the remaining trial, never a new one. Tests end the trial first when they
  check "billed at once".
- **The staff exemption is granted on the billing page.** A staff workspace whose owner has not
  opened Billing since the exemption shipped is not exempt yet; the CLI skips it by its owner's
  recorded email. Tested: "skips exempt workspaces and staff workspaces whose exemption is not granted yet".
- **The conversion refuses what it cannot carry over:** a coupon on the seat subscription, a seat
  subscription with no card, and (without `--include-empty`) a workspace with no project. Tested in
  `projects.test.ts` ("skips ...").
- **`incomplete` is grace at the gate but not polled** (the scheduler polls `trialing`, `active`, `past_due`).
