# WIP: Tenant isolation (multi-tenant storage, vault, poller)

Goal: Guardbase runs many tenants (agencies, builders), each with many Supabase projects. No code
path may read, write, decrypt or mix one tenant's data with another's.

## Status — 2026-10-27

- In progress. Build order: scope keys → schema + RLS → token vault → poller.

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
- Hosting for Postgres (Hetzner + Coolify per the PRD). Decision 004.

## Build log
