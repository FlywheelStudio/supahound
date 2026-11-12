# Web latency

Decision 039. Shipped 2026-11-12.

## What it does

Makes signed-in pages fast for visitors far from the database, and answers every in-app click at once.

## How it works

- **Placement.** The production web Worker runs in `aws:eu-west-1`, next to Postgres and Supabase
  Auth. The setting lives in the private deploy config, not in `apps/web/wrangler.jsonc`.
  Self-hosters: see `docs/self-hosting.md`.
- **Transaction open.** `begin()` (`packages/core/src/db/tenant.ts`) opens the transaction and sets
  every `app.*` GUC in one round trip. Names must match `^app\.[a-z_]+$`; values are escaped with
  `client.escapeLiteral`. `withTenant` and `withTenantForUser` (`packages/core/src/db/user.ts`) use it.
- **Pending bar.** `apps/web/components/NavLink.tsx` wraps `next/link` and shows a 2 px bar at the
  top of the page while that link's navigation is pending (`useLinkStatus`). Every page and the
  Shell import `Link` from it.
- **Auth.** With asymmetric JWT signing keys on the Supabase project, `getClaims()` verifies
  locally. Without them it calls Auth, which placement keeps in the same region.

## Data model

No migration.

## Testing

- `packages/core/test/db/begin.test.ts`: a value with quotes, a backslash and an injected
  `set_config` round-trips exactly; names outside `app.*` throw; settings end with the
  transaction. Proven able to fail: naive quoting fails the first and third tests.
- The isolation suite and every E2E access test (404s and the signed-out 307) run unchanged.

## Gotchas

- **Never add `loading.tsx` under `/w`.** It streams a 200 before the access check runs, so 404s
  and the login redirect turn into 200s. The E2E suite catches it.
- Keep `begin()` the only place that puts values into SQL text.
- Placement region must follow the database. Moving Postgres means moving the hint.
