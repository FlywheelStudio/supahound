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
