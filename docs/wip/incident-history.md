# Incident history (WIP)

Issue #44. Branch `feature/incident-history`. Decision 035.

## Goal

On a paid plan, a member opens any incident of a project from the last 30 days: a list, newest
first, and a detail page with the actor, detectors, signals, counts, time range, summary and
suggested fix.

## Approach

- Core: `listIncidentHistory` and `getIncident` in `packages/core/src/db/repo.ts`. Keyset on
  `(last_seen_at DESC, id DESC)`. The cursor holds epoch microseconds, read from SQL.
- Window: `last_seen_at` in the last 30 days, or the incident is still open (decision 035).
- Web: `apps/web/lib/incidents.ts` parses the cursor and the incident ID, and shapes the stored
  explanation. The pages use `loadProjectPage`.
- No migration: `incidents_project_idx (tenant_id, project_id, last_seen_at DESC)` covers it.

## Files expected to change

`packages/core/src/db/repo.ts`, `packages/core/src/alerts/email.ts` (export the labels),
`apps/web/lib/incidents.ts`, `apps/web/lib/nav.ts`, the incidents pages, the dashboard,
tests in `packages/core/test/db/`, `apps/web/test/`, `apps/web/e2e/specs/`, docs.

## Build log

- 2026-11-12: started.
