# 022: Removing a watched project deletes its history but keeps its audit log

Date: 2026-11-09

## Context

The project picker (issue #9) lets owners and admins add Supabase projects. Erik decided on
2026-11-09 that the same page also removes a project, with a warning. A project's incidents,
findings, poll runs and service-key networks cascade from `projects`. So did its `audit_log`
rows, which are the customer's record of every query Supahound ran against their project.

## Decision

1. Owners and admins can remove a project. Members cannot. The server checks the role inside the
   delete transaction.
2. The user must type the project's exact name. The page states what is deleted and that the
   step cannot be undone. No browser dialog.
3. ~~Removal deletes the project's incidents, findings, poll runs and service-key networks.~~
   **Superseded by [042](042-project-removal-grace.md):** removal schedules the deletion. The project
   stays active until its paid period ends, and the data job deletes it 7 days later unless an
   Owner or Admin keeps it. What the deletion removes and keeps is unchanged.
4. Removal keeps the project's audit rows. Migration
   `20261109000000_audit_log_keep_on_project_delete.sql` changes the foreign key to
   `ON DELETE SET NULL (project_id)`.
5. Picking the project again starts a new row with no history.

## Alternatives considered

- **Pause only** (the existing `projects.paused` column). Reversible, but the user cannot clear a
  project they no longer manage, and its data stays.
- **Cascade the audit log too.** Rejected: the audit log is the record that shows what Supahound
  did with the customer's grant. It must outlive the project.

## Consequences

- An audit row can have a null `project_id`. The audit log page (#20) must show these rows as
  "removed project".
- Account deletion (#43) still deletes everything, audit rows included, through the tenant cascade.
- The migration needs Postgres 15 or later. Supabase runs 15 and 17. Apply it to shared databases
  only with Erik's approval.
