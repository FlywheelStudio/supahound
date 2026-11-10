# Contributing to Supahound

Thank you for helping. Read this page before you open a pull request.

## License and CLA

Supahound is fair source under [FSL-1.1-ALv2](LICENSE.md). Before we can merge your first pull
request, you sign the [Contributor License Agreement](CLA.md): the CLA check comments on your pull
request and tells you how. You sign once.

## Before you start

- Open an issue first, or comment on an existing one, and say what you plan to change. Small fixes
  to docs and typos do not need an issue.
- Report a vulnerability privately ([SECURITY.md](SECURITY.md)), never in an issue.

## Set up

Node.js 22+, pnpm 10 and Postgres 17. The database tests start their own throwaway Postgres
cluster; they need `initdb` (macOS: `brew install postgresql@17`; Debian/Ubuntu: `postgresql-17`).

```bash
pnpm install
pnpm typecheck && pnpm lint
pnpm -r test     # unit, Postgres, workerd, detection UAT
pnpm e2e         # builds the web Worker, then Playwright E2E + web UAT
```

First run of `pnpm e2e`: `pnpm --filter @supahound/web exec playwright install chromium-headless-shell`.

## Pull requests

- Branch from `develop` as `feature/<slug>` or `fix/<slug>`, and open the pull request into
  `develop`.
- The pull request body says `Closes #<issue>`. The "PR hygiene" check fails without it.
- CI must be green: secret scan, typecheck, lint, every test suite (Postgres never skipped),
  build and E2E.
- Every change ships with tests. Prove a new test can fail: break the code it guards, watch it
  fail, then restore the code ([docs/TESTING.md](docs/TESTING.md)).

## Rules the code depends on

These are in [CLAUDE.md](CLAUDE.md) and the decision records. A pull request that breaks one is
not merged.

- Never cross tenant data. Tenant tables are reached only through `withTenant` or
  `withTenantForUser`. Every new table gets `tenant_id`, forced RLS and a `(tenant_id, id)`
  foreign key.
- Every model call goes through `packages/core/src/explainer/llm.ts` with zero data retention.
- Never commit real log rows, secrets or `.env` / `.dev.vars` files. Fixtures are synthetic.
- Detector evidence holds structured features only: no raw user agents, query values, emails or
  IPs.
- Do not add a new external service without an issue that a maintainer approves.

## Writing style

Docs, commit messages and pull requests use Simplified Technical English: short sentences, active
voice, one word for one meaning ([CLAUDE.md](CLAUDE.md)).

## Conduct

We follow the [Contributor Covenant 2.1](https://www.contributor-covenant.org/version/2/1/code_of_conduct/).
Report conduct problems privately to hello@flywheel.so.
