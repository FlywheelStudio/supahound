# 038: Posture scan V1: catalog checks plus the Security Advisor, inside the poll

Date: 2026-11-12 · Issue #11 · Builds on 024 (read-only SQL in the poll) and 036 (project roles)

## Context

Issue #11 answers "am I exposed?" within 2 minutes of a project pick. It asks for four checks:
Security Advisor findings, tables without RLS, `USING (true)` policies, and views without
`security_invoker`. The scan runs daily and on demand. Posture findings raise the severity of
detections on the same table. Fix prompts come from templates and structured evidence only.
Erik approved the scope and asked for the calls below to be made and recorded without a round trip.

## Decision

1. **Where and when.** `pollProject` runs the scan after the token opens and the ownership
   refresh, and before the logs query, so a logs outage never blocks it. A scan is due when it
   was never attempted, a "Scan now" is pending, the last success is 24 hours old, or the last
   attempt that did not succeed is 1 hour old. The cron enqueues a new project on its next
   minute, so the first findings land within about 2 minutes of the pick. No new cron or queue
   message. A scan never fails the poll.
2. **Two sources, both read-only, in parallel.**
   - *Catalog*: `POSTURE_SQL` on `POST /v1/projects/{ref}/database/query/read-only` (decision 024's
     client). It reads `pg_class`, `pg_policy`, `pg_policies` and `has_table_privilege` for `anon`
     and `authenticated`. No table data.
   - *Security Advisor*: `GET /v1/projects/{ref}/advisors/security`. The Management API reference
     marks it experimental. OAuth scope `database:read`, already in the grant (decisions 012, 023);
     a personal token needs `advisors_read`.
   All endpoint, SQL and lint knowledge lives in `packages/core/src/config/posture.ts`.
3. **Schema scope: `public` only**, the schema the Data API serves by default and the one
   ownership reads. Advisor lints on other schemas are kept as the Advisor reports them.
4. **Catalog checks and severities.** Exposure comes from the API roles' grants.

   | Check | Rule | Severity |
   | --- | --- | --- |
   | `rls_disabled` | Table with RLS off | anon has a grant: critical; authenticated only: high; neither: low |
   | `rls_no_policies` | RLS on, no policy (deny-all for the API) | low |
   | `permissive_policy` | Permissive policy whose USING or WITH CHECK is `true` for anon, authenticated or public, on a table with RLS on, and no restrictive policy still filters that command | a write open to anon: critical; to authenticated: high; a read open to anon: medium; otherwise low |
   | `view_not_invoker` | View without `security_invoker` true | anon can read: high; authenticated: medium; neither: low |

   FORCE ROW LEVEL SECURITY is evidence only. API roles are not table owners, so FORCE changes
   nothing for them.
5. **Advisor lints.** Only lints whose categories include `SECURITY`. Stored: the lint name (a
   snake_case enum), its level, the object type (an enum) and the schema and object names.
   Never stored: `title`, `description`, `detail`, `remediation`. ERROR → high, WARN → medium,
   INFO → low. A lint name outside the 45 in the reference is kept when it is plain snake_case,
   with a generic fix prompt. An HTTP error, an unreadable body or the Advisor's own
   `advisor_check_unavailable` lint is "unable to assess" for the source, never zero findings.
   An Advisor lint that repeats a catalog finding on the same object is hidden when read
   (`rls_disabled_in_public` and `policy_exists_rls_disabled` → `rls_disabled`,
   `rls_enabled_no_policy` → `rls_no_policies`, `security_definer_view` → `view_not_invoker`).
   *Amended by issue #134 (2026-11-22):* the 12 newer security lints of splinter, the Advisor's
   lint source (0019 to 0032), are known by name, each with its own fix prompt.
   `rls_policy_always_true` → `permissive_policy`, matched on the policy name. A few lints carry
   structured metadata (policy name and command, a function's identity arguments, SECURITY
   DEFINER, sensitive column names, a foreign key or extension name, versions); each value is
   checked as a catalog name, an enum, a boolean or a version before it is stored as evidence.
   Severity overrides: `sensitive_columns_exposed` critical, `rls_policy_always_true` high,
   `anon_security_definer_function_executable` high, `anon_dynamic_sql_function_executable`
   critical (ERROR) or high (WARN), `pg_graphql_authenticated_table_exposed` low. A table lint at
   high or above raises detections as in item 7; the function lints have no table to raise.
