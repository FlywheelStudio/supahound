# Data controls

Issue #43. Decision 037 (with Erik's answers of 2026-11-12). Builds on decisions 022, 028, 029, 030,
035 and 036.

## What it does

| Control | Who | Where |
| --- | --- | --- |
| Retention: 30 days after an incident's last activity; nothing while the workspace pays | Automatic, daily | Poller data job |
| Disconnect a Supabase organization; everyone on its projects gets an email; history kept 30 days | Workspace owner or admin | Workspace settings, or the closed page |
| A grant revoked at Supabase: polling stops, one email, history kept 30 days | Automatic | Poller |
| Reconnect the same organization within 30 days: history back | Workspace owner or admin | Workspace settings → Reconnect Supabase |
| Close the workspace: Stripe cancels at the period end; logs and history go 30 days after it stops paying; the record stays | Workspace owner | Workspace settings |
| Keep a closing workspace open, or reopen a closed one before the purge | Workspace owner | Settings, or `/w/<tenant>/closed` |
| One free trial per workspace and per owner | Automatic | Billing page and Checkout |
| Email every owner before a new subprocessor | Operator | `pnpm subprocessor-notice` |

The workspace sidebar has a **Settings** item (`/w/<tenant>/settings`).

## How it works

### "Paying" (`billing/policy.ts` `payingAccount`, `db/billing.ts` `isPaying`)

Stripe status `active` or `past_due`, or a staff exemption. Every deletion path asks it inside the
transaction that would delete: retention, the purge, the delete after a disconnect.

### The daily data job (`datacontrols/flow.ts` `runDataJob`, `apps/poller/src/index.ts`)

At 00:40 UTC (`DATA_CRON`) the cron lists tenants with `dataJobTenants` (scheduler role: every tenant
with a project, and closed workspaces whose purge date has come) and enqueues `{ kind: "data" }` per
tenant. In one `withTenant` transaction per tenant:

1. `paying = isPaying(tx)`.
2. Closed workspace: paying → `deferPurge` (purge_after ≥ today + 30); not paying and due →
   `purgeHistory` and stop.
3. Disconnected connections: paying → `deferConnectionDeletes`; not paying →
   `deleteExpiredConnections` (cascade to projects and history).
4. `applyRetention(tx, now, { deleteHistory: !paying })`.

The consumer before this change acks a `data` message as invalid (no `projectId`).

### Retention (`db/retention.ts`)

Resolve open incidents idle 30 days; then, only when `deleteHistory`: delete resolved incidents last
seen more than 30 days ago, findings older than 30 days, poll runs older than 30 days except the
latest and latest `ok` run per project and runs findings point at. Always: delete expired OAuth
states.

### Closing (`db/closure.ts`, `datacontrols/flow.ts`)

- `closeWorkspace` (owner, typed name): Stripe `setCancelAtPeriodEnd(id, true)` first; then
  `recordClosure(tx, user, now, accessEndsAt)`: the closure row (`access_ends_at` = period or trial
  end, or now; `purge_after` = that + 30 days), open invites canceled, staff exemption ended.
- The gate throws `WorkspaceClosedError` only once `access_ends_at` has passed (`isClosedNow`); until
  then a banner on the overview and the settings page say when it closes. `dueProjects` skips the
  workspace from then on.
- `reopenClosedWorkspace` (owner, before the purge): resumes a pending Stripe cancel
  (`setCancelAtPeriodEnd(id, false)`), deletes the closure row.
- `purgeHistory` (data job, not paying): sets `purged_at`, then deletes connections (and through them
  projects with incidents, findings, poll runs, networks, usage, roles, invites, posture scans),
  remaining projects, OAuth states and scans. It keeps tenants, memberships, billing accounts, Stripe
  events, audit log, scan domains and authorizations, and the closure row.

### Disconnect and revocation (`db/connections.ts`, `datacontrols/flow.ts`, `datacontrols/email.ts`)

- `markDisconnected(tx, connection, now, reason, by)`: conditional UPDATE (only on a live
  connection) that empties `sealed_token`, sets `disconnected_at`, `disconnect_reason`,
  `delete_after` (+30 days), pauses the connection's projects, and returns the project names and
  `connectionRecipients`. A second call returns null, so nothing is sent twice.
- `disconnectConnection` (owner or admin, typed name): reads the refresh token, calls `revoke`
  (best effort) outside any transaction, then `markDisconnected` with reason `user`; a connection
  with no project is deleted at once. The web action sends `sendDisconnectEmails` through the
  Workers email binding and syncs seats (paused projects are not billed).
- Revocation: in `pollProject`, a token error for which `isRevokedGrant` is true finishes the run as
  `grant_revoked`, calls `markRevoked` (reason `revoked`) and, for the first worker only, sends the
  email through the alert path (`deps.alerts`). Counts go to the audit log (`alert_email`, kind
  `disconnected` or `access_revoked`).
- `storeConnection` (OAuth callback): when the new grant lists a project ref that a disconnected
  connection still watches, the token goes into that connection, its projects resume, and the
  workspace shows "Supabase reconnected". Otherwise a new connection.
- `listConnections` and `countConnections` return live connections only, so no page or picker reads
  an emptied token.

