# WIP: Data controls (#43)

Branch `feature/data-controls`. Decision 037.

## Goal

Supahound does what its privacy policy promises about data: incident retention, account closure
with a 30-day purge, Supabase disconnect, and a notice to owners before a new subprocessor.

## Approach

- Migration `20261112010000_data_controls.sql`: table `account_closures`, role `supahound_notifier`,
  restrictive policies on `connections` (delete: owner/admin), `tenants` (delete: no signed-in user),
  `account_closures` (owner only).
- Core: `db/retention.ts` (retention rules), `db/closure.ts` (close, reopen, purge),
  `datacontrols/` (close flow with Stripe cancel, disconnect with best-effort revoke, daily job),
  `notices/` (subprocessor notice: recipients, email, REST sender), CLI `subprocessor-notice`.
- Poller: a daily data job per tenant at 00:40 UTC (retention, purge, expired records).
- Web: workspace Settings page (connections + Disconnect, Close workspace), `/closed` page with
  Reopen, the gate sends closed workspaces to `/closed`.

## Build log

- 2026-11-12: Migration written. Production-safety check: develop's unchanged suites against the
  new schema. Core: 588 of 589 pass; the 1 failure is the catalog check in `isolation.test.ts`, which
  lists the schema's tables by name (a new table always fails it). Web 127/127, poller 12/12.