6. **Storage.** `posture_scans`, one row per project (request, attempt, status and time per
   source, counts). `posture_findings`, the latest result per source. A source that succeeds
   replaces its rows; a source that fails keeps its last good rows and records an error code,
   as decision 024 does for ownership. No scan history.
7. **Severity raise.** A cross-tenant (detector 2) finding on a `public` table with a posture
   finding at high or above goes up one step, capped at critical. It gains the signal
   `posture_exposed` and `evidence.postureCheck`. The raise uses the fresh scan, else the stored
   findings. Service-role findings are not raised: the service key bypasses RLS, so a table's
   posture changes nothing about them.
8. **Fix prompts** (`posture/fix.ts`) are templates filled from the check, the quoted
   identifiers, enums and counts. The owner column in examples is the placeholder `user_id`.
   Names longer than 63 characters or with control characters are dropped at parse time and
   refused by a CHECK, so no name can break out of a SQL comment line.
9. **Scan now.** The project's owners, admins and editors (the `edit_settings` row of decision
   036's matrix). Refused while a request is pending, and within 60 seconds of the last attempt.
   The next poll runs it. RLS on `posture_scans` enforces the same roles.
10. **Audit.** The claiming transaction writes one `policies_query` audit row with
    `purpose: posture_scan`, the SQL's SHA-256 and `security_advisor: true`, before either call.
    A new audit action would need `DROP CONSTRAINT` on `audit_log_action_check`; this keeps the
    migration free of DROP statements.

## Alternatives considered

- **A separate cron or queue message for posture.** A second claim and consumer for no gain
  over the poll's existing claim (decision 024 made the same call).
- **Reuse the ownership policy read.** It reads `pg_policies` only, and the ownership tests count
  its calls. One more query per day per project is cheap.
- **Store the Advisor's text.** It is free text from outside Supahound; the evidence rule allows
  structured features only.
- **Keep every scan.** Not needed for V1; the latest result plus per-source status answers the
  question. A history table can come later.
- **A new `posture_scan` audit action.** Needs a DROP CONSTRAINT in production (manual
  confirmation). Rejected for now.
- **`posture_requested_at` on `projects`.** Reuses the settings policy, but changes a table the
  old code reads. A new table keeps the migration purely additive.
- **Report RLS-on-but-not-FORCED tables.** Every Supabase table would show it, and it does not
  affect API roles.

## Consequences

- Migration `20261112020000_posture_scan.sql` adds two tables, their policies and grants. It is
  additive and has no DROP. The code before this change never reads the new tables.
