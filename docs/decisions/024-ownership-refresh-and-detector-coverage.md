# 024: Ownership refreshes inside the poll; detector 2 coverage has three states

Date: 2026-11-09

## Context

Detector 2 needs each table's owner columns, which come from the project's RLS policies
(decision 002). Issue #10 loads them. Two gaps existed:

- `projects.ownership` defaulted to `{}`. A project whose policies never loaded looked the same as
  a project with no owner-scoped tables. Detector 2 then found nothing, and the project read as
  clean. The PRD forbids that: a check that could not run is "unable to assess", never all-clear.
- Nothing said when to read the policies again after a customer changes them.

Erik decided on 2026-11-09 (issue #10):

1. Refresh inside the poll, every 24 hours, and on the first poll after a project is picked.
2. Record "unable to assess" for detector 2 on each poll run.
3. Show a project that loads but has no owner-scoped tables as its own state.

## Decision

1. **Where and when.** `pollProject` reads the policies after the token opens and before the logs
   query, when a read is due: never attempted, the last success is 24 hours old, or the last
   attempt that did not save (a failure, or a worker lost mid-read) is 1 hour old. No separate
   cron job.
2. **How.** `POST /v1/projects/{ref}/database/query/read-only` with `POLICIES_SQL`, which reads
   `pg_catalog.pg_policies` only. Scope `database:read`, already in the grant (decisions 012 and 023).
   Supabase runs it as `supabase_read_only_user`. The `policies_query` audit row is written in the
   claiming transaction, before the query runs.
3. **Failure.** A failed read keeps the last good map and stores an error code. It never fails the
   poll; detector 4 always runs.
4. **Coverage states for detector 2:**
   - *Assessed*: a map has loaded at least once.
   - *Unable to assess*: no map has ever loaded. The run lists `cross_tenant` in
     `poll_runs.unassessed_detectors`, and detector 2 does not run.
   - *No owner-scoped tables*: a map loaded and is empty. The overview says so; it is not "clean".
5. **Hand-set maps** (`repo.setOwnership`: CLI, tests, fixtures) count as a successful load.

## Alternatives considered

- **Refresh every 6 hours.** Policy changes show sooner, at four times the SQL calls on customer
  projects. Erik chose 24 hours.
- **A separate cron job for ownership.** A second queue consumer and claim, for no gain over the
  poll's existing claim.
- **Derive "unable to assess" from the project row only.** Simpler, but run history could not show
  which polls lacked detector 2.
- **Retry a failed read on every poll.** Up to 1,440 failing SQL calls a day per project. One an
  hour is enough.

## Consequences

- A policy change takes up to 24 hours to reach detector 2. A refresh-now button is possible later.
- A project whose policies stop being readable keeps its last good map indefinitely. The overview
  does not yet flag a stale map.
- Migration `20261110000000_ownership_refresh.sql` adds `projects.ownership_refreshed_at`,
  `ownership_attempted_at`, `ownership_error` and `poll_runs.unassessed_detectors`. It is additive.
  Applying it to a shared database needs Erik's approval.
- Not verified live: whether `supabase_read_only_user` can read `pg_policies` on a real project.
  That needs the OAuth app (#4).
