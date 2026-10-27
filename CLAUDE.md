# supadog

**Guardbase**: abnormal-traffic monitoring for Supabase apps. Customers connect their Supabase
org (OAuth, read-only); a Cloudflare poller reads each project's edge logs, runs the detectors,
groups findings into incidents and writes summaries with a ZDR-only model; a Next.js app on
Workers handles sign-in (Supabase Auth magic links), onboarding and the dashboard.
Backend: Guardbase's own Supabase Postgres (schema `guardbase`, forced RLS, reached through
Hyperdrive with caching off). Everything else runs on Cloudflare (decision 008).

Product spec: [Guardbase PRD](https://claude.ai/artifact/Qx6AaTtA4fn6HqPJ4DcSzj) (Claude Doc).

## Commands

Node.js ≥ 22, ESM, pnpm workspace. Run from the repo root unless noted.

```bash
pnpm install
pnpm typecheck                 # every package
pnpm lint                      # one ESLint config for the whole repo (holds the ZDR guard)
pnpm -r test                   # core (unit + Postgres), web (unit), poller (inside workerd)
pnpm -r build                  # poller: wrangler dry run; web: vite build

pnpm scan --file test/fixtures/events.ndjson --ownership test/fixtures/policies.json   # core CLI
pnpm discover-keys --project <ref>        # PRD task 1: which auth fields exist in edge logs
pnpm --filter @guardbase/web dev          # web app (needs .dev.vars, see apps/web/wrangler.jsonc)
pnpm --filter @guardbase/poller dev       # poller Worker
pnpm --filter @guardbase/<app> types      # regenerate Worker binding types after config changes
```

Use `pnpm -r test`, not `pnpm -s test`: silent mode hides the child packages' summaries.

The Postgres tests start a throwaway cluster on a Unix socket and apply every file in
`supabase/migrations/` in order. They look for `initdb` in `GUARDBASE_PG_BIN`, then
`/opt/homebrew/opt/postgresql@17/bin`. `GUARDBASE_SKIP_DB_TESTS=1` skips them where no Postgres
exists; never skip them before a merge.

## Codebase map

| Path | Purpose |
| --- | --- |
| `packages/core/src/config/fields.ts` | The only place that knows Supabase log field paths |
| `packages/core/src/logs/` | Rollup SQL, Management API logs client, row → `EdgeEvent` |
| `packages/core/src/postgrest/`, `ownership/`, `network/`, `detectors/` | Detectors 2 and 4 |
| `packages/core/src/tenancy/scope.ts` | Branded tenant/project/user IDs; every state key includes the tenant |
| `packages/core/src/db/` | `withTenant`, `withTenantForUser` (the only DB handles) and repositories |
| `packages/core/src/vault/` | Per-tenant sealing of OAuth credentials |
| `packages/core/src/supabase/` | Supabase OAuth (PKCE, state, exchange) and locked token refresh |
| `packages/core/src/incidents/` | Incident engine: per actor, 15-minute window |
| `packages/core/src/explainer/` | Features, validator, template; `llm.ts` is the ONLY model caller (ZDR) |
| `packages/core/src/poller/` | One tenant-scoped poll; scheduler helpers |
| `apps/poller/` | Cloudflare Worker: cron → queue → poll, via Hyperdrive |
| `apps/web/` | Next.js on Workers (vinext): auth, onboarding, dashboard, Supabase connect, email hook |
| `supabase/migrations/` | Postgres schema with forced RLS (apply to shared DBs only with approval) |

## Environment

Worker vars and required secrets are declared in each `wrangler.jsonc` (`secrets.required`).
Local values go in `.dev.vars` (git-ignored). Hyperdrive local strings:
`CLOUDFLARE_HYPERDRIVE_LOCAL_CONNECTION_STRING_<BINDING>`. Core CLI: see `.env.example`.

## Rules specific to this repo

- Never commit real log rows. They hold user IDs, IPs and emails. Name local exports `*.local.ndjson`
  (git-ignored).
- Detector evidence carries structured features only: enums, counts, ASNs, fingerprints. No raw user
  agents or query values (PRD, Security of Guardbase itself).
- Field paths change only in `packages/core/src/config/fields.ts`.
- **Never cross tenant data.** Touch tenant tables only through `withTenant`. Every new table gets
  `tenant_id`, forced RLS and a `(tenant_id, id)` foreign key; the isolation test fails otherwise.
  Key every cache and map by `scopeKey`, never by Supabase ref. No learning across tenants
  (decision 006).
- **Every model call uses ZDR.** Only `packages/core/src/explainer/llm.ts` may call a model; ESLint enforces it.
  Never add BYOK keys, prompt caching, tools or raw log text to a model call (decision 005).
- **Workers never share I/O across requests.** Create `pg` pools per invocation. Never enable
  Hyperdrive query caching or page caching for signed-in routes.
- **Users come only from `getClaims()`** in the web app; tenant pages go through
  `withTenantForUser`.
