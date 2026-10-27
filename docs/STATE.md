# State

Updated 2026-10-27.

## In progress

| Feature | Current step | Blocker | WIP doc |
| --- | --- | --- | --- |
| Tenant isolation (storage, vault, poller) | Built and tested on a local cluster; needs a deploy target | Postgres host (Hetzner + Coolify?) | [wip/tenant-isolation.md](wip/tenant-isolation.md) |
| Incident engine + ZDR explainer | Built and tested with mocks and a captured HTTP body; live call next | AI Gateway key (Pro team) | [wip/incident-explainer.md](wip/incident-explainer.md) |
| Baseline-free detectors (2 and 4) | Code and 127 tests done; live run | Token with `analytics:read` and a project ref | [wip/baseline-free-detectors.md](wip/baseline-free-detectors.md) |

## Completed

None yet.

## Backlog

From the PRD "This week" list:

- Confirm JWT subject, query string and response size fields on a live project (`discover-keys` is ready)
- Register the Supabase OAuth app; confirm what `supabase_read_only_user` can read
- Book 10–15 builder and 3–5 agency interviews

- Ownership refresh: read `pg_policies` through the read-only SQL endpoint into `projects.ownership`
  (without it, detector 2 has no owner columns on a live project)
- Supabase OAuth connect flow and token refresh
- Mark poll runs stuck in `running` (a crash after the start transaction) as `unable_to_assess`
- Alert delivery (email, signed webhooks), weekly digest, agency dashboard
- Detectors 1, 3 and 5; posture scan
