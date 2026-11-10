# Ownership refresh

Issue #10. Decisions 002 (ownership from RLS policies) and 024 (refresh and coverage states).

## What it does

Detector 2 (cross-tenant reads) alerts when a signed-in user filters an owner column by another
user's ID. It needs to know which columns are owner columns, per table and per command. The poller
reads them from the customer project's RLS policies on the first poll after a project is picked,
then every 24 hours. A project whose policies Supahound cannot read shows "unable to assess" for
detector 2, never clean. A project whose policies scope no table to an owner shows "no
owner-scoped tables found".

## How it works

1. `pollProject` (`packages/core/src/poller/pollProject.ts`) claims the poll, opens the token, then
   calls `refreshOwnership`.
2. `refreshOwnership` checks the project row. A read is due when it was never attempted, the last
   success is 24 hours old (`OWNERSHIP_REFRESH_SECONDS`), or the last unsaved attempt is 1 hour old
   (`OWNERSHIP_RETRY_SECONDS`). An attempt counts as a success only when `ownership_refreshed_at`
   is at or after `ownership_attempted_at`; a failure or a worker lost mid-read retries after an hour.
3. One short transaction claims the read (`repo.claimOwnershipRefresh`, a conditional update on
   `ownership_attempted_at`) and writes the `policies_query` audit row with the SQL's SHA-256.
4. Outside any transaction, `deps.queryPolicies` sends `POLICIES_SQL` to Supabase. In the Worker,
   that is `queryReadOnly` (`packages/core/src/ownership/client.ts`).
5. `parsePolicyRows` checks each row; `ownershipFromPolicies` (`ownership/ownership.ts`) builds the
   map per decision 002.
6. Success: `repo.setOwnership` stores the map and `ownership_refreshed_at`. Failure:
   `repo.failOwnershipRefresh` stores an error code and keeps the old map.
7. The scan runs. If no map has ever loaded, detector 2 gets an empty map and the run records
   `unassessed_detectors = {cross_tenant}`. Detector 4 always runs.
8. The overview (`apps/web/app/w/[tenantId]/page.tsx`) shows a line from `crossTenantNote`
   (`apps/web/lib/coverage.ts`) for the two gaps. `repo.listProjects` derives `crossTenant`:
   `unable_to_assess` if the latest `ok` run lists `cross_tenant`; `no_owned_tables` if a map
   loaded and is empty; `assessed` otherwise; `null` before the first `ok` run.

Error codes in `projects.ownership_error`: `unauthorized` (401/403), `rate_limited` (429),
`query_failed` (other HTTP errors), `invalid_response` (no row array, or more than 10,000 rows),
`network_error` (timeout or fetch failure).

## Data model and RLS

Migration `supabase/migrations/20261110000000_ownership_refresh.sql` (additive):

| Column | Meaning |
| --- | --- |
| `projects.ownership_refreshed_at` | Last successful read. NULL = never loaded |
| `projects.ownership_attempted_at` | Last attempt, success or failure. Drives the retry wait |
| `projects.ownership_error` | Error code of the last attempt; NULL after a success |
| `poll_runs.unassessed_detectors` | Detectors an `ok` run could not check. CHECK limits it to detector names |

Both tables already have `tenant_id`, forced RLS and composite foreign keys. Every new query goes
through `withTenant` and repeats `tenant_id = tx.tenantId`. The scheduler role's column grants are
unchanged: it cannot read the new columns.

## External services

- Supabase Management API, `POST /v1/projects/{ref}/database/query/read-only`. Scope
  `database:read`. Supabase runs the query as `supabase_read_only_user` and answers HTTP 201. The
  OpenAPI spec documents no body; the client accepts a bare row array or `{ result: [...] }` and
  fails on anything else. 20-second timeout. Error bodies never leave the client: only the status.
- The only SQL sent is `POLICIES_SQL`: `SELECT … FROM pg_catalog.pg_policies WHERE schemaname =
  'public'`. Policy definitions only, never table data.

## Testing

- `packages/core/test/ownershipClient.test.ts` (12): request shape, both response shapes, status
  without body text, unreadable bodies fail, bad refs refused, row parsing, row cap.
- `packages/core/test/db/ownershipRefresh.test.ts` (11, Postgres): first-poll read with the audit
  row written before the query; never-loaded → unable to assess with detector 4 still alerting;
  failure keeps the old map; 24-hour refresh; 1-hour retry after a failure and after a lost attempt; no owner-scoped tables; invalid
  response; no audit row when the token fails; tenant isolation on a shared Supabase ref; the
  `unassessed_detectors` CHECK.
- UAT-D7, UAT-D8, UAT-D9 (`packages/core/test/uat/detection.uat.test.ts`) and UAT-W16
  (`apps/web/e2e/specs/ownership.uat.spec.ts`).
- `apps/web/test/coverage.test.ts` (4): the overview copy never calls a gap clean.
- Mutation checks: see `docs/TESTING.md`.

## Gotchas

- **Never loaded is not empty.** `ownership = {}` with `ownership_refreshed_at IS NULL` means
  unable to assess; with a timestamp it means no owner-scoped tables. Tested.
- **The audit row comes before the query.** It is written in the claiming transaction. The fake
  endpoint in the test checks the row exists when it is called. Tested.
- **A failed read keeps the old map.** Detector 2 keeps working on the last good map. Tested.
  The overview does not yet flag a map that has not refreshed for days.
- **The claim commits before the read.** `ownership_attempted_at` is set before the query runs, so a
  worker that dies mid-read leaves an attempt with no save. The retry rule keys on a saved success,
  not on `ownership_error`, so that state retries after an hour. Tested.
- **Hand-set maps count as loaded.** `repo.setOwnership` sets `ownership_refreshed_at`, so CLI and
  test fixtures never trigger a read.
- **Not verified live** that `supabase_read_only_user` can read `pg_policies`. Needs the OAuth app (#4).
