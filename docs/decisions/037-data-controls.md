# 037: Data controls: retention, closing a workspace, disconnect, subprocessor notice

Date: 2026-11-12 · Issue #43 · Builds on 004, 007, 022, 028, 029, 035 and 036

## Context

The privacy policy promises four things that the product did not do: delete old incidents,
delete a closed account, let a customer disconnect Supabase, and tell customers before a new
subprocessor starts. Erik approved the scope and asked for sensible calls, recorded here.

## Decision

### 1. Retention (daily, tenant by tenant)

The poller's cron enqueues one `data` message per tenant at 00:40 UTC (the cron already fires every
minute). The queue consumer runs `runDataJob` inside `withTenant` for that tenant only. The window is
the history window of decision 035: 30 days after an incident's last activity. In one transaction:

1. An **open** incident last seen more than 30 days ago is **resolved**. The engine resolves an
   incident only when its actor acts again, so a quiet actor leaves it open forever.
2. A **resolved** incident last seen more than 30 days ago is **deleted**.
3. A finding created more than 30 days ago is deleted. No page reads findings; the incident row
   holds the counts the pages show.
4. A poll run started more than 30 days ago is deleted, except the project's latest run, its latest
   successful run (the next poll starts where that one ended) and a run that findings still point at.
5. An expired OAuth state is deleted (it holds a PKCE verifier).

So an open incident is never deleted by `last_seen_at` alone: it is resolved first, and the UPDATE
re-checks `last_seen_at` after any committed poll save, so an incident the poller already updated
stays open. A poll loads open incidents and saves in two transactions; one that loaded an idle
incident before the job and saves after it fails once on the findings foreign key, the queue
retries it, and the retry opens a new incident. Nothing is lost. The
net rule for customers: "an incident is kept for 30 days after its last activity". The dashboard and
the history agree at every step, because both read the same rows.

Not changed by retention:

