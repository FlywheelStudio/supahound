# Supahound

Abnormal-traffic monitoring for Supabase apps. Supahound tells an app owner within minutes when one
user or key is pulling data it should not: one user reading another user's rows, a service-role key
used from a browser, a scraper walking a table. It reads edge logs through read-only Supabase OAuth,
runs per-actor detectors every minute, and writes each incident's summary with template text or a
zero-data-retention model.

**Status: alpha.** The detectors, tenant isolation, web app and poller are built and tested. They
have not run against live Supabase traffic yet ([roadmap](docs/ROADMAP.md)).

## Use it

- **Hosted:** Flywheel runs Supahound at [supahound.com](https://supahound.com).
- **Self-hosted:** run it on your own Supabase and Cloudflare accounts with your own keys. Read
  [docs/self-hosting.md](docs/self-hosting.md). It starts with a five-minute scan from your laptop.

## License

Supahound is **fair source** under the [Functional Source License, FSL-1.1-ALv2](LICENSE.md),
copyright Flywheel Studio LLC.

- You may use, change and self-host it for any purpose except a *Competing Use*: offering it to
  others as a commercial product or service that substitutes for Supahound. Running it on your own
  apps or your company's apps is allowed.
- Each version becomes Apache-2.0 two years after it is published.

FSL is not an OSI open-source license. [Decision 025](docs/decisions/025-public-release-fsl.md)
explains the choice.

## How it works

| Part | What it does |
| --- | --- |
| `packages/core` | Detectors, log queries, incident engine, ZDR explainer, tenant-scoped database access, token vault |
| `apps/poller` | Cloudflare Worker: a cron enqueues due projects; a queue consumer polls each one |
| `apps/web` | Next.js on Cloudflare Workers (vinext): magic-link sign-in, workspaces, Connect Supabase, dashboard |
| `supabase/migrations` | Supahound's own Postgres schema, with forced row-level security on every tenant table |

[docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) walks through one poll step by step.
[docs/INDEX.md](docs/INDEX.md) lists every doc and decision record.

## Develop

Node.js 22+, pnpm 10, Postgres 17 for the database tests (`brew install postgresql@17`).

```bash
pnpm install
pnpm typecheck && pnpm lint
pnpm -r test     # unit, Postgres, workerd, detection UAT
pnpm e2e         # builds the web Worker, then Playwright E2E + web UAT
```

Read [CONTRIBUTING.md](CONTRIBUTING.md) before you open a pull request. Contributors sign a short
[CLA](CLA.md) once. Report vulnerabilities privately ([SECURITY.md](SECURITY.md)).
