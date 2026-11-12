# Project removal with a grace period

Decision [042](../decisions/042-project-removal-grace.md). Built 2026-11-12 on top of #99
(per-project billing). The production migration waits for Erik.

## What it does

- Removing a project no longer deletes it. The project stays active until its subscription's
  period ends (the trial end during the trial). Supahound polls it and sends alerts until then.
- 7 days after that, the daily data job deletes it, unless an Owner or Admin keeps it first.
- Every page says, in the same words: "The project stays active until <date> and is deleted on
  <date + 7 days> unless you keep it." The remove form says it before the user confirms.
- After the period ends, polling stops. The project stays visible with its deletion date and the
  Keep project button.
- **Keep project** clears the removal. Within the period, the same subscription continues and
  nothing extra is charged. After it, a new subscription is charged at once. Picking the same
  Supabase project again in the picker also keeps it.
- A cancel in the Stripe Billing Portal schedules the removal the same way; a resume in the
  portal clears it.
- A staff-exempt workspace, a seat-model workspace, billing off, or no subscription: the project
  stops at once and is deleted 7 days later.
- Closing a workspace and disconnecting Supabase keep their own rules (decision 037).

## How it works

| Piece | File |
| --- | --- |
| Dates: `removalActiveUntil`, `removalDates`, `REMOVAL_GRACE_DAYS` | `packages/core/src/billing/projects.ts` |
| Schedule, keep, preview, the data job delete, the webhook rule | `packages/core/src/db/removal.ts` (`scheduleRemoval`, `cancelRemoval`, `removalPreview`, `deleteRemovedProjects`, `applyPortalCancel`) |
| Not billed while scheduled | `packages/core/src/db/billing.ts` (`watchedProjects`, `projectTiers` → `billedTiers`), `packages/core/src/billing/usage.ts` |
| Polling stops at `active_until` | `packages/core/src/db/repo.ts` (`dueProjects`, `claimProject`), `packages/core/src/poller/pollProject.ts` (skip `removed`) |
| Re-pick keeps the project | `packages/core/src/db/repo.ts` (`watchProjects`, `ON CONFLICT ... DO UPDATE`) |
| Data job | `packages/core/src/datacontrols/flow.ts` (`runDataJob`, `projectsDeleted`) |
| Webhook | `packages/core/src/billing/flow.ts` (`refreshSubscription` → `applyPortalCancel`) |
| Close guard | `packages/core/src/datacontrols/flow.ts` (`closeWorkspace` clears `billing` removals made during the close) |
| Actions | `apps/web/app/w/[tenantId]/projects/actions.ts` (`removeProjectAction`, `keepProjectAction`) |
| Text | `apps/web/lib/removal.ts`; outcomes in `apps/web/lib/picker.ts` (`keepOutcome`) |
| Pages | Projects, project dashboard, Settings → Plan & billing, workspace Billing ("Removals scheduled") |

Data flow for a removal in Supahound:

1. The user types the name → `removeProjectAction` → `scheduleRemoval` reads the project's current
   subscription and sets the three dates in one tenant transaction.
2. After the commit, `syncBillingAfterChange` → `reconcileProjects`. The project is no longer in
   `watchedProjects`, so reconcile cancels its subscription at the period end.
3. Stripe's webhook echoes the cancel. The project is already scheduled, so nothing changes.
4. At `active_until` the scheduler stops enqueuing the project; `claimProject` refuses it too.
5. At `delete_after` the data job deletes it.

Keep: `keepProjectAction` → `cancelRemoval` (no standing refresh in that transaction) → reconcile
resumes the subscription, or creates a new one after the period.

## Data model and RLS

Migration `supabase/migrations/20261112060000_project_removal_grace.sql` (additive, no DROP).

| Object | What |
| --- | --- |
| `projects.removal_requested_at` | When the removal was scheduled; NULL = not scheduled |
| `projects.active_until` | Polling stops from this time |
| `projects.delete_after` | The data job deletes from this time |
| `projects.removal_source` | `user` or `billing` (a portal cancel) |
| `projects_removal_schedule` | CHECK: all four set or none; `delete_after` = `active_until` + 7 days; `active_until` ≥ `removal_requested_at` |
| `projects_delete_after_idx` | Partial index `(tenant_id, delete_after)` for the data job |
| `project_removal_guard` | BEFORE UPDATE trigger: a signed-in user who is not a workspace owner or admin and not the project's Owner cannot change the four columns |
| Scheduler grant | `SELECT (active_until)`, so `dueProjects` skips stopped projects |

The server functions check the same rule in their WHERE clause and return false, so a page never
sees the trigger's error. The trigger catches a raw UPDATE: the `project_settings` policy lets
Editors update a project, and a policy cannot tell which columns change.

## External services (Stripe)

- No new price, product, webhook event or secret.
- The cancel flag is read as before: `cancel_at_period_end` or `cancel_at` (the portal sets the
  latter; see project-subscriptions.md).
- A portal cancel needs portal cancellation turned on. Decision 041's rollout turns it off; while
  it is off, this path is idle and a removal happens only in Supahound.

## Testing

| Tier | File | What |
| --- | --- | --- |
| Unit | `packages/core/test/billing/projects.test.ts` | Dates: paid, past_due, trial, no subscription, ended or blocked, past period end |
| Unit | `apps/web/test/removal.test.ts` | The exact sentences, before and after the period, the keep note |
| Unit | `apps/web/test/picker.test.ts` | `keepOutcome` per role; the `kept` and `removed` notices |
| Postgres | `packages/core/test/db/removalGrace.test.ts` | Paid, trial, exempt and no-row dates; reconcile cancels and never resumes; polling stops at `active_until`; keep within the period (same subscription) and after it (new one, billed); re-pick keeps; the data job never deletes before `delete_after`, deletes at it while paying, keeps audit and payment rows; undo wins; webhook portal cancel and resume, echo, failed resume, paused, close race |
| Postgres | `people.test.ts` | Schedule and keep by role; a raw UPDATE from an Editor is refused by the trigger |
| Postgres | `projects.test.ts`, `posture.test.ts`, `isolation.test.ts` | Schedule then delete with the cascade; another tenant untouched; the scheduler sees `active_until` only |
| UAT | `apps/web/e2e/specs/picker.uat.spec.ts` | UAT-W14 |
| UAT | `apps/web/e2e/specs/projectBilling.uat.spec.ts` | UAT-W47, UAT-W50 |

## Gotchas

- **Our own cancels echo back by webhook.** Only a change of the cancel flag counts, and paused
  projects and closing workspaces are skipped. Tested: "keeps a removal made in Supahound when its
  own cancel echoes back", "never schedules a disconnected (paused) project", "never schedules
  removals when the workspace closes, even if the webhook beats the close".
- **A failed resume after Keep must not come back as a removal.** Tested: "does not undo a keep
  when the resume failed and an unrelated event arrives".
- **Keep after the period must not lock the workspace.** `cancelRemoval` does not refresh the
  standing; reconcile creates the new subscription first. Tested: "creates a new subscription,
  billed at once, after the period ended and before deletion".
- **Do not use `paused` for this.** A reconnect clears `paused` on every project of the connection.
- **The 7 lives in two places:** `REMOVAL_GRACE_DAYS` and the migration's CHECK.
- **A scheduled project still holds its Supabase ref** in the workspace. The picker lists it as
  pickable, and picking it keeps it.
