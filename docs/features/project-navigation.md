# Project navigation

Issue #98. Decision 031. Part of the web app ([wip/web-app.md](../wip/web-app.md)).

## What it does

Every signed-in workspace page has a sidebar. Its header is a project dropdown: pick a project
and the app opens that project's dashboard. Each project has these pages:

| Page | Path under `/w/<tenant>/p/<project>` | State |
| --- | --- | --- |
| Dashboard | (none) | Status, open incidents, 30-day requests, plan, detector 2 coverage, top 5 open incidents |
| Incidents | `/incidents` | 30-day history, newest first, and `/incidents/<id>` detail ([incident-history.md](incident-history.md), #44) |
| Security scan | `/findings` | The newest finished scan of each attached domain ([scan-domains.md](scan-domains.md), #100) |
| Settings → General | `/settings` | Name, ref, polling, last poll; Security scan domains (attach, detach: owners and admins, #100); Remove (owners and admins) |
| Settings → Notifications | `/settings/notifications` | Email alert threshold (decision 030); SMS disabled, Coming soon (#32) |
| Settings → Plan & billing | `/settings/plan` | Tier, price, 30-day requests, how the tier is set; read-only until #99 |
| Settings → People | `/settings/people` | Coming soon (#24, decision 033) |

The workspace pages (Overview, Projects, Billing) stay at `/w/<tenant>`, `/w/<tenant>/projects`
and `/w/<tenant>/billing`, and sit in the sidebar under "Workspace".

## How it works

- **Nav model** (`apps/web/lib/nav.ts`): pure functions for paths, the item list, the current
  item, the Soon badges (`SOON`) and who may add projects. Unit tests: `apps/web/test/nav.test.ts`.
- **Loader** (`apps/web/lib/projectPage.ts`): `loadProjectPage(params, extra?)` parses both IDs
  (bad ID → 404), then in ONE `paidTenant` transaction reads the role, `listProjects`,
  `projectTiers` and the page's own data. A project that is not in this tenant's list → 404.
- **Shell** (`apps/web/components/Shell.tsx`): server component. The dropdown is a `<details>`
  element keyed by project and page, so it closes after a switch. No client JavaScript.
- **Billing page**: before a card is validated it renders without the shell, because every other
  page would send the user back to billing.
- **Incidents per project**: `repo.listOpenIncidents(tx, limit, project?)` filters by project and
  now returns `projectId`.
- **Alert threshold**: `setEmailAlertsAction` moved to `app/w/[tenantId]/p/[projectId]/settings/actions.ts`.
  `alertsPath` redirects to the project's Notifications page; a project that is not in the
  workspace goes to `/w/<tenant>/projects?error=alerts_missing`.

## Data model

No migration. Reads only: `projects`, `incidents`, `poll_runs`, `projects.billing_tier` and
`requests_30d`, all under the tenant's forced RLS.

## Testing

- Unit: `test/nav.test.ts` (paths, order, current item, Soon badges, roles, tile letter, UTC
  format); `test/alerts.test.ts` (redirects per project).
- Postgres: `packages/core/test/db/projects.test.ts` — open incidents for one project only, and an
  empty list for another tenant's project ID.
- E2E: `e2e/specs/nav.uat.spec.ts` UAT-W19 to W22; `alerts.uat.spec.ts` W17 and W18 now use
  project Notifications.
- Mutation checks: dropping the project filter fails the Postgres test; falling back to the first
  project for an unknown ID fails UAT-W21 (200 instead of 404).

## Gotchas

- A project link's accessible name includes its plan badge ("Shop Starter"). Match it by prefix
  in Playwright, not with `exact: true`.
- Two buttons on Notifications start with "Save". Match the email one with `exact: true`.
- `<main>` belongs to the shell. A page under the shell must not render its own `<main>`.
