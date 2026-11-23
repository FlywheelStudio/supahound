# 049: The read-only role reads every row; Supahound sends fixed catalog queries only

Date: 2026-11-23 · Issue #4 · Builds on [012](012-connect-with-supabase-oauth.md),
[024](024-ownership-refresh-and-detector-coverage.md) and [038](038-posture-scan.md)

## Context

Decisions 024 and 038 run SQL through `POST /v1/projects/{ref}/database/query/read-only` with the
customer's `database:read` token. Supabase runs that SQL as `supabase_read_only_user`. Both
decisions listed as not verified live whether that role can read `pg_policies` and call
`has_table_privilege`, `has_function_privilege` and `has_column_privilege` for other roles. If it
could not, a check would return no rows, and Supahound would show "no problems" where it could not
look.

We tested on 2026-11-23 against ULink (Postgres 15), a real project
connected to production through the registered OAuth app (client ID `b21c107f-…`, registered
2026-11-11).

## Findings

1. **Supahound's queries work as that role.** The production posture scan of ULink on 2026-11-22
   17:40 UTC used the OAuth token and recorded 35 tables, 1 view and 73 policies, with
   `catalog_status` and `advisor_status` both `ok`. The same query run as `postgres` on 2026-11-23
   finds 35 tables, 1 view, 73 policies and 8 SECURITY DEFINER functions. The counts match. The
   ownership read of `pg_policies` succeeded (`ownership_refreshed_at` 2026-11-22 16:58 UTC, no
   error).
2. **The Advisor endpoint is current.** `GET /v1/projects/{ref}/advisors/security` answered the
   OAuth token, and Supahound parsed 17 findings from it (16 table, 1 compliance). Supabase still
   labels the endpoint experimental.
3. **The role reads every row in the database.** `supabase_read_only_user` has `BYPASSRLS` and is
   a member of `pg_read_all_data` and `pg_monitor`. `has_table_privilege` reports `SELECT` on
   `auth.users`, `auth.identities`, `storage.objects`, `pg_catalog.pg_authid` and
   `vault.decrypted_secrets`. We checked privileges only. We did not read those tables.
4. **One token covers one whole organization.** Supabase's consent screen asks the user to pick
   an organization. Its only related parameter, `organization_slug`, pre-selects one. No parameter
   picks projects ([Build a Supabase
   Integration](https://supabase.com/docs/guides/integrations/build-a-supabase-oauth-integration),
   read 2026-11-23). Supahound's project picker sets which projects Supahound *monitors*, not
   what the token *can reach*. This rests on the docs, not a live test. Supahound's logs hold no
   connect or picker rows from 2026-11-11.

How we tested: `postgres` is not a member of `supabase_read_only_user`, so `SET ROLE` was not
possible. We used `has_*_privilege('supabase_read_only_user', …)` for each catalog, function and
schema the queries touch, and compared the admin result with the live scan. Every query was
read-only.

## Decision

1. **Supahound sends only fixed SQL to the read-only endpoint.** The SQL lives in
   `packages/core/src/config/posture.ts` (`POSTURE_SQL`) and
   `packages/core/src/ownership/ownership.ts` (`POLICIES_SQL`). Both read the system catalog, never
   table rows. No code path builds SQL from user input or sends a customer's query. A new query
   against this endpoint needs a decision record.
2. **We state the access honestly.** Connecting Supabase grants Supahound read access to every row
   in every project of the organization they pick, including projects they do not add to
   Supahound, because that is what `database:read` gives. The connect page, the
   privacy page and sales material say so, and say what Supahound actually reads: the catalog,
   logs and the Security Advisor.
3. **The token is sealed and never leaves the server** (decision 004 and 012, unchanged).

## Alternatives considered

- **Ask the customer to create a narrower role and send us its connection string.** Narrower
  access, but it needs a direct database connection and a password we store. It breaks the
  one-click OAuth connect. Rejected for now.
- **Wait for a narrower Supabase scope.** None exists today. Revisit if Supabase adds one.

## Consequences

- The "not verified live" notes on the read-only role in decisions 024 and 038,
  `features/ownership-refresh.md`, `features/posture-scan.md` and `self-hosting.md` are settled by
  this record.
- A leaked token is worth more than its scope name suggests. Token sealing and revocation on
  disconnect (decision 037) carry that weight.
- The `docs/wip/tenant-isolation.md` question (one organization or named projects) is settled by
  finding 4.
- The connect page and privacy-page wording (point 2) is follow-up work. The privacy page lives in
  `supahound-site`.
