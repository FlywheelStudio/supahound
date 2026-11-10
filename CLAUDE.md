# Supahound

Repository: [FlywheelStudio/supahound](https://github.com/FlywheelStudio/supahound). Fair source under
FSL-1.1-ALv2 (`LICENSE.md`, decision 025); contributors sign `CLA.md`. Renamed from Guardbase (decision 015).

**Supahound**: abnormal-traffic monitoring for Supabase apps. Customers connect their Supabase
org (OAuth, read-only); a Cloudflare poller reads each project's edge logs, runs the detectors,
groups findings into incidents and writes summaries with a ZDR-only model; a Next.js app on
Workers handles sign-in (Supabase Auth magic links), onboarding and the dashboard.
Backend: Supahound's own Supabase Postgres (schema `supahound`, forced RLS, reached through
Hyperdrive with caching off). Everything else runs on Cloudflare (decision 008).

The public spec is the decision records plus `docs/ARCHITECTURE.md`. Flywheel's PRD is private;
where it and a decision record disagree, the decision wins (hosting: 008; models: 011).
Self-hosting: `docs/self-hosting.md`. The marketing site and legal pages are in the private repo
`FlywheelStudio/supahound-site` (decision 025); this repo holds the product only.

Orient in this order: `docs/INDEX.md` → `docs/STATE.md` → the active WIP doc → the issue.
`docs/ARCHITECTURE.md` explains the system; `docs/ROADMAP.md` maps phases to milestones.

This repo does not import `conventions/saas-web.md`: it deploys to Cloudflare, not Vercel, and
uses the three-branch model below instead of a main-only flow.

## Workflow (decision 019, `docs/WORKFLOW.md`)

