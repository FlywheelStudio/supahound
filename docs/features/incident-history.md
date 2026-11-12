# Incident history

Issue #44. Decision 035. Builds on project navigation ([project-navigation.md](project-navigation.md), decision 031).

## What it does

On a paid plan, a member opens any incident of a project from the last 30 days.

| Page | Path under `/w/<tenant>/p/<project>` | Shows |
| --- | --- | --- |
| Incidents | `/incidents` | Open and resolved incidents in the window, newest first, 25 to a page; "Older incidents" and "Newest" links |
| Incident detail | `/incidents/<incident>` | Detectors, severity, status; actor alias, requests, findings, first and last seen, duration; signals; summary and likely impact; suggested fix |

The project dashboard and the workspace overview link each open incident to its detail page.

## How it works

- **Window** (decision 035): `last_seen_at` within 30 days, or `status = 'open'`. The engine
  leaves an incident open until its actor acts again, so a quiet open incident stays reachable.
- **Repository** (`packages/core/src/db/repo.ts`):
  - `listIncidentHistory(tx, project, { now, limit, after })` returns `{ incidents, next }`. It
    orders by `(last_seen_at DESC, id DESC)`, fetches `limit + 1` rows, and compares
    `(last_seen_at, id) < (cursor)`. `next` is null on the last page.
  - `getIncident(tx, project, id, now)` returns one incident of this project in the window, or null.
  - The cursor holds epoch microseconds as text, computed in SQL. A JS `Date` holds milliseconds.
- **Web helpers** (`apps/web/lib/incidents.ts`): `parseIncidentId` and `parseCursor` reject bad
  input before any query (a `::uuid` cast would give a 500). `explanationOf` checks the jsonb
  shape and cleans each string with core's `cleanText` (links stripped, length capped).
  `codeSegments` turns `` `identifier` `` into `<code>`. `durationLabel`, `fallbackSummary`.
- **Pages**: both call `loadProjectPage` with the query in its `extra` callback, so membership,
  the paid gate, the project check and the incident read share one transaction. The detail page
  calls `notFound()` when `getIncident` returns null. Labels (`actorAlias`, `detectorLabel`,
  `signalLabel`) come from `packages/core/src/alerts/email.ts`, so the page and the email agree.
- **Nav**: `incidentPath(tenant, project, id)` in `apps/web/lib/nav.ts`. The detail page marks
  "Incidents" as current.

## Data model

No migration. Reads `supahound.incidents` under the tenant's forced RLS, through
`incidents_project_idx (tenant_id, project_id, last_seen_at DESC)`. The `summary` column holds
`{ summary, likelyImpact, nextSteps }` or null.

## External services

None. The page shows text the explainer stored at poll time; it never calls a model.

## Testing

- Postgres (`packages/core/test/db/incidentHistory.test.ts`, 6): window with a stale open incident,
  the 30-day boundary and an old resolved one; stored summary and source; keyset pages at limits
  1, 2, 3 and 6 with ties on `last_seen_at` and rows that differ only in microseconds; an exactly
  full last page; isolation across projects and tenants for list and detail; an empty project.
- Unit (`apps/web/test/incidents.test.ts`, 9): the detail path, ID and cursor parsing, explanation
  shape and cleaning, code segments, durations, the fallback summary.
- E2E (`apps/web/e2e/specs/incidents.uat.spec.ts`): UAT-W23 list and pages, UAT-W24 detail (alias,
  no raw IDs, fallback summary), UAT-W25 seven 404 cases and another workspace's user.
- Mutation checks: see `docs/TESTING.md` (#44 rows).

## Gotchas

- The cursor must carry microseconds. A cursor from a JS `Date` skips rows (tested).
- `summary` is null for incidents that did not page or email. The page must render without it.
- The raw `actor` is `user:<uuid>`. Show it only through `actorAlias`.
- Parse the incident ID and cursor before the query; Postgres casts throw on bad input.
- A resolved incident older than 30 days is a 404, even though the row still exists until a
  retention job deletes it.
