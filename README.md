# Supahound

Abnormal-traffic monitoring for Supabase apps. Supahound tells an app owner within minutes when one
user or key is pulling data it should not. It reads edge logs through read-only Supabase OAuth,
runs per-actor detectors every minute, and writes each incident's summary with a ZDR-only model.

Status: pre-launch, Validate phase. See [docs/ROADMAP.md](docs/ROADMAP.md) and
[docs/STATE.md](docs/STATE.md).

## Start here

| Read | For |
| --- | --- |
| [docs/INDEX.md](docs/INDEX.md) | Every doc and decision record |
| [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) | How the parts fit and what one poll does |
| [docs/WORKFLOW.md](docs/WORKFLOW.md) | Issues, branches, PRs, CI |
| [docs/TESTING.md](docs/TESTING.md) | Test tiers and the UAT catalogue |
| [CLAUDE.md](CLAUDE.md) | Commands and repo rules |
| [PRD](https://claude.ai/artifact/Qx6AaTtA4fn6HqPJ4DcSzj) | Product scope, detectors, pricing |

## Quick start

Node.js 22+, pnpm 10, Postgres 17 (`brew install postgresql@17`) for the database tests.

```bash
pnpm install
pnpm typecheck && pnpm lint
pnpm -r test     # unit, Postgres, workerd, detection UAT
pnpm e2e         # builds the web Worker, then Playwright E2E + web UAT
```

Work goes through [GitHub issues](https://github.com/FlywheelStudio/supahound/issues): issue →
`feature/<slug>` → PR into `develop` with `Closes #n` → green CI → merge.
