# supadog

Detection prototype for **Guardbase**, an abnormal-traffic monitor for Supabase apps. It reads a
project's edge logs through the Supabase Management API (read-only, `analytics:read`) and runs the
two baseline-free detectors from the PRD. No database of its own yet; no Supabase or Firebase backend.

Product spec: [Guardbase PRD](https://claude.ai/artifact/Qx6AaTtA4fn6HqPJ4DcSzj) (Claude Doc).

## Commands

Node.js ≥ 22, ESM, pnpm.

```bash
pnpm install
pnpm test            # vitest, all unit + CLI end-to-end tests
pnpm typecheck       # tsc --noEmit
pnpm lint            # eslint
pnpm build           # tsc to dist/

pnpm scan --file test/fixtures/events.ndjson --ownership test/fixtures/policies.json
pnpm scan --project <ref> --ownership ownership.json [--minutes 15] [--expected-asns 16509]
pnpm discover-keys --project <ref>      # PRD task 1: which auth fields exist in edge logs
pnpm exec tsx src/cli.ts print-sql      # the SQL each command runs
```

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
