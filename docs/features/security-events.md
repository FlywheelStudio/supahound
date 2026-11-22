# Security events

Issue #138. Decision [044](../decisions/044-security-events.md). ASVS 16.3.

## What it does

Supahound records who changed access to a workspace or its data, and whether it worked. Workspace
owners read the record on **Workspace settings → Security log** (`/w/<tenant>/settings/security`):
the last 90 days, newest first, 50 to a page. Admins and members see "Only a workspace owner can see
the security log." and RLS gives them no rows.

| Event | Where it is written | Results |
| --- | --- | --- |
| `sign_in` | `/auth/confirm` after `verifyOtp`, one row per workspace of the user (`recordSignIn`) | success |
| `invite_sent` (`kind`: created, renewed, resent) | People page actions | success, denied (role), failed (email) |
| `invite_accepted` | `core/db/people.ts` `acceptInvite` | success, denied (expired, used, canceled, wrong_email) |
| `invite_revoked` | People page: Cancel | success, denied |
| `role_changed` (`role`, `from`) | People page: role select | success, denied |
| `member_removed` (`role`) | People page: Remove | success, denied |
| `connection_added` (`reattached`) | Supabase OAuth callback | success |
| `connection_removed` (`reason`: user or revoked; `projects`; `revoked`) | `disconnectConnection`; `markRevoked` in the poller | success, denied |
| `project_added` | Project picker | success, denied |
| `project_removed`, `project_kept` | Projects page and Plan & billing | success, denied |
| `workspace_closed`, `workspace_reopened` | `closeWorkspace`, `reopenClosedWorkspace` | success, denied |
| `data_deleted` (`kind`: removed_projects or disconnected_connections; `count`) | `runDataJob` | success |

Every row is written in the same transaction as the change, so it commits or rolls back with it.
Rows hold user IDs, enums, counts and flags: never an email, IP, user agent or free text.

Events with no workspace go to Workers logs as `{"event":"security_event","kind":"<enum>"}`:
`csrf_rejected` (middleware, with `method`), `email_hook_bad_signature`, `oauth_state_rejected`
(`reason`: malformed or unknown), `non_member` (`withTenantForUser`), `no_project_role`
(`paidProject`, `loadProjectPage`), `sign_in_failed`, `invite_token_invalid`.

## How it works

- **Code:** `packages/core/src/db/securityEvents.ts` holds the action list, `safeDetail` (the
  allow-list), `recordSecurityEvent`, `recordSignIn`, `listSecurityEvents` (keyset),
  `deleteExpiredSecurityEvents` and `logSecurityEvent`. `apps/web/lib/securityLog.ts` holds the
  page's cursor, the owner check and the text for each event.
- **RLS** (migration `20261122170000_security_events.sql`): `tenant_isolation`; `own_sign_in` (a
  user with no tenant set may add only their own `sign_in` row to their own workspaces);
  `owner_read` (signed-in readers must be workspace owners); `project_access` (decision 036);
  `actor_is_me` (the actor is `app.user_id` when set); `system_delete` (only transactions without
  `app.user_id` delete). No UPDATE grant.
- **Retention:** the daily data job deletes rows older than 90 days while the workspace does not
  pay (decision 037); the purge of a closed workspace deletes them all.

## Tests

| Test | Checks |
| --- | --- |
| `packages/core/test/db/securityEvents.test.ts` | Owner-only reads by RLS; admins and members write only as themselves; no cross-tenant insert; no UPDATE, no DELETE by signed-in users; CHECK constraints; sign-in rows only in the user's workspaces and only that row shape; keyset pages with microsecond ties and the 90-day window; addresses come from `memberships`, never the row; retention only while not paying; disconnect and invite acceptance record their outcomes; `safeDetail` and log lines refuse emails, IPs and user agents |
| `packages/core/test/db/isolation.test.ts` | The table is in the catalog with forced RLS and `project_access`; each tenant sees only its rows |
| `packages/core/test/db/dataControls.test.ts` | The purge empties it (it is not in the kept list) |
| `apps/web/test/securityLog.test.ts` | Owner check, cursor, a sentence for every action, result labels; rejected OAuth state and bad hook signature log one JSON line with no personal data |
| UAT-W51 (`apps/web/e2e/specs/securityLog.uat.spec.ts`) | The owner reads a member's sign-in and an invite in the log; the member gets no log and no link; rows hold no address |
