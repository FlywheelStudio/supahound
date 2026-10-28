# 004: Tenant isolation in Postgres with forced RLS and scoped transactions

Date: 2026-10-27

## Context

Supahound holds many tenants' Supabase tokens, findings and incidents. Erik's rule: never cross
client data. An agency and its client can both watch the same Supabase project.

## Decision

- One Postgres database, schema `supahound`, `tenant_id` on every table.
- RLS enabled and forced on every table, keyed to the transaction-local `app.tenant_id`. Unset
  means zero rows.
- The app logs in as a member of `supahound_app`: not a superuser, no BYPASSRLS, owns nothing.
- `withTenant` is the only way to get a database handle. Repositories also repeat `tenant_id` in
  every statement.
- Children reference parents by `(tenant_id, id)`.
- The scheduler role gets column grants on project IDs and poll times only. No SECURITY DEFINER
  function: under FORCE RLS one owned by a non-superuser would see nothing.
- Tokens sit on a connection (one OAuth grant), sealed with a per-tenant HKDF key and AAD bound to
  tenant + connection.
- All in-memory state is keyed by tenant + Supahound project ID, never Supabase ref.
- Postgres 15+ (for `ON DELETE SET NULL (column)`).

## Alternatives considered

- Database or schema per tenant: stronger walls, but 1,000+ tenants means 1,000+ migrations and
  connection pools. Revisit for an enterprise tier.
- App-level filtering only: one missed `WHERE` leaks a tenant.

## Consequences

- Every new table must enable and force RLS. `test/db/isolation.test.ts` fails if any table in the
  schema lacks it.
- Cross-tenant admin work (support, billing) needs its own role and review. None exists yet.
