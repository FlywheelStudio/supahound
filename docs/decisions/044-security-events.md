# 044: Supahound's own security events: a table for workspace owners, Workers logs for the rest

Date: 2026-11-22 · Issue #138 · Builds on 004, 036 and 037; related to #20 and #123

## Context

ASVS 16.3.1–16.3.3 and the OWASP Logging Cheat Sheet ask an application to log authentication
successes and failures, authorization failures, privilege changes and admin actions. `audit_log`
holds only what Supahound does to customer projects (queries, model calls, alert emails). Sign-ins,
invites, role changes, connections, project removal, closing a workspace, data deletion, CSRF
refusals, rejected OAuth states and bad Send Email Hook signatures left no structured record.

The issue offered two options: (A) widen `audit_log.action`, or (B) a new `security_events` table.
Erik chose **B**, shown to **workspace owners only**.

## Decision

1. **A new table, `supahound.security_events`** (migration `20261122170000_security_events.sql`):
   `id`, `tenant_id`, `project_id` (nullable), `actor_user_id` (nullable: Supahound itself),
   `action` (CHECK list below), `target_id` (nullable UUID: the person, invite, connection or
   project acted on), `result` (`success`, `denied`, `failed`), `detail` (a small jsonb object),
   `created_at`. `tenant_id` references `tenants`; `(tenant_id, project_id)` references `projects`
   with `ON DELETE SET NULL (project_id)`, as `audit_log` does (decision 022). The actor and target
   have no foreign key, so the record outlives a person who leaves.
2. **Actions:** `sign_in`; `invite_sent` (new, renewed or resent), `invite_accepted`,
   `invite_revoked`; `role_changed`, `member_removed`; `connection_added` (or reattached),
   `connection_removed` (in the app, or revoked at Supabase); `project_added`, `project_removed`
   (scheduled, decision 042), `project_kept`; `workspace_closed`, `workspace_reopened`;
   `data_deleted` (the data job deleted removed projects or a disconnected organization's history).
   A refusal by role is the same action with `result = denied`; an invite saved whose email failed
   is `invite_sent` with `result = failed`.
3. **No personal data in a row.** IDs, enums, counts and flags only: no email, IP, user agent or
   free text. `detail` takes allow-listed keys (`role`, `from`, `kind`, `reason`, `count`,
   `projects`, `reattached`, `revoked`, `method`) whose strings match
   `^[a-z][a-z0-9_]{0,39}$` (`core/db/securityEvents.ts` `safeDetail`), and the database caps the
   object at 512 bytes. The page shows a person's address from `memberships` while they are still
   in the workspace, and a short ID after.
4. **Written in the transaction that makes the change**, through `withTenant` or
   `withTenantForUser`, so a rolled-back change leaves no row and a committed one always has its
   row. The actor is the user from `getClaims()`. RLS (`actor_is_me`) requires the actor to be
   `app.user_id` whenever that is set.
5. **Sign-in** is recorded by `/auth/confirm` after `verifyOtp` succeeds: one row in each workspace
   the user belongs to, in one statement, with only `app.user_id` set. A permissive policy
   (`own_sign_in`) allows exactly that row: action `sign_in`, result `success`, actor = the user,
   no project or target, a workspace the user is a member of. A user with no workspace yet adds
   nothing. Recording is best effort and never blocks the sign-in.
6. **Owners only, in RLS.** A restrictive SELECT policy (`owner_read`) returns rows to a signed-in
   user only when their workspace role is `owner`. Admins and members write events but cannot read
   them, whatever the page does. A transaction without `app.user_id` (the data job) sees the
   tenant, as on every table. The table also carries `project_access` (decision 036).
7. **Append-only for signed-in users.** The app role has no UPDATE grant. DELETE is granted, but a
   restrictive policy (`system_delete`) lets only a transaction without `app.user_id` delete: the
   daily data job and the purge.
8. **Retention follows decision 037.** Kept 90 days (`SECURITY_EVENT_DAYS`); the data job deletes
   older rows only while the workspace does not pay, so a paying workspace loses nothing. The purge
   of a closed workspace deletes them with the other logs and history: they are logs, not the
   record. The page shows the last 90 days.
9. **The page:** Workspace settings → **Security log** (`/w/<tenant>/settings/security`), newest
   first, 50 to a page, keyset paginated by `(created_at, id)` with an epoch-microsecond cursor (as
   incident history, decision 035). Not behind the paid gate, like the rest of workspace settings.
   Others see "Only a workspace owner can see the security log." The audit log page (#20) does not
   show these events.
10. **Events with no workspace go to Workers logs**, one line of JSON:
    `{"event":"security_event","kind":"<enum>", ...}` with fields under the same rules as `detail`.
    Kinds: `csrf_rejected` (with the method), `email_hook_bad_signature`, `oauth_state_rejected`
    (`malformed` or `unknown`), `non_member` (a workspace the user is not in, answered 404),
    `no_project_role` (a project the member has no role on, answered 404), `sign_in_failed` (a link
    that did not verify), `invite_token_invalid` (a token that matches no invite). No user ID, IP,
    address or path. These carry no tenant a customer could be shown, and a 404 must not reveal to
    a workspace that someone probed it.

## Alternatives considered

- **(A) Widen `audit_log.action`.** Rejected by Erik: `audit_log` is what Supahound does to customer
  projects, visible to everyone on the project, and kept forever; security events are about people
  in the workspace, for owners only, and expire.
- **Owners and admins.** Rejected: admins can change roles and invite, so the record of those
  actions should not be readable only by the people it records.
- **Non-member 404s in the workspace's table.** Rejected: the user is not in the workspace, so the
  actor would be a stranger's ID in the customer's log, and a failed probe is ours to watch, not
  the customer's.
- **A SECURITY DEFINER function for sign-in rows.** Rejected for the reason in 036: in Supabase the
  tables' owner is not a superuser and forced RLS gives it no policy. The `own_sign_in` policy
  allows exactly the one row shape instead.

## Consequences

- The migration is additive: one table, two indexes, six policies, a grant. No change to existing
  data. Applying it to a shared database needs Erik's approval (repo rule).
- Every new access or data-changing action should add a security event in the same transaction
  (`recordSecurityEvent`), and a new action needs the CHECK list, `SECURITY_ACTIONS` and a line in
  `apps/web/lib/securityLog.ts` `describeEvent` (the typecheck enforces the last).
- `isolation.test.ts` lists the table and checks its `project_access` policy; the purge test checks
  that it is emptied with the logs.
- The Workers log lines need no new service: Cloudflare Workers Logs already keeps the web app's
  `console.log` output.
