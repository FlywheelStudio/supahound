# Data controls

Issue #43. Decision 037. Builds on decisions 004, 022, 028, 035 and 036.

## What it does

| Control | Who | Where |
| --- | --- | --- |
| Incident retention: 30 days after an incident's last activity | Automatic, daily | Poller data job |
| Disconnect a Supabase organization | Workspace owner or admin | Workspace settings, or the closed page |
| Close the workspace; deleted 30 days later | Workspace owner | Workspace settings |
| Reopen a closed workspace before the purge | Workspace owner | `/w/<tenant>/closed` |
| Email every owner before a new subprocessor | Operator | `pnpm subprocessor-notice` |

The workspace sidebar has a new **Settings** item (`/w/<tenant>/settings`): Supabase connections,
"How long Supahound keeps data", and "Close workspace".

## How it works

### Retention (`packages/core/src/db/retention.ts`)

`applyRetention(tx, now)` runs in one tenant transaction, in this order:

1. Resolve open incidents last seen more than 30 days ago.
2. Delete resolved incidents last seen more than 30 days ago.
3. Delete findings created more than 30 days ago.
4. Delete poll runs started more than 30 days ago, except each project's latest run, its latest
   `ok` run (the next poll window starts at its end) and runs that findings still point at.
5. Delete expired OAuth states.

An open incident is never deleted directly: step 1 resolves it first, and its UPDATE re-checks
`last_seen_at` after any committed poll save. A poll that loaded the incident before the job and
saves after it fails once on the findings foreign key; the queue retry opens a new incident. Not touched: `audit_log` (append-only for the app; its retention
needs its own decision), `project_usage`, `service_role_networks`.

### The daily data job (`packages/core/src/datacontrols/flow.ts`, `apps/poller/src/index.ts`)

- At 00:40 UTC (`DATA_CRON`) the cron, which already runs every minute, lists tenants with
  `dataJobTenants` (scheduler role): every tenant with a project, closed workspaces due for purge,
  and kept records older than 7 years. It enqueues one `{ kind: "data", tenantId }` per tenant.
- The consumer runs `runDataJob(app, tenant, now)` in one `withTenant` transaction: expire a kept
  record, or purge a closed workspace that is due, or run retention. It logs counts only.
- The poller before this change acks a `data` message as invalid (it has no `projectId`), so a mixed
  deploy polls nothing by mistake.

### Closing and the purge (`db/closure.ts`, `datacontrols/flow.ts`)

- `closeWorkspace` (owner only, typed name): reads the subscription; outside any transaction cancels
  it in Stripe (`StripeGateway.cancelSubscription`: at once, `prorate: false`, `invoice_now: false`);
  then in a new transaction saves Stripe's answer and calls `recordClosure`, which inserts the
  `account_closures` row (`purge_after` = closed + 30 days), pauses every project and cancels open
  invites. A Stripe failure closes nothing.
- The gate (`withPaidTenantForUser`) throws `WorkspaceClosedError` before the billing check, in both
  billing modes; `toBillingIfUnpaid` sends it to `/w/<tenant>/closed`. `startCheckout` returns the
  closed page, and `completeVerification` releases the hold and starts no trial for a closed
  workspace. The billing page redirects to the closed page. Invite acceptance gets "canceled".
- `dueProjects` skips any tenant with a closure row; its projects are paused as well.
- `reopenWorkspace` (owner, before `purge_after`): deletes the closure row and unpauses every
  project. The canceled subscription means a paying workspace adds a card again.
- `purgeTenant` (data job, after `purge_after`): copies `stripe_customer_id`, `subscription_id`,
  `terms_version`, `terms_accepted_at`, `card_verified_at` and the scan consents onto the closure row,
  sets `purged_at`, then deletes the `tenants` row. Every other row of the tenant goes through
  `ON DELETE CASCADE`. `expireKeptRecords` deletes the closure row 7 years after the purge.

### Disconnect (`datacontrols/flow.ts`, `supabase/oauth.ts`)

`disconnectConnection` (owner or admin, typed connection name): opens the sealed credentials to get
the refresh token; outside any transaction calls `revokeGrant` (`POST /v1/oauth/revoke`, Beta at
Supabase, best effort); then deletes the `connections` row. The projects watched through it go with
their incidents, findings and poll runs; audit rows stay with a null project (decision 022). The web
action then syncs seats. The page says whether Supabase confirmed the revocation.

### Subprocessor notice (`packages/core/src/notices/subprocessor.ts`, `cli.ts`)

```bash
pnpm subprocessor-notice --name Twilio --purpose "SMS alerts" --location "United States" \
  --effective 2027-03-01 --contact hello@example.com [--policy-url https://…]
# dry run (default): "N recipients", owners with no address; nothing sent, no address printed
# --test-to me@example.com         one copy to one address
# --send --journal notice.journal  every owner, once; re-run resumes from the journal
```

