# 037: Data controls: nothing deleted while paying, close at the period end, disconnect, one trial

Date: 2026-11-12 · Issue #43 · Builds on 004, 007, 022, 028, 029, 030, 035 and 036

## Context

The privacy policy promises that Supahound deletes old incidents and closed accounts, lets a
customer disconnect Supabase, and tells customers before it adds a subprocessor. A first version
of this record (same PR, not merged) deleted a closed workspace entirely and canceled Stripe at
once. Erik answered on 2026-11-12:

> "When a space is closed, remove the logs and history, but never the record or payment history.
> Cancel stripe at the end of the billing period. No second free trials. Disconnecting should
> delete the history as above but if it's disconnected outside of supahound send an alert email.
> Send them notifications that it's disconnected. Store for 30 days then delete."
>
> "Unless they're still paying, then never delete data for a paid customer."

## Decision

### 1. "Paying" — one definition for every deletion

A workspace **pays** when its Stripe status is `active` or `past_due`, or it has a staff exemption
(decision 029). `billing/policy.ts` `payingAccount` is the only definition; `db/billing.ts`
`isPaying` reads it inside the transaction that would delete.

- Stripe keeps `active` until the end of a period that a closing owner canceled, so the paid time
  after a close counts.
- `past_due` counts: Stripe still retries the payment (the grace of decision 028).
- An exemption counts, because keeping data is the reversible choice. Closing a workspace ends its
  exemption (the owner said they are done).
- A trial that never paid does not count. A self-hosted copy with billing off does not count.

**While a workspace pays, Supahound deletes none of its data.** (One exception since
[042](042-project-removal-grace.md): a removed project is deleted 7 days after its own paid period
ends, even while the workspace pays.) The daily job resolves idle
incidents (that deletes nothing) and deletes expired OAuth states (PKCE verifiers, not customer
data), and nothing else. Every pending delete (a purge, a disconnected connection's history) moves
to 30 days after the day the job runs, so it happens 30 days after the last paid day.

### 2. Retention (daily, tenant by tenant, workspaces that do not pay)

The poller's cron enqueues one `data` message per tenant at 00:40 UTC (the cron already fires every
minute). The consumer runs `runDataJob` in one `withTenant` transaction for that tenant only:

1. Resolve open incidents last seen more than 30 days ago (the engine never resolves a quiet actor).
2. Delete resolved incidents last seen more than 30 days ago.
3. Delete findings created more than 30 days ago (no page reads findings).
4. Delete poll runs started more than 30 days ago, except each project's latest run, its latest
   `ok` run (the next window starts at its end) and runs that findings still point at.
5. Delete expired OAuth states.

An open incident is never deleted directly: step 1 resolves it first, and its UPDATE re-checks
`last_seen_at` after any committed poll save. A poll that loaded the incident before the job and
saves after it fails once on the findings foreign key; the queue retries it and opens a new incident.

Not deleted: `audit_log` (append-only for the app; about 1,440 `logs_query` rows a day per project,
so it needs its own decision with the audit log page, #20), `project_usage` (one small row per
project per day) and `service_role_networks` (settings).

### 3. Closing a workspace

- **Who:** the workspace owner only, after typing the workspace name. RLS refuses a closure from
  anyone else (`closure_insert`).
- **Stripe:** the subscription gets `cancel_at_period_end` (no refund, nothing more charged). Stripe
  is called first; if it fails, nothing is closed.
- **Until the period ends** (`access_ends_at`, the period or trial end; the close time when nothing
  is paid or billing is off), the workspace works and polls as before. A banner and the settings page
  say when it closes; the owner can keep it open (the Stripe cancel is undone).
- **After that**, every gated page sends members to `/w/<id>/closed`, the poller skips the
  workspace, and the owner can reopen until the purge. Reopening after the subscription ended
  sends the owner to Billing for a new card, with no trial.
- **The purge** runs when the workspace does not pay and `purge_after` has come: 30 days after
  `access_ends_at`, moved later while it pays. It deletes the **logs and history**: Supabase
  connections (sealed tokens) and through them every project with its incidents, findings, poll
  runs, service-key networks, usage, project roles, invites and posture scans; OAuth states; scans
  with their findings and jobs.
- **Never deleted — the record and payment history:** the `tenants` row (RLS `tenant_keep` refuses
  every delete), memberships (so members can still open the closed page), `billing_accounts` and
  `stripe_events`, `audit_log` (rows lose their project link, decision 022), scan domains and
  authorizations (the consent record), and the `account_closures` row (only a reopen before the
  purge deletes it). The first version's 7-year expiry is gone: these rows are kept.
- Outside the database, Stripe keeps the customer and invoices, and Supabase Auth keeps the
  person's sign-in identity (it may belong to other workspaces; the app holds no admin key). Both
  are deleted only on request, by hand.

