# WIP: Tenant isolation (multi-tenant storage, vault, poller)

Goal: Guardbase runs many tenants (agencies, builders), each with many Supabase projects. No code
path may read, write, decrypt or mix one tenant's data with another's.

## Status — 2026-10-27

- Built: scope keys, schema + RLS, vault, repositories, poller, scheduler, worker. 19 Postgres
  tests (isolation + poller) pass on a throwaway Postgres 17 cluster.
- **Next step:** pick the Postgres host, create the two login roles, apply
  `migrations/0001_tenancy.sql`, then run `pnpm worker` against one project. Applying the
  migration to a shared database needs Erik's approval.
- Not built: ownership refresh from `pg_policies`, OAuth connect and token refresh, stuck-run
  cleanup. See STATE.md backlog.

## Tenancy model

- **Tenant** = one Guardbase account (an agency or a builder).
- **Connection** = one Supabase OAuth grant held by a tenant. Tokens live here, not per project:
  the Supabase docs do not say whether a token covers one organization or named projects, and a
  refresh may rotate it.
- **Project** = one Supabase project under a connection. The same Supabase ref may sit under two
  tenants (an agency and its client). Each gets separate rows, tokens and state.
- Every row carries `tenant_id`. Every child references its parent through a composite key
  `(tenant_id, id)`, so a row cannot point at another tenant's parent.

## Isolation layers

1. Postgres RLS, forced, on every table: `tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid`.
   The app role is `NOSUPERUSER NOBYPASSRLS` and does not own the tables. Unscoped = zero rows.
2. `withTenant(tenantId, fn)` is the only way to get a database handle. It sets the tenant for one
   transaction. Repositories accept only that handle.
3. Token vault: AES-256-GCM, key derived per tenant (HKDF), AAD bound to tenant + connection. A
   ciphertext copied to another tenant's row fails to decrypt.
4. In-memory state (service-role networks) is keyed by Guardbase project ID, never Supabase ref.
5. The scheduler reads IDs only, through one hardened SECURITY DEFINER function.
6. External calls (Supabase, AI Gateway) never run inside a transaction.

## Files expected to change

`src/tenancy/`, `src/db/`, `src/vault/`, `src/poller/`, `migrations/`, `src/detectors/serviceRole.ts`,
`src/scan.ts`, `src/cli.ts`, tests.

## Open questions

- Does a Supabase OAuth token cover one organization? Settle when the OAuth app is registered.
- Hosting for Postgres (Hetzner + Coolify per the PRD).

## Build log

- Scope keys: `ServiceRoleNetworks` was keyed by Supabase ref. Two tenants watching one Supabase
  project would have shared learned networks, so one tenant's traffic could silence the other's
  `new_network` alert. Now keyed by tenant + Guardbase project (commit 237ca10).
- Schema + RLS (`migrations/0001_tenancy.sql`), `withTenant`, repositories, token vault. 12
  Postgres tests run as a non-superuser role on a throwaway cluster (Postgres 17, Unix socket).
  Mutation checks: a permissive leak policy, FORCE removed, `nullif` removed, a single-column FK,
  and a writable audit log each fail the suite.
- The scheduler uses column grants (tenant_id, id, paused, last_polled_at) plus a read policy,
  not a SECURITY DEFINER function: under FORCE RLS a definer function owned by a non-superuser
  would see nothing, and column grants cannot leak other columns by construction.
- `ON DELETE SET NULL (incident_id)` needs Postgres 15+.
- Poller end to end (`test/db/poller.test.ts`): two tenants on the same Supabase ref with
  different tokens. Each poll used its own token; the attacked tenant got 2 critical incidents,
  the other none; learned networks stayed per tenant; a 429 and a crash stayed in their own
  project; the audit log recorded the query before it ran and each model call with ZDR requested.
- A crash after the start transaction leaves a poll run in `running`. Backlog: sweep these to
  `unable_to_assess`.
- Review fixes:
  - Overlapping 2-minute windows counted each request twice and never re-checked a failed span.
    Windows now start at the last `ok` run's end, end at floor(now − 120 s) to the minute
    (Supabase rounds bounds to the minute), and are capped at 24 hours (flagged
    `window_truncated` in the audit row). Trade-off: a log landing more than 120 s late is missed.
  - Two workers could poll one project. `claimProject` is a conditional update that takes the row
    lock; the loser skips with `claimed_elsewhere`.
  - An explainer exception threw away the poll's findings. It now falls back to template text per
    incident (PRD: every alert still goes out).
  - Mutation checks: the old overlapping window, an always-true claim and a rethrown explainer
    error each fail the suite.
- Cloudflare poller (`apps/poller`): Cron Trigger every minute lists due scopes through the
  scheduler Hyperdrive config and enqueues one message per scope (batches of 100). The queue
  consumer (max 20 concurrent, 3 retries, dead-letter queue) runs `pollProject` through the app
  Hyperdrive config. Pools are created per invocation. Malformed messages are acked; crashes retry.
- Core proven inside workerd (`@cloudflare/vitest-plugin`): vault (node:crypto), detectors and the
  AI SDK path with ZDR on both models. Not proven: `pg` over Hyperdrive, which needs a live config.
- Stale-run sweep: each poll first marks its own project's runs stuck in `running` for over 10
  minutes as `unable_to_assess` / `worker_lost` (tenant-scoped, so the scheduler role stays
  read-only).