- **Ask before you do any work.** Confirm scope and approach with the person you work for first
  (Erik in Flywheel sessions; outside contributors: the issue's maintainer).
- **Check branches first.** `git fetch && git branch -a`. If the work belongs on an open branch, use it.
- **Three branches:** one `feature/<slug>` (or `fix/<slug>`), `develop`, `main` (production).
  Feature PRs target `develop`. Every branch ends merged or deleted; no work left outstanding.
- **One git worktree per session.** Other Claude sessions work in this repo too. Never commit,
  switch branches or stage files in a checkout another session uses.
- **Every change has a GitHub issue.** The PR says `Closes #<n>`; the "PR hygiene" check fails otherwise.
  Give issues labels (`type:*`, `area:*`, `priority:*`, `needs-erik`) and a milestone (roadmap phase).
- **CI must be green:** typecheck, lint, `pnpm -r test` (Postgres never skipped), build, `pnpm e2e`.
- **Never add a new service without asking.** Stay on the stack in the decision records.
- Before you number a new decision, check `docs/decisions/` and every open branch; another session may hold the next number.

## Commands

Node.js ≥ 22, ESM, pnpm workspace. Run from the repo root unless noted.

```bash
pnpm install
pnpm typecheck                 # every package
pnpm lint                      # one ESLint config for the whole repo (holds the ZDR guard)
pnpm -r test                   # core (unit + Postgres), web (unit), poller (inside workerd)
pnpm -r build                  # poller: wrangler dry run; web: vite build
pnpm e2e                       # web: vite build, then Playwright E2E + UAT (docs/TESTING.md)
pnpm --filter @supahound/web e2e:only     # Playwright only, on an existing build

pnpm scan --file test/fixtures/events.ndjson --ownership test/fixtures/policies.json   # core CLI
pnpm discover-keys --project <ref>        # PRD task 1: which auth fields exist in edge logs
pnpm -s print-sql                         # the rollup, key-discovery and pg_policies SQL
pnpm -s master-key [--rotate]             # a new SUPAHOUND_MASTER_KEYS value (self-hosting)
pnpm --filter @supahound/web dev          # web app (needs .dev.vars, see apps/web/wrangler.jsonc)
pnpm --filter @supahound/poller dev       # poller Worker
pnpm --filter @supahound/<app> types      # regenerate Worker binding types after config changes
```

Use `pnpm -r test`, not `pnpm -s test`: silent mode hides the child packages' summaries.

The Postgres tests start a throwaway cluster on a Unix socket and apply every file in
`supabase/migrations/` in order. They look for `initdb` in `SUPAHOUND_PG_BIN`, then
`/opt/homebrew/opt/postgresql@17/bin`. `SUPAHOUND_SKIP_DB_TESTS=1` skips them where no Postgres
exists; never skip them before a merge.

`pnpm e2e` starts Postgres 17 on TCP, a fake Supabase Auth (`apps/web/e2e/support/fakeAuth.ts`)
and the built Worker under `wrangler dev` (decision 020). First run on a machine:
`pnpm --filter @supahound/web exec playwright install chromium-headless-shell`. `E2E_DEBUG=1`
prints the wrangler output. Prove each new check can fail before you trust it (docs/TESTING.md).

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
| `apps/web/` | Next.js on Workers (vinext): auth, onboarding, dashboard, Supabase connect, email hook. No marketing pages; optional brand links in `lib/brand.ts` |
| `supabase/migrations/` | Postgres schema with forced RLS (apply to shared DBs only with approval) |
| `supabase/setup/` | Not migrations: the login-user SQL for self-hosters (passwords never go in git) |
| `packages/core/test/db/`, `test/uat/` | Postgres suites; detection UAT scenarios (UAT-D*) |
| `apps/web/e2e/` | Playwright: signed-out checks, web UAT journey (UAT-W*), fake Auth, Postgres setup |
| `.github/` | CI (with the gitleaks secret scan, `.gitleaks.toml`), PR hygiene, CLA check, labeler, Claude Action, Dependabot, templates |
| `docs/` | INDEX, STATE, ARCHITECTURE, ROADMAP, TESTING, WORKFLOW, decisions, WIP and feature docs |

## Environment

Worker vars and required secrets are declared in each `wrangler.jsonc` (`secrets.required`).
Local values go in `.dev.vars` (git-ignored). Hyperdrive local strings:
`CLOUDFLARE_HYPERDRIVE_LOCAL_CONNECTION_STRING_<BINDING>`. Core CLI: see `.env.example`.

## Rules specific to this repo

- **This repo is public.** Never put secrets, client names, customer data or internal-only notes in
  code, docs, issues or PRs. CI runs gitleaks on every push; add a rule to `.gitleaks.toml` for any
  new secret format.
- A shipped feature that the marketing site shows as "Coming soon" flips to live in
  `FlywheelStudio/supahound-site` (`content/features.ts`) in a follow-up PR there.
- Never commit real log rows. They hold user IDs, IPs and emails. Name local exports `*.local.ndjson`
  (git-ignored).
- Detector evidence carries structured features only: enums, counts, ASNs, fingerprints. No raw user
  agents or query values (PRD, Security of Supahound itself).
- Field paths change only in `packages/core/src/config/fields.ts`.
- **Never cross tenant data.** Touch tenant tables only through `withTenant`. Every new table gets
  `tenant_id`, forced RLS and a `(tenant_id, id)` foreign key; the isolation test fails otherwise.
  Key every cache and map by `scopeKey`, never by Supabase ref. Only aggregate patterns may cross
  tenants, never data, under the limits in decision 007.
- **Every model call uses ZDR.** Only `packages/core/src/explainer/llm.ts` may call a model; ESLint enforces it.
  Never add BYOK keys, prompt caching, tools or raw log text to a model call (decision 005).
- **Workers never share I/O across requests.** Create `pg` pools per invocation. Never enable
  Hyperdrive query caching or page caching for signed-in routes.
- **Users come only from `getClaims()`** in the web app; tenant pages go through
  `withTenantForUser`.
