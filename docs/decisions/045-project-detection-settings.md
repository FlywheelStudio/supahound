# 045: Per-project detection settings: intentionally public tables and the RPC burst threshold

Date: 2026-11-22 · Issue #160 · Builds on 030 (alert threshold), 036 (project roles), 038 (posture)

## Context

Detector 11 (`exposed_read`, #132) alerts on anon-key reads of a table the posture scan shows
readable by anon. Some tables are meant to be public (a price list, a country lookup), and the
detector had no way to know. Detector 12 (`rpc_exposure`, #131) rates anon calls to an exposed
SECURITY DEFINER function high at a fixed 100 calls from one network in one poll
(`RPC_BURST_HITS`), which is too low for some apps and too high for others. Erik decided on
2026-11-22: Owners and Admins can mark a table intentionally public, the detector then raises
nothing for it, the Posture page shows the finding as accepted, the mark is stored per project
with `tenant_id`, forced RLS and a `(tenant_id, id)` foreign key, changes are audited, and the
burst threshold becomes a per-project setting next to the alert threshold (default 100, range 10
to 10,000). Detector 11's severities stay as built.

## Decision

1. **A table of marks.** `public_tables (id, tenant_id, project_id, table_name, marked_by,
   marked_at)`, primary key `(tenant_id, id)`, unique `(tenant_id, project_id, table_name)`,
   foreign key `(tenant_id, project_id)` to `projects` `ON DELETE CASCADE`. `table_name` is a
   lower-case identifier (`^[a-z_][a-z0-9_]{0,62}$`), checked in the app (`safeName` and
   `safeIdentifier`) and in the database: the only form detector 11 matches. A mark names a table
   in `public`, the schema the Data API serves. It may name a table posture has not reported yet.
2. **Who marks.** The project's Owners and Admins (new `mark_public` row in the role matrix of
   decision 036). A mark turns off alerts, so it sits with the roles that manage people, not with
   Editors. RLS: `tenant_isolation`, `project_access` (RESTRICTIVE SELECT), and RESTRICTIVE INSERT
   and DELETE on `project_role(project_id) IN ('owner', 'admin')`. No UPDATE grant: unmark is a
   delete. Transactions without `app.user_id` (the poller) keep the whole tenant.
3. **The detector never sees a marked table.** The poller drops marked tables from the
   anon-readable set (`withoutPublicTables`) before it builds the rollup SQL, so their anon reads are
   never fetched from Supabase and detector 11 cannot raise anything for them. A mark or unmark takes
   effect from the next poll, like a new posture scan.
4. **Accepted means reads only.** On the Posture page a finding is "Accepted (intentionally
   public)" when its table is marked and it says the table can be read and nothing more:
   `rls_disabled` where the API roles hold no grant but SELECT; `permissive_policy` whose open
   commands are SELECT only; the Advisor's `rls_disabled_in_public` (it carries no grants; the
   catalog check replaces it whenever the catalog read works). A finding that also lets the Data API
   write the table stays open, with a note. Accepted findings are not counted (Posture page, project
   dashboard, overview). Other checks on the table (GraphQL exposure, views) are not touched.
5. **Burst threshold per project.** `projects.rpc_burst_hits integer NOT NULL DEFAULT 100 CHECK
   (BETWEEN 10 AND 10000)`. Owners, Admins and Editors change it on the project's Notifications
   page next to the email alert threshold, through the existing `project_settings` UPDATE policy,
   exactly like `email_alerts` (decision 030). The poller passes it through `scan()` to
   `detectRpcExposure`, which falls back to 100 for any value outside the range, so a bad value
   never silences the burst. The finding's evidence records `burstThreshold`, a count.
6. **Audited.** A new `audit_log` action, `detection_setting`, written in the same transaction as
   the change: `{setting: "public_table", change: "mark" | "unmark", table, by}` and
   `{setting: "rpc_burst_hits", from, to, by}` (`by` is the user ID; an unchanged threshold writes
   nothing).
7. **Server actions.** The user comes from `getClaims()` (`requireUser`); the role is checked in the
   same `withTenantForUser` transaction as the write (`paidProject`), and RLS refuses the same
   writes again. Out-of-range or malformed input is refused before any database call.

## Alternatives considered

- **Accept every finding on a marked table, writes included.** Rejected: Supabase grants anon and
  authenticated every privilege on new `public` tables by default, so an RLS-off table almost always
  lets anyone change or delete its rows. "Public to read" never means that. The fix SQL (enable RLS,
  add a read-all policy) leaves a SELECT-only finding the mark accepts.
- **Keep fetching marked tables and drop the findings in the detector.** Rejected: it reads log
  rows Supahound does not need, and the SQL is capped at 200 tables.
- **Editors may mark tables.** Rejected: a mark silences an alert; the issue gives it to Owners and
  Admins.
- **A JSON column on `projects` for the marks.** Rejected: no per-row RLS rules, no audit per table,
  and the role rule for marks differs from the rule for other settings.

## Consequences

- Erik applies migration `20261122150000_project_detection_settings.sql`. It is additive: a column
  with a default, a new table with its policies, and a longer audit action list. Old code ignores
  the new column and table and never writes the new action.
- A mark does not change detector 2's posture raise (decision 038): a cross-tenant read of a marked
  table is still raised a step when its posture is high or worse.
- A table renamed in Postgres loses its mark in effect (the mark keeps the old name); the Posture
  page lists marks, so an Owner can unmark the stale one.
