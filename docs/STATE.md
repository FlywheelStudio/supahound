# State

Updated 2026-10-27.

## In progress

| Feature | Current step | Blocker | WIP doc |
| --- | --- | --- | --- |
| Tenant isolation (storage, vault, poller) | Scope keys, schema + RLS | None | [wip/tenant-isolation.md](wip/tenant-isolation.md) |
| Incident engine + ZDR explainer | Not started | AI Gateway key for a live check | [wip/incident-explainer.md](wip/incident-explainer.md) |
| Baseline-free detectors (2 and 4) | Code and 127 tests done; live run | Token with `analytics:read` and a project ref | [wip/baseline-free-detectors.md](wip/baseline-free-detectors.md) |

## Completed

None yet.

## Backlog

From the PRD "This week" list:

- Confirm JWT subject, query string and response size fields on a live project (`discover-keys` is ready)
- Register the Supabase OAuth app; confirm what `supabase_read_only_user` can read
- Book 10–15 builder and 3–5 agency interviews

From the PRD V1 scope: poller, incident engine, detectors 1, 3 and 5, posture scan, alerts.