- A paused or unpaid project never scans; its last result stays.
- Not verified live: the Advisor's response shape (experimental), and that
  `supabase_read_only_user` may call `has_table_privilege` for other roles. Both need the OAuth
  app (#4). A failure shows as "unable to assess", never as clean.
- Scan now waits for the next poll: up to about 2 minutes.

## Addendum: function and GraphQL catalog checks (issue #135, 2026-11-22)

The Advisor is experimental. When it fails, nothing checked RPC or GraphQL exposure, because the
catalog checks covered only tables, views and policies. Two catalog checks now port splinter's
lints 0026 to 0029 (PostgreSQL License, attributed in `config/posture.ts`).

- **`POSTURE_SQL`** gains four columns and one row kind. `graphql_roles` on table and view rows:
  NULL unless `pg_graphql` is in `pg_extension`; then the API roles with SELECT on any column
  (`has_column_privilege`, so column grants count), for relkinds `r` and `v` only (pg_graphql does
  not expose partitioned roots). Kind `function`: one row per SECURITY DEFINER function in
  `public`, with `grants` as `anon:EXECUTE,authenticated:EXECUTE` (`has_function_privilege`,
  PUBLIC included), `security_definer`, `search_path_set` (`proconfig` pins `search_path`) and
  `arguments` (`pg_get_function_identity_arguments`, at most 512 characters, no control
  characters, else the row is dropped). Still catalog reads only; no function bodies.
- **Checks.**

  | Check | Rule | Severity |
  | --- | --- | --- |
  | `function_definer_exposed` | SECURITY DEFINER function in `public` that an API role can EXECUTE | anon: high; authenticated only: medium |
  | `graphql_table_exposed` | pg_graphql installed and an API role can SELECT a column of the table or view | anon: medium; authenticated only: low |

  Evidence: exposure, the roles, and for functions the identity arguments and whether
  search_path is pinned. Neither check raises detections: detectors never name a function, and
  GraphQL introspection shows a shape, not rows.
- **Dedupe.** `anon_`/`authenticated_security_definer_function_executable` →
  `function_definer_exposed`; `pg_graphql_anon_table_exposed` and
  `pg_graphql_authenticated_table_exposed` → `graphql_table_exposed`.
- **Fix prompts.** `REVOKE EXECUTE ON FUNCTION <name>(<arguments>) FROM PUBLIC, <roles>`, a commented
  `SECURITY INVOKER` alternative, and `SET search_path = ''` when it is not pinned. For GraphQL,
  `REVOKE SELECT ... FROM <roles>` (which also ends REST reads by them) or, commented, revoking
  `graphql.resolve`.
- **Not ported:** splinter 0031/0032 (dynamic SQL in function bodies). They parse `prosrc` with
  regular expressions; the Advisor still reports them.
- **Not verified live:** that `supabase_read_only_user` may call `has_function_privilege` and
  `has_column_privilege` for other roles (any role may, in stock Postgres), as for item 2.

## Addendum: GraphQL findings gated on GraphQL traffic (issue #157, 2026-11-22)

On a default Supabase project pg_graphql shows every table the API roles can read, so
`graphql_table_exposed` (and the Advisor's `pg_graphql_anon_table_exposed` /
`pg_graphql_authenticated_table_exposed`) fire once per table and flood the Posture page of a
project that never uses GraphQL. Erik's decision 7C on #131: report them only where the logs show
GraphQL traffic from that role.

- **Counting.** The poll's count query (`pollCountSql`, the request count of #133 plus two
  `countIf`s) counts the window's `/graphql/v1` calls whose effective role is anon, and those
  whose role is authenticated. Request bodies are not in edge logs, so counts are all there is. They
  are stored on the run (`poll_runs.graphql_anon_calls`, `graphql_authenticated_calls`, migration
  `20261122160000`); NULL when not counted. No new table, so no new tenant rules.
- **Gate.** A GraphQL finding is about the roles in its evidence (catalog: `roles`, else
  `exposure`; Advisor: the role in the lint's name). It is shown when any of those roles has a
  count above zero in the project's runs started in the last 7 days (`GRAPHQL_ACTIVITY_DAYS`).
  Otherwise it is kept, stored and fixable, but hidden: the Posture page says how many are hidden
  and why, the overview and project counts leave them out, and they raise no severity
  (`postureExposedTables`). The gate runs after dedupe, on read only: scans store what they find.
- **No counts reads as no traffic.** A deployment that does not count (`countRequests` off: tests,
  the CLI), or runs that predate the migration, hide the GraphQL findings. The poller Worker counts.
- **Why 7 days.** Long enough to catch a weekly job or a quiet app, short enough that a project
  that stopped using GraphQL drops the noise within a week. One constant.
- Hiding is not suppression: the objects remain visible through GraphQL introspection to any
  caller. A first GraphQL call shows the findings from the next page load.
