# Posture scan

Issue #11. Decision 038. Builds on decisions 024 (read-only SQL in the poll) and 036 (project roles).

## What it does

Supahound answers "am I exposed?" within about 2 minutes of a project pick. The poller checks the
project's `public` schema for tables without RLS, policies that pass every row (`USING (true)`,
`WITH CHECK (true)`), views without `security_invoker`, SECURITY DEFINER functions the API roles
can execute, and, when pg_graphql is installed, tables and views it shows them (#135). It also reads Supabase's Security
Advisor. Each finding shows its severity, the object (`schema.table`), the check and a fix prompt:
copyable SQL built from a template. The scan runs on the first poll, then daily, and on demand
(Scan now). A cross-tenant detection on a table that posture shows exposed is raised one step.

## How it works

1. `pollProject` (`packages/core/src/poller/pollProject.ts`) opens the token, refreshes ownership,
   then calls `refreshPosture`, before the logs query.
2. One short transaction claims the scan (`db/posture.ts`, `claimPostureScan`: an upsert on
   `posture_scans` with the due rule in its `WHERE`) and writes the `policies_query` audit row
   (`purpose: posture_scan`, SQL SHA-256, `security_advisor: true`).
   Due: never attempted; Scan now pending (`requested_at > attempted_at`); 24 hours after a
   success (`POSTURE_REFRESH_SECONDS`); 1 hour after an attempt that did not succeed
   (`POSTURE_RETRY_SECONDS`). Success = the save ran after the claim and the catalog read was `ok`.
3. Outside any transaction, in parallel:
   - `deps.posture.querySql` sends `POSTURE_SQL` (`config/posture.ts`) to the read-only SQL
     endpoint (`ownership/client.ts`, `queryReadOnly`).
   - `deps.posture.queryAdvisor` calls the Security Advisor (`posture/advisor.ts`,
     `querySecurityAdvisor`).
4. `parseCatalogRows` and `catalogFindings` (`posture/catalog.ts`) run the six checks.
   `parseLints` and `advisorFindings` keep the Advisor's security lints, with the checked
   metadata of the newer splinter lints (`ADVISOR_METADATA`, issue #134) as evidence and the
   per-lint severity overrides of `LINT_SEVERITY`.
5. `savePostureScan` replaces the findings of each source that succeeded and records each
   source's status. A failed source keeps its last good findings.
6. `raiseForPosture` (`posture/findings.ts`) raises cross-tenant findings on exposed tables. It
   uses the fresh scan, else the stored findings loaded in the poll's first transaction.
   `anonReadableTables` (same file, issue #132) lists the public tables anon can read every row of:
   `rls_disabled` with an anon SELECT grant, `permissive_policy` whose `readExposure` is `anon`
   (stored evidence since #132; older rows are inferred from `roles` and `exposure`), and the
   Advisor's `rls_disabled_in_public` when the catalog did not report the table. The next poll's
   logs query watches anon reads of these tables (`detectors/exposedRead.ts`).
7. The web app reads `postureSummaries` (overview), `getPostureScan` and `listPostureFindings`
   (dashboard and Posture tab). `dedupePosture` hides Advisor lints that repeat a catalog finding
   (for `rls_policy_always_true`, only on the same policy). `postureSummaries` reads just the
   policy and arguments keys of the evidence, so the overview counts what the page shows.
   `fixPrompt` (`posture/fix.ts`) renders each prompt when the page renders.
8. Scan now: `scanNowAction` (`apps/web/app/w/[tenantId]/p/[projectId]/posture/actions.ts`) checks
   `canScan` (owners, admins, editors) in the project transaction, then `requestPostureScan` sets
   `requested_at`. Refused while a request is pending and within 60 seconds of the last attempt.

Severity rules and the Advisor mapping: decision 038, items 4 and 5, and its addendum for the
function and GraphQL checks (#135).

## Intentionally public tables and the RPC burst threshold (#160, decision 045)

- **Intentionally public tables.** The Posture page's "Intentionally public tables" section lists
  the marked tables (with Unmark) and the tables posture shows anyone can read
  (`anonReadableTables`), each with "Mark intentionally public". Owners and Admins only
  (`mark_public`); others see the list and a note. The poller drops marked tables from detector 11's
  watch list before it builds the rollup SQL (`withoutPublicTables` in `posture/findings.ts`), so
  their anon reads are never fetched. On the page, `acceptedAsPublic` turns a marked table's
  read-only findings (RLS off with SELECT-only grants, a SELECT-only read-all policy, the Advisor's
  RLS lint) into "Accepted (intentionally public)" and leaves them out of every count (Posture page,
  dashboard, overview). A finding that also lets the Data API write stays open with a note. Storage:
  `public_tables` (`db/detectionSettings.ts`); every mark and unmark writes a `detection_setting`
  audit row.
- **RPC burst threshold.** `projects.rpc_burst_hits` (default 100, 10 to 10,000), on the project's
  Notifications page next to the email alert threshold; Owners, Admins and Editors change it, as
  they change `email_alerts`. The poller passes it to `detectRpcExposure` through `scan()`; each
  change writes a `detection_setting` audit row with the old and new value.
- Migration `supabase/migrations/20261122150000_project_detection_settings.sql` (Erik applies it).
- Tests: `packages/core/test/exposedRead.test.ts` and `rpcExposure.test.ts` (units),
  `packages/core/test/db/detectionSettings.test.ts` (Postgres: roles in RLS, audit rows, CHECKs,
  cross-tenant foreign key, cascade, overview counts), UAT-D15 and UAT-D16 (whole poll),
  `apps/web/test/detectionSettings.test.ts`, UAT-W51 (`posture.uat.spec.ts`) and UAT-W52
  (`alerts.uat.spec.ts`).

## Data model and RLS

Migration `supabase/migrations/20261112020000_posture_scan.sql` (additive, no DROP):

| Table | Holds |
| --- | --- |
| `posture_scans` | One row per project: `requested_at`/`requested_by` (Scan now), `attempted_at`, `finished_at`, `catalog_status`/`catalog_scanned_at`, `advisor_status`/`advisor_scanned_at`, tables/views/policies checked |
| `posture_findings` | Latest findings per source: `source` (`catalog`/`advisor`), `check_id` (snake_case), `severity`, `schema_name`, `object_name`, `object_type`, `evidence` (structured) |

Both tables: `tenant_id`, forced RLS, `tenant_isolation`, the RESTRICTIVE `project_access` SELECT
policy of decision 036, `(tenant_id, project_id)` foreign keys to `projects` with cascade, and
`posture_findings (tenant_id, scan_id)` to `posture_scans`. Signed-in users may insert or update
`posture_scans` only as the project's owner, admin or editor. Only the poller (no `app.user_id`)
writes, updates or deletes findings and deletes scans. CHECKs refuse free-text check names and
names with control characters. The scheduler role has no grant.

Status codes in `catalog_status` and `advisor_status`: `ok`, `unauthorized` (401/403),
`rate_limited` (429), `unavailable` (404, or the Advisor's `advisor_check_unavailable` lint),
`query_failed` (other HTTP errors), `invalid_response` (no rows or lints array, over the row cap),
`network_error` (timeout, fetch failure).

## External services

- Supabase Management API, `POST /v1/projects/{ref}/database/query/read-only`, scope
  `database:read`. Sends `POSTURE_SQL` only: catalog reads, no table data. 20-second timeout,
  10,000-row cap.
- Supabase Management API, `GET /v1/projects/{ref}/advisors/security` (experimental), scope
  `database:read` (personal tokens: `advisors_read`). 20-second timeout, 2,000-lint cap. Only the
  status leaves the client on an error; the body is never read.
- No new OAuth scope, cron, secret or variable. The poller Worker wires both clients in
  `apps/poller/src/index.ts`.

## Testing

- `packages/core/test/posture.test.ts` (69): every check on fixtures, including RLS on with no
  policies, FORCE and not, views with `security_invoker` true and false, restrictive policies,
  grants; the Advisor client (request shape, every error status, bodies without lints, free
  text dropped, the unavailable lint); dedupe; the severity raise; fix prompts. Issue #134 adds
  9: the 12 newer splinter lints (metadata kept and refused, severities, one finding per policy
  and overload, dedupe on the policy, the raise, a specific fix for each).
- `packages/core/test/db/posture.test.ts` (22, Postgres): first poll, audit before the calls, both
  sources stored; 24-hour refresh; 1-hour retry keeping the last good findings; Advisor failure
  and its unavailable lint; a crash never fails the poll; the raise from a fresh and from a
  stored scan; a table the catalog rates low is not raised even when the Advisor rates it high; no deps, no scan; a scan in the first poll after a pick (`runDuePolls`); Scan now
  (queued, already queued, cooldown, before the first scan); RLS for owner, editor, viewer,
  member without a role and another tenant; findings never writable by signed-in users; CHECKs;
  cross-tenant foreign keys; cascade on removal; `POSTURE_SQL` on a real Postgres 17 catalog,
  including SECURITY DEFINER functions and GraphQL exposure through a stand-in `pg_extension` row (#135);
  the overview counts an Advisor always-true policy the catalog did not flag (#134).
- `isolation.test.ts` and `people.test.ts` list both tables.
- `apps/web/test/posture.test.ts` (10) and `apps/web/test/nav.test.ts`: roles, notices, states, the
  overview line never says "no findings" for a scan that did not run.
- UAT-W29 and UAT-W30 (`apps/web/e2e/specs/posture.uat.spec.ts`) through the fake Management API.
- Mutation checks: see `docs/TESTING.md`.

## Gotchas

- **Not run is not clean.** No catalog read yet = "first scan pending"; failed = "unable to
  assess" with the reason; the Advisor failing alone adds "Security Advisor unable to assess".
  Tested in web units and UAT-W29.
- **A failed source keeps its last good findings.** The page says the results are from the older
  scan. Tested.
- **The upsert's INSERT policy guards Scan now.** For `INSERT ... ON CONFLICT DO UPDATE`, Postgres
  checks the INSERT policy on every call, so a viewer is refused even when the row exists. The
  UPDATE policy guards plain updates. Both tested.
- **Clocks.** `requested_at` comes from the database's `now()`; `attempted_at` from the poller's
  clock. They are the same clock in production. Tests that mix them keep them apart by more than
  a second.
- **Only `public`.** Other schemas are not checked by the catalog SQL, functions included.
- **pg_graphql exposure is broad.** On a default Supabase project every table the API roles can
  read shows in the GraphQL schema, so `graphql_table_exposed` rates medium (anon) or low and never
  raises detections. The Advisor reports the same objects (lints 0026/0027); dedupe shows one.
  Since #157 these findings (and both Advisor lints) are shown and counted only for a role whose
  GraphQL calls the last 7 days of polls counted; otherwise the Posture page hides them with a
  note (decision 038, addendum of #157).
- **Not verified live:** the Advisor's response shape, and `has_table_privilege` for other roles
  as `supabase_read_only_user`. Needs the OAuth app (#4).