### 4. Disconnect in Supahound

- **Who:** workspace owners and admins, after typing the connection's name. RLS refuses the update
  and the delete for members (`connection_write`, `connection_remove`).
- **At once:** the sealed token is emptied (zero bytes), the connection's projects pause, so polling
  stops; Supahound asks Supabase to revoke the grant (`POST /v1/oauth/revoke`, Beta, best effort; the
  page says whether Supabase confirmed it).
- **Email:** every person with a role on the affected projects (decision 036's alert recipients:
  workspace owners and admins, and the projects' people) gets one email: who disconnected, when,
  which projects, and when the history is deleted (or that it is kept while the workspace pays).
- **History:** kept 30 days (`delete_after`), longer while the workspace pays; then the data job
  deletes the connection and, by cascade, its projects and their history. Audit rows stay. A
  connection with no project has nothing to keep and goes at once. Paused projects are not billed.
- **Reconnecting the same organization keeps the history.** Matching rule: at the OAuth callback,
  Supahound lists the new grant's projects; a disconnected connection of this workspace that still
  watches one of those project refs is the same organization (a Supabase project belongs to exactly
  one organization). The new token goes into that connection, its projects resume, and several such
  connections merge into the most recent one. The org ID was the other candidate, but connections
  stored before this change do not hold it, and the project list needs no new scope. If the list
  fails, a new connection is stored and nothing is taken back.

### 5. A grant revoked outside Supahound

- **Signal:** the token endpoint answers a refresh with the OAuth error `invalid_grant` (RFC 6749
  5.2), HTTP 400 or 401 (`supabase/oauth.ts` `isRevokedGrant`). Not a revocation: a 5xx, a timeout
  or a network error (transient); `invalid_client` (our own client secret is wrong, which must never
  cost a customer their tokens); a 401 without a code; a Management API 401 alone (an access token
  can lapse while the grant lives; the next refresh decides, within the hour).
- **Then:** the poller marks the connection exactly as a disconnect (reason `revoked`) in a
  conditional UPDATE, so only the first worker succeeds and only it sends the email: "Supahound lost
  access … reconnect within 30 days". The same 30-day keep (or keep while paying) follows. A failed
  send is counted in the audit log and not retried.

### 6. One free trial

- **Per workspace:** a workspace that has had a validated card or a trial never gets another trial
  (`card_verified_at` or `trial_end` set). A reopened workspace is included.
- **Per owner:** none when the user adding the card owns another workspace that had one. The check
  reads the user's other workspaces through a new read policy (`owner_trial_history`: a signed-in
  owner sees the billing rows of workspaces they own). The decision travels in the Checkout Session
  metadata (`trial`, set by our server) and the workspace check runs again when the subscription is
  created. Without a trial, the subscription starts paid at once, and our page and Checkout say so.
- **Not built:** a check on the card itself (Stripe's card fingerprint) needs data across tenants. A
  person with a new sign-in email and a new card gets a trial.

### 7. Subprocessor notice

`pnpm subprocessor-notice` (core CLI, run by an operator): counts by default and prints no address;
`--test-to` sends one copy; `--send --journal` emails each workspace owner once (deduplicated,
lower-cased), including closed workspaces not yet purged. The effective date must be at least 30
days away. Owners are read through `supahound_notifier` (owner rows of `memberships`, three columns,
nothing else; decision 004). Sending uses the Cloudflare Email Sending REST API (decision 014's
service). The subprocessor list is the privacy policy in the private site repo.

## Alternatives considered

- **Delete the tenant row and cascade** (the first version). Rejected by Erik: the record and the
  payment history stay.
- **Cancel Stripe at once.** Rejected by Erik: the customer paid for the period.
- **Delete history by the calendar even while paying.** Rejected by Erik: never delete a paying
  customer's data.
- **Treat a Management API 401 as a revocation.** Rejected: an expired access token gives the same
  answer; deleting a live customer's token on that would be worse than detecting late.
- **Match a reconnect by organization ID.** Possible, but old rows lack it; the project ref match
  works for every row.
- **Send notices from the poller.** Rejected: an operator decides when a legal notice goes out,
  with a dry run first.

## Consequences

- Migration `20261112030000_data_controls.sql` is additive: a new table, new nullable columns, a new
  check that existing rows meet, a new NOLOGIN role, new policies and grants. It has no DROP and
  changes no data. It runs after `20261112020000_posture_scan.sql`.
- The poller needs no new trigger, var or secret. The web app needs none either.
- A paying workspace keeps every poll run and finding: `poll_runs` grows by about 1,440 rows per
  project per day for as long as it pays. A later decision may roll old runs up instead.
- The privacy policy should state these rules. The `dataControls` flag in the site's
  `content/features.ts` flips to live when this ships.
