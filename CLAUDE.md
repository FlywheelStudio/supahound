# supadog

Detection worker for **Guardbase**, an abnormal-traffic monitor for Supabase apps. It polls each
customer project's edge logs through the Supabase Management API (read-only, `analytics:read`),
runs the detectors, groups findings into incidents, and writes summaries with a ZDR-only model.
Backend: its own Postgres (multi-tenant, forced RLS). Customer projects are Supabase; Guardbase is
not.

Product spec: [Guardbase PRD](https://claude.ai/artifact/Qx6AaTtA4fn6HqPJ4DcSzj) (Claude Doc).

## Commands

Node.js ≥ 22, ESM, pnpm.

```bash
pnpm install
pnpm test            # vitest: unit, CLI, and Postgres tests (needs Postgres 16+; see below)
pnpm typecheck       # tsc --noEmit
pnpm lint            # eslint
pnpm build           # tsc to dist/

pnpm scan --file test/fixtures/events.ndjson --ownership test/fixtures/policies.json
pnpm scan --project <ref> --ownership ownership.json [--minutes 15] [--expected-asns 16509]
pnpm discover-keys --project <ref>      # PRD task 1: which auth fields exist in edge logs
pnpm exec tsx src/cli.ts print-sql      # the SQL each command runs
pnpm worker                             # long-running poller (see .env.example)
```

The Postgres tests start a throwaway cluster on a Unix socket. They look for `initdb` in
`GUARDBASE_PG_BIN`, then `/opt/homebrew/opt/postgresql@17/bin`. Set `GUARDBASE_SKIP_DB_TESTS=1` to
skip them where no Postgres exists; never skip them before a merge.

## Codebase map

| Path | Purpose |
| --- | --- |
| `src/config/fields.ts` | The only place that knows Supabase log field paths; marks each verified or not |
| `src/logs/` | Rollup SQL, Management API client, row → `EdgeEvent` normalization |
| `src/postgrest/query.ts` | PostgREST query-string parser (nested `or`/`and`, `not.`, embedded resources) |
| `src/ownership/` | Ownership columns from `pg_policies` expressions |
| `src/network/classify.ts` | Caller class (browser, mobile app, server) and hosting-ASN list |
| `src/detectors/` | Detector 2 (cross-tenant) and detector 4 (service-role misuse) |
| `src/scan.ts`, `src/cli.ts` | Runs both detectors over one poll; command line |
| `src/tenancy/scope.ts` | Branded tenant/project IDs; every state key includes the tenant |
| `src/db/` | `withTenant` (the only DB handle) and repositories |
| `src/vault/` | Per-tenant sealing of OAuth tokens |
| `src/incidents/` | Incident engine: per actor, 15-minute window |
| `src/explainer/` | Features, validator, template; `llm.ts` is the ONLY model caller (ZDR) |
| `src/poller/`, `src/worker.ts` | One tenant-scoped poll; scheduler; worker loop |
| `migrations/` | Postgres schema with forced RLS (apply to shared DBs only with approval) |
| `test/` | Vitest suites; `test/fixtures/` holds synthetic data only |

## Environment

See `.env.example`. `SUPABASE_ACCESS_TOKEN` (analytics:read), `SUPABASE_PROJECT_REF`,
`GUARDBASE_SOURCE_COLUMN` (`source` or `source_name`, settled by the live check).

## Rules specific to this repo

- Never commit real log rows. They hold user IDs, IPs and emails. Name local exports `*.local.ndjson`
  (git-ignored).
- Detector evidence carries structured features only: enums, counts, ASNs, fingerprints. No raw user
  agents or query values (PRD, Security of Guardbase itself).
- Field paths change only in `src/config/fields.ts`.
- **Never cross tenant data.** Touch tenant tables only through `withTenant`. Every new table gets
  `tenant_id`, forced RLS and a `(tenant_id, id)` foreign key; the isolation test fails otherwise.
  Key every cache and map by `scopeKey`, never by Supabase ref. No learning across tenants
  (decision 006).
- **Every model call uses ZDR.** Only `src/explainer/llm.ts` may call a model; ESLint enforces it.
  Never add BYOK keys, prompt caching, tools or raw log text to a model call (decision 005).
