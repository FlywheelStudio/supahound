# 042: Removing a project keeps it until its period ends, then deletes it 7 days later

Date: 2026-11-12 · Builds on [022](022-remove-project-keeps-audit-log.md), [036](036-project-roles-and-invites.md),
[037](037-data-controls.md) and [041](041-project-subscriptions-build.md). Supersedes 022 point 3 and
041 point 7. Overrides 037 point 1 for removed projects only.

## Context

Decision 022 deleted a removed project's history at once. Decision 041 kept that rule and canceled
the project's subscription at its period end. So a customer paid for a month of a project that
Supahound had already deleted. Erik ruled on 2026-11-12:

> "when someone cancels or removes a project, say the project will remain active through the
> billing period and will be deleted 7 days after the cancellation if not reactivated."

## Decision

1. **Removal schedules, it does not delete.** Removing a project (in Supahound, or a cancel in the
   Billing Portal) sets three dates on the project:
   - `removal_requested_at`: when.
   - `active_until`: the end of the period its subscription paid for (`current_period_end`), or
     the trial end while the subscription trials. Never earlier than the removal itself.
   - `delete_after`: `active_until` + 7 days.
   `removal_source` records `user` or `billing`.
2. **Until `active_until` the project is active.** The poller polls it, alerts go out, and every
   page shows it with "Removal scheduled" and the dates. It is no longer billed: reconcile cancels
   its subscription at the period end, and the seat model drops its seat.
3. **After `active_until` polling stops.** The scheduler and `claimProject` skip the project. The
   project stays visible with its deletion date and the Keep button. The data job does not set
   `paused`: `paused` belongs to disconnect and reconnect (037), and a reconnect would undo it.
4. **At `delete_after` the data job deletes it** (00:40 UTC, tenant by tenant, in `withTenant`).
   The cascade is the one decision 022 and 037 describe: incidents, findings, poll runs,
   service-key networks, usage, people, invites and posture scans. Audit rows and
   `project_subscriptions` rows stay, with `project_id` set to NULL. The DELETE itself checks
   `delete_after`, so an undo that commits first always wins.
5. **This overrides 037 point 1 for removed projects.** The data job deletes a removed project at
   `delete_after` even while the workspace pays: that project's own payment has ended. The
   workspace's other projects keep everything while it pays.
6. **Keep project (undo).** The people who may remove a project may keep it until it is deleted:
   a workspace owner or admin, or the project's Owner (036). Keeping clears the three dates.
   Reconcile then resumes the same subscription within its period (no extra charge), or after the
   period creates a new one, charged at once. Polling resumes once the workspace's standing allows
   it (041 point 5). Picking the same Supabase project again in the picker also keeps it.
7. **Nothing paid: the removal time.** A staff-exempt workspace (029), a seat-model workspace,
   billing off, no subscription row, or an ended or blocked subscription: `active_until` is the
   removal time, so polling stops at once, and the project is deleted 7 days later.
8. **The Billing Portal (webhook).** The webhook compares the subscription's cancel flag with the
   stored row:
   - false → true on a linked project: a portal cancel. Schedule the removal with
     `removal_source = billing` and the period end. Skipped when the project is already scheduled,
     paused (a disconnect cancels through reconcile) or the workspace is closing.
   - true → false on a scheduled project: a resume. Clear the removal, whoever scheduled it.
     Stripe's state wins for changes made only in the portal.
   - No change: nothing. An unrelated event never turns a failed resume back into a removal.
   Closing a workspace cancels every subscription. A webhook that arrives before the close is
   recorded could read as a portal cancel, so the close clears `billing` removals made since it began.
9. **Who.** The removal columns change only by the 036 removal rule. The server functions check it
   in their WHERE clause, and a trigger refuses a raw UPDATE from anyone else. The trigger is
   needed because the UPDATE policy `project_settings` lets Editors update a project.
10. **The words.** Every page says: "The project stays active until <date> and is deleted on
    <date + 7 days> unless you keep it." The remove form says it before the user confirms. The
    typed-name confirmation stays.
11. **Unchanged.** Closing a workspace and disconnecting Supabase keep their 037 rules.

## Alternatives considered

- **Delete at once and cancel at the period end** (022 and 041). Rejected by Erik: the customer
  pays for a project they cannot see.
- **Pause through `projects.paused`.** Rejected: reconnecting a connection clears `paused` on all
  its projects, which would restart a removed project; and undo could not tell which pause to clear.
- **Treat every webhook with a cancel set as a removal.** Rejected: our own cancels (close,
  disconnect) echo back by webhook and would schedule deletions nobody asked for.
- **Let only the user's own removals be undone by a portal resume.** Rejected for now: two
  sources of truth fight; Stripe's state is simpler to explain.

## Consequences

- Migration `20261112060000_project_removal_grace.sql` is additive: four nullable columns, a CHECK
  (all four set or none; `delete_after` = `active_until` + 7 days), a partial index for the data
  job, a guard trigger and one scheduler column grant (`active_until`). No DROP; no row changes.
- A project in its grace week still occupies its Supabase ref in the workspace (one row per ref).
- Decision 022 point 3 and decision 041 point 7 are superseded by this record.
- `REMOVAL_GRACE_DAYS` (`packages/core/src/billing/projects.ts`) and the migration's CHECK hold
  the same 7. Change both together.