- `noticeProblems`: every field set, effective date at least 30 days away, https policy URL.
- `noticeRecipients(notifier)`: owner addresses, lower-cased, deduplicated across workspaces.
- `cloudflareSender`: the Cloudflare Email Sending REST API, one email per address, reply-to the
  contact. Errors carry status and error codes only.
- The journal holds `sha256(notice key + address)` per sent address, never the address.

## Data model and RLS

Migration `20261112030000_data_controls.sql` (additive):

| Object | Rule |
| --- | --- |
| `account_closures` (PK `tenant_id`, no FK) | `tenant_isolation`; restrictive `closure_insert` (no user, or workspace owner), `closure_update` (no user), `closure_delete` (no user or owner, AND before the purge or 7 years after it). Scheduler reads `tenant_id, purge_after, purged_at` |
| `connections` | Restrictive `connection_remove`: a signed-in user deletes only as workspace owner or admin |
| `tenants` | Restrictive `tenant_purge`: no signed-in user deletes a tenant |
| `supahound_notifier` (NOLOGIN) | `SELECT (tenant_id, role, email)` on `memberships`, policy `role = 'owner'`; nothing else |

`supabase/setup/notifier-user.sql` creates the login for the notifier (not a migration: it takes a
password).

### What the purge keeps

| Kept | Why | For |
| --- | --- | --- |
| Closure dates and who closed | Proof of the closure and the deletion | 7 years |
| Stripe customer and subscription IDs | Tax: the link to Stripe's invoices | 7 years |
| Terms version and acceptance time, card check time | Legal: what the customer agreed to | 7 years |
| Scan consents (domain, terms, email, IP, time) | Legal: proof a scan was allowed (none in production yet) | 7 years |

Outside the database: Stripe keeps the customer and invoices; Supabase Auth keeps the person's
sign-in identity (it may belong to other workspaces). Deleting either is a manual request to support.

## External services

- **Stripe:** `subscriptions.cancel` (`DELETE /v1/subscriptions/:id`) on close. The
  `customer.subscription.deleted` webhook that follows only repeats the saved status.
- **Supabase:** `POST /v1/oauth/revoke` on disconnect, with the OAuth app's client ID and secret.
- **Cloudflare Email Sending REST API:** the notice only, from an operator's machine, with
  `CLOUDFLARE_ACCOUNT_ID` and `CLOUDFLARE_EMAIL_API_TOKEN` (`.env.example`). gitleaks' built-in
  `cloudflare-api-key` rule catches a committed token.
- **Poller:** no new trigger, var or secret.

## Testing

| Suite | Covers |
| --- | --- |
| `packages/core/test/db/dataControls.test.ts` (20, Postgres) | Retention cutoffs to the second, the open-incident rule, findings, poll runs kept, OAuth states, another tenant untouched; close roles, typed name, Stripe once, paused, invites canceled, scheduler skips, gate in both modes, replayed checkout, Stripe failure; reopen; RLS refusals; purge against every catalog table with the other tenant's counts unchanged, the kept record, 7-year expiry; disconnect roles, revoke, projects and audit rows, cross-tenant |
| `isolation.test.ts` | `account_closures` in the table list; scheduler sees closure dates only and skips closed tenants; the notifier reads owner rows and three columns only |
| `db/notices.test.ts` (2), `notices.test.ts` (13) | Recipients deduped, owners only; dry run prints counts only; notice period; HTML escaped; REST request shape and errors; journal; `--test-to`; `revokeGrant` |
| `loginUsers.test.ts` | `notifier-user.sql`: short password refused, one login in one role, safe twice |
| `billing.test.ts` | A checkout begun before closing starts no trial and releases the hold |
| `apps/web/test/dataControls.test.ts` (6) | Roles, redirects, the return target, notices, days left |
| `apps/poller/test/workerd.test.ts` (+3) | 00:40 UTC only; `data` messages routed, never polled; the old consumer ignores them |
| `apps/web/e2e/specs/dataControls.uat.spec.ts` | UAT-W29 to UAT-W33 |

## Gotchas

- **Cascades bypass RLS.** The `connections` and `tenants` delete policies are the database guards
  for what a disconnect or purge removes. `dataControls.test.ts` checks both refusals.
- **Close calls Stripe before the database.** A save that fails after the cancel is safe: the retry
  finds the subscription ended and closes without a second cancel.
- **The settings and closed pages are not behind the paid gate.** ESLint allows `withTenantForUser`
  there only (`webGuard.test.ts`). Every action checks the role inside its own transaction.
- **No code pauses a project for another reason**, so reopen unpauses all. A future pause control
  must remember which projects the closure paused.
- **A reopened paying workspace gets a new 7-day trial** with the current billing flow.
- **Revoke is best effort.** Supabase marks the endpoint Beta; the page tells the owner what to do
  when it does not confirm.
