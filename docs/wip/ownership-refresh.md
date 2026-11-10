# WIP: Ownership refresh (#10)

Goal: detector 2 needs each table's owner columns. The poller reads them from the customer
project's RLS policies and stores them in `projects.ownership` (decision 002). A project whose
policies Supahound cannot read shows "unable to assess" for detector 2, never "clean".

## Erik's calls (2026-11-09)

- The refresh runs inside the poll, every 24 hours, and on the first poll after a project is
  picked. No separate cron job.
- "Unable to assess" for detector 2 is recorded per poll run (`poll_runs.unassessed_detectors`).
- A project that loads but has no owner-scoped tables shows a third state: "no owner-scoped
  tables found". It is neither clean nor unable to assess.

Recorded in decision 024.

## Approach

- `packages/core/src/ownership/client.ts`: `POST /v1/projects/{ref}/database/query/read-only`
  (`database:read`, runs as `supabase_read_only_user`). Supabase answers 201. The parser accepts
  a bare row array or `{ result: [...] }`. `parsePolicyRows` validates each `pg_policies` row.
- `POLICIES_SQL` (existing) reads `pg_catalog.pg_policies` only.
- Migration `20261110000000_ownership_refresh.sql`:
  - `projects.ownership_refreshed_at` (last success; NULL = never loaded),
    `ownership_attempted_at`, `ownership_error`.
  - `poll_runs.unassessed_detectors text[]`, values limited to the detector names.
- `pollProject`: after the token opens, if the refresh is due, one transaction claims it
  (`ownership_attempted_at`) and writes the `policies_query` audit row; the query runs outside any
  transaction; a short transaction saves the map or the error code. Due: never attempted, or the
  last success is 24 hours old, or the last failure is 1 hour old.
- A failed refresh keeps the last good map and never fails the poll. Detector 4 always runs.
- Never loaded → detector 2 is skipped and the run lists `cross_tenant` as unassessed.
- `repo.setOwnership` (hand-set maps, CLI and tests) counts as a successful load.
- Web overview: a line under each project for the two detector 2 states.

## Files expected to change

`packages/core/src/ownership/client.ts` (new), `poller/pollProject.ts`, `db/repo.ts`,
`apps/poller/src/index.ts`, the migration, `apps/web/app/w/[tenantId]/page.tsx`, a web helper,
tests in `packages/core/test/` and `apps/web/e2e/`, docs.

## Open questions

- Not verified live: whether `supabase_read_only_user` can read `pg_policies` on a real project.
  It needs the OAuth app (#4). `pg_policies` is a public catalog view, so it should.
- The response body of the read-only endpoint is not in Supabase's OpenAPI spec. The parser
  accepts both shapes Supabase uses for SQL endpoints.

## Build log

- 2026-11-09: branch `feature/ownership-refresh` off `develop` (does not need #61).
