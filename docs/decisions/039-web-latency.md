# 039: Web latency: run the web Worker next to Postgres, one round trip to open a transaction, no loading.tsx

Date: 2026-11-12 · Builds on 008 (hosting), 009 (auth) and 020 (E2E)

## Context

Signed-in pages felt slow. A production request ran in the Cloudflare location nearest the
visitor (São Paulo in one measurement) while Postgres runs in AWS eu-west-1. Each Postgres round
trip then costs about 200 ms. The workspace overview makes about 12 sequential round trips:
`BEGIN`, one `set_config` per setting, the membership check, the billing gate, five reads and
`COMMIT`. `getClaims()` also calls Supabase Auth over the network twice per request (middleware
and page) while the project signs JWTs with a shared secret.

## Decision

1. **Placement.** The production web Worker runs in `aws:eu-west-1`
   (`"placement": { "region": "aws:eu-west-1" }` in the private deploy config). The visitor pays
   one long hop to the Worker; every Postgres and Auth round trip after that stays in the region.
   The public template has no placement: a self-hoster sets the region of their own database
   (`docs/self-hosting.md`).
2. **One round trip to open a transaction.** `begin()` in `packages/core/src/db/tenant.ts` sends
   `BEGIN; SELECT set_config(...), ...` as one simple-protocol query. A multi-statement query
   cannot take `$n` parameters, so setting names must match `^app\.[a-z_]+$` and values go
   through the driver's `escapeLiteral`. `withTenant` and `withTenantForUser` both use it.
3. **Asymmetric JWT signing keys** on Supahound's Supabase project, so `getClaims()` verifies the
   token locally against the cached JWKS instead of calling Auth. A dashboard change (needs-erik).
4. **Navigation feedback without `loading.tsx`.** Links render through `components/NavLink.tsx`,
   which shows a top progress bar from `useLinkStatus()` while the next page loads.

## Alternatives considered

- **`loading.tsx` skeletons.** Rejected: the boundary streams a 200 before the page runs its
  access check. A non-member then gets a 200 instead of a 404, and a signed-out visitor a 200
  instead of a 307. Six E2E tests (UAT-W7, W21, W25, W26, W28, signed-out redirect) failed with it.
- **Smart placement.** Rejected for now: it learns from traffic and needs volume before it moves
  the Worker. The region hint is exact and works from the first request.
- **Run reads in parallel.** One `pg` client runs queries one after another, and the reads must
  share the RLS transaction. Placement makes each round trip cheap instead.
- **Pass the verified user from middleware to the page in a header.** Rejected: decision 009 says
  the user comes only from `getClaims()`. Asymmetric keys make the second call local instead.
- **Hyperdrive query caching.** Forbidden for signed-in routes (decision 008).

## Consequences

- Visitors far from Ireland pay one long hop per request, not one per query.
- `begin()` is the only place that builds SQL from setting values; its Postgres test pins
  quoting, the name pattern and transaction-local scope.
- Pages still have no instant skeleton on a full page load. A click inside the app shows the bar.