- **`audit_log`.** One `logs_query` row per poll per project: about 1,440 rows a day, 525,000 a year
  per project. It is append-only for the app (no DELETE grant), so a compromised app cannot erase
  recent rows. A retention window needs a DELETE path that keeps that property, and the window
  should match the audit log page (#20). Deferred to its own decision; the follow-up issue text is in
  the PR for #43.
- **`project_usage`** (one small row per project per day, no personal data) and
  **`service_role_networks`** (detector settings, not history). Both go with the project.

### 2. Closing a workspace

- **Who:** the workspace owner only, after typing the workspace name (decision 022's rule). Admins
  and members cannot. RLS refuses a closure written by anyone else (`closure_insert`).
- **What happens at once:** Stripe cancels the subscription first, at once, with no proration and no
  refund for the current period. Then one transaction saves Stripe's answer, inserts the
  `account_closures` row, pauses every project and cancels open invites. If Stripe fails, nothing is
  closed and the owner can try again. The scheduler skips paused projects (in this code and the code
  before it) and also any tenant with a closure row.
- **Getting back in:** for 30 days every gated page sends members to `/w/<id>/closed`. It shows the
  dates. The owner can reopen; owners and admins can still disconnect Supabase there. Reopening
  deletes the closure row and resumes every project (no code pauses a project for another reason).
  Billing starts from the billing page again: the subscription was canceled, so a paying workspace
  adds a card again, and the current flow then gives a new 7-day trial. A returning customer getting
  a second trial is a known gap for the billing owner to decide.
- **Not behind the paid gate:** the settings and closed pages use `withTenantForUser`, so a workspace
  that does not pay can still disconnect and close. ESLint allows that in those routes only.
- **The purge, 30 days later:** the data job copies the kept records onto the closure row, then
  deletes the `tenants` row. Every other row of the tenant goes with it through the foreign keys:
  connections (and so the sealed tokens), projects, incidents, findings, poll runs, audit log,
  memberships, project roles, invites, OAuth states, scan rows, billing rows, Stripe event IDs, usage.
  RLS allows the tenant delete only from a transaction with no signed-in user (`tenant_purge`).

### 3. What the purge keeps, and why

One `account_closures` row per closed workspace, with no foreign key to `tenants`, so it outlives
the tenant:

| Field | Why |
| --- | --- |
| `tenant_id`, `closed_at`, `closed_by`, `purge_after`, `purged_at` | Proof of when and by whom the account closed and when its data was deleted |
| `stripe_customer_id`, `subscription_id` | Tax: the link to the invoices Stripe keeps for this customer (refunds, chargebacks, audits) |
| `terms_version`, `terms_accepted_at`, `card_verified_at` | Legal: which billing terms the customer accepted and when |
| `scan_consents` | Legal: each security-scan authorization (domain, terms version, email, IP, time), the evidence that a scan was allowed. None exist in production yet |

These rows are kept for **7 years** after the purge, then the data job deletes them. RLS allows that
delete only after 7 years, or before the purge (reopen, owner only).

Outside the database: Stripe keeps the customer and its invoices (Supahound does not delete them).
The person's **Supabase Auth identity** (sign-in email in `auth.users`) stays, because it may belong to
other workspaces and the web app holds no admin key to delete it. A person who wants it deleted
emails support; that is a manual step for now.

### 4. Disconnect

- **Who:** workspace owners and admins (the people who connect Supabase), after typing the
  connection's name. RLS refuses the delete for members (`connection_remove`). Foreign-key cascades
  bypass RLS, so this policy is the database guard on the projects a disconnect removes.
- **What happens:** the `connections` row is deleted, and with it the sealed token and the projects
  watched through it, with their incidents, findings and poll runs. Audit rows stay (decision 022).
  Seats sync after (fewer projects). Polling stops at once: the scheduler no longer sees the projects,
  and a poll already running fails its claim or its token read.
- **At Supabase:** before the delete, outside any transaction, Supahound calls
  `POST /v1/oauth/revoke` with the app's credentials and the refresh token. Supabase marks that
  endpoint Beta, so it is best effort: the page says whether Supabase confirmed it, and if not, tells
  the owner to remove the Supahound app in the Supabase organization's OAuth Apps settings.

### 5. Subprocessor notice

`pnpm subprocessor-notice --name … --purpose … --location … --effective YYYY-MM-DD --contact …`
(core CLI, run by an operator):

- **Safe by default:** without `--send` it prints only the number of recipients and of owners with no
  address on file. Never an address. `--test-to <email>` sends one copy to one address.
- **Notice period:** the effective date must be at least **30 days** away.
- **Recipients:** every workspace owner's address, lower-cased and deduplicated across workspaces.
  Closed workspaces not yet purged are included: Supahound still holds their data. Admins and members
  are not.
- **Reading owners across tenants:** a new role, `supahound_notifier` (decision 004: cross-tenant
  admin work gets its own role). It reads `memberships (tenant_id, role, email)` of owner rows and
  nothing else. Its login is created by `supabase/setup/notifier-user.sql`, outside migrations.
- **Sending:** the Cloudflare Email Sending REST API (decision 014's service, from Node), one email
  per address. `--send` needs `--journal <file>`: a line per address sent, as a SHA-256 hash, so a
  run that stops half way resumes without sending twice.
- **The list itself** is the privacy policy in the private site repo; Erik updates it in the same
  change as the notice.

## Alternatives considered

- **Delete open incidents by `last_seen_at` directly.** Rejected by decision 035's warning; resolving
  first keeps the rule "the job deletes only resolved incidents".
- **Keep findings of an incident still in the window.** Rejected: it breaks "a finding older than the
  window is deleted", and nothing displays findings.
- **Disconnect keeps history** (clear the token, keep the projects). Rejected for now: the sealed
  token column is NOT NULL, a reconnect would need to rebind projects, and removing a project already
  deletes its history (decision 022).
- **Close deletes the tokens at once.** Rejected: reopening would restore an unusable workspace. The
  closed page offers Disconnect for an owner who wants the token gone before the purge.
- **Tombstone the tenant row and delete children one by one.** Rejected: the app has no DELETE grant
  on `audit_log`, `billing_accounts` or `scan_authorizations`, on purpose. The cascade from `tenants`
  reaches all of them, and the kept fields move to a table without the foreign key.
- **Send notices from the poller (Workers email binding).** Rejected: an operator must control
  when a legal notice goes out, with a dry run first. The REST API needs no new Worker config.
- **Give the scheduler role access to owners' emails.** Rejected: the scheduler sees IDs only.

## Consequences

- Migration `20261112010000_data_controls.sql` is additive: a new table, a new NOLOGIN role, new
  policies and grants. It must be applied before this code deploys. The code before it keeps working
  with it applied (develop's unchanged suites pass on it, except the catalog check that lists tables).
- The poller needs no new trigger, var or secret.
- Production needs a `supahound_notifier_login` user (Erik, `supabase/setup/notifier-user.sql`) only
  when the first notice goes out.
- The privacy policy (private site repo) should state the rules above. The `dataControls` flag in the
  site's `content/features.ts` flips to live when this ships.