### One free trial (`db/billing.ts` `trialAvailable`, `billing/flow.ts`)

`startCheckout` computes `trialAvailable(tx, user)`: false when this workspace has a validated card or
a trial end, or when the user owns another workspace that had one (read through
`owner_trial_history`). The Checkout Session carries `metadata.trial`; `completeVerification` creates
the subscription with a trial only when the session allows it and the workspace check still passes.
The billing page and Checkout's text (`termsText(trial)`) say when there is no trial.

### Subprocessor notice (`notices/subprocessor.ts`, `cli.ts`)

```bash
pnpm subprocessor-notice --name Twilio --purpose "SMS alerts" --location "United States" \
  --effective 2027-03-01 --contact hello@example.com [--policy-url https://…]
# default: counts only; --test-to me@example.com: one copy; --send --journal notice.journal: every owner, once
```

## Data model and RLS

Migration `20261112030000_data_controls.sql` (additive, no DROP):

| Object | Rule |
| --- | --- |
| `account_closures` (PK and FK `tenant_id`) | `tenant_isolation`; restrictive `closure_insert` (no user, or workspace owner), `closure_update` (no user), `closure_delete` (workspace owner, before the purge). Scheduler reads `tenant_id, access_ends_at, purge_after, purged_at` |
| `connections` | New nullable `disconnected_at`, `disconnected_by`, `disconnect_reason`, `delete_after`; check `connections_disconnect_shape` (all set together, and a disconnected token is empty); restrictive `connection_write` (UPDATE) and `connection_remove` (DELETE): no user, or workspace owner or admin |
| `tenants` | Restrictive `tenant_keep`: no delete, ever |
| `billing_accounts` | Permissive `owner_trial_history` (SELECT): a signed-in owner sees the billing rows of workspaces they own |
| `supahound_notifier` (NOLOGIN) | `SELECT (tenant_id, role, email)` on `memberships`, policy `role = 'owner'` |

Policies are created in a DO block that checks `pg_policies`, so the file runs twice safely.

## External services

- **Stripe:** `subscriptions.update(id, { cancel_at_period_end })` on close and keep-open; a
  subscription without `trial_period_days` when no trial is allowed; `metadata.trial` on the
  Checkout Session.
- **Supabase:** `POST /v1/oauth/revoke` on disconnect; `GET /v1/projects` at the OAuth callback (the
  reconnect match); the token endpoint's `invalid_grant` is the revocation signal.
- **Email:** the Workers `send_email` binding for disconnect (web) and revocation (poller) emails;
  the Cloudflare Email Sending REST API for the operator's notice CLI.
- No new trigger, var or secret on either Worker.

## Testing

| Suite | Covers |
| --- | --- |
| `packages/core/test/db/dataControls.test.ts` (Postgres) | Retention cutoffs and rules; no deletes for active, past_due and exempt workspaces, deletes for trialing ones; close at the period end (usable and polled until then, closed after), billing off and exempt close at once; Stripe failure; keep open and reopen; tenant row and purged closure never deleted; the purge against every catalog table (history gone, record kept, other tenant unchanged); no purge while paying, purge 30 days after; disconnect roles, empty token, polling stops, recipients, zero-project delete, 30-day delete, kept while paying, reconnect keeps history, cross-tenant; revocation on `invalid_grant` emails once, transient and misconfiguration errors do not count |
| `isolation.test.ts` | New table in the list; scheduler reads closure dates only and skips closed workspaces; notifier reads owner rows and three columns only |
| `billing.test.ts` | One trial per workspace; none for an owner who had one; a checkout begun before closing starts no trial |
| `oauth.test.ts`, `billing/policy.test.ts` | `isRevokedGrant` classification; `payingAccount` |
| `notices.test.ts`, `db/notices.test.ts`, `loginUsers.test.ts` | The notice CLI, recipients, `notifier-user.sql` |
| `apps/web/test/dataControls.test.ts`, `connect.test.ts` | Roles, redirects, notices, connection state; the reconnected redirect |
| `apps/poller/test/workerd.test.ts` | 00:40 UTC; `data` messages routed, never polled; the old consumer ignores them |
| `apps/web/e2e/specs/dataControls.uat.spec.ts` | UAT-W31 to UAT-W37 |

## Gotchas

- **Cascades bypass RLS.** `connection_remove`, `connection_write` and `tenant_keep` are the database
  guards for what a disconnect or purge reaches.
- **Stripe before the database** on close and reopen. A failed Stripe call changes nothing.
- **The settings and closed pages are not behind the paid gate** (ESLint allows `withTenantForUser`
  there only), so a workspace that does not pay can still disconnect and close.
- **Paying workspaces keep every poll run.** `poll_runs` grows by about 1,440 rows per project per
  day while a workspace pays, and `audit_log` by as much for every workspace. Both need a roll-up or
  retention decision later.
- **The revocation email is sent once.** A failed send is counted in the audit log and not retried.
- **A new sign-in email gets around the per-owner trial rule.** A card-fingerprint check needs data
  across tenants.
- **No code pauses a project except a disconnect.** A future pause control must not be undone by a
  reconnect.
