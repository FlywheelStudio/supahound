# 035: Incident history: the 30-day window keeps open incidents; the fix is the explainer's next steps

Date: 2026-11-12 · Issue #44 · Builds on 030 (alert email) and 031 (project navigation)

## Context

Issue #44 adds a 30-day incident list and an incident detail page per project. The pricing page
sells "30-day incident history". Three questions needed an answer:

1. **Which incidents are in the window?** The engine (`packages/core/src/incidents/engine.ts`)
   resolves an incident only when the same actor acts again after the 15-minute window. An actor
   who goes quiet leaves the incident open with an old `last_seen_at`. The project dashboard lists
   every open incident, whatever its age.
2. **What is the "suggested SQL fix"?** The explainer stores `{ summary, likelyImpact, nextSteps }`
   in `incidents.summary` (model or template text, both validated). It stores no SQL. The
   validator allows only numbers and identifiers from the incident's features, so a model may not
   write free SQL today.
3. **How does the list page?** Offset pages repeat or skip rows when new incidents arrive.

## Decision

1. **Window:** an incident is in the history when its `last_seen_at` is within the last 30 days,
   or it is still open. The list and the detail use the same rule. A resolved incident older than
   30 days is a 404, the same as an incident that does not exist.
2. **Order and pages:** newest first by `last_seen_at`, then `id`. Keyset pages of 25. The cursor
   in the URL is `?before=<epoch microseconds>_<incident id>`, read from SQL, because a JS `Date`
   drops the microseconds and a cursor built from one skips rows. A malformed cursor is a 404.
3. **Detail:** the actor shows as an alias ("User 1a2b3c4d" or "The service-role key"), as in
   the alert email, never as the raw user ID. Detectors and signals use the alert email's labels.
4. **Suggested fix = `nextSteps`.** The page shows the explainer's next steps as "Suggested fix",
   with identifiers in code style. Supahound does not generate SQL. An incident with no stored
   explanation (the explainer runs only for incidents that page or email) shows its facts and a
   summary built from its counts.
5. **Isolation:** the detail query filters on tenant, project, window and ID inside the same
   paid-gate transaction as the project list (`loadProjectPage`). Another workspace's or project's
   incident ID, a made-up ID and a malformed ID are all a 404.
6. **No migration.** `incidents_project_idx (tenant_id, project_id, last_seen_at DESC)` serves the
   range scan. Ties on `last_seen_at` sort in memory.

## Alternatives considered

- **A strict 30-day window on `last_seen_at`.** Rejected: a quiet open incident would show on the
  dashboard but 404 from its own link.
- **Generate a SQL fix (for example a corrected RLS policy).** Rejected for now: it needs new
  validator rules for SQL text, and a wrong policy is worse than a pointer. A later decision can
  add it.
- **Offset pagination.** Rejected: rows shift between pages while the poller writes.

## Consequences

- A retention job (data controls) must not delete open incidents by `last_seen_at` alone, or the
  dashboard and the history disagree.
- The alert email can link to the incident detail page in a later change.
