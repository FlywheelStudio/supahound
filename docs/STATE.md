# State

Updated 2026-11-09. The backlog lives in [GitHub issues](https://github.com/FlywheelStudio/supahound/issues),
grouped by [milestone](https://github.com/FlywheelStudio/supahound/milestones) (decision 019).
This file tracks only what is in progress and what is done.

## In progress

| Feature | Issue | Current step | Blocker | WIP doc |
| --- | --- | --- | --- | --- |
| Baseline-free detectors (2 and 4) | #3, #5 | Built with 127 tests; live run next | Token with `analytics:read` and a project ref | [wip/baseline-free-detectors.md](wip/baseline-free-detectors.md) |
| Incident engine + ZDR explainer | #6, #15 | Built (Haiku 5.5 + Grok fallback); live call next | AI Gateway key (Pro team) | [wip/incident-explainer.md](wip/incident-explainer.md) |
| Tenant isolation (storage, vault, poller) | #8 | Built; Cloudflare poller done; needs a live database | Supahound's Supabase project + Hyperdrive | [wip/tenant-isolation.md](wip/tenant-isolation.md) |
| Web app: auth, onboarding, dashboard | #9 | Sign-in, workspace, overview, OAuth connect built; E2E in CI; project picker next | Supahound's Supabase project, OAuth app, email domain | [wip/web-app.md](wip/web-app.md) |

## Completed

| Item | Issue | Shipped | Docs |
| --- | --- | --- | --- |
| GitHub workflow: CI, templates, labels, milestones, issues, E2E + UAT, project docs (chore, no feature doc) | #2 | 2026-11-09, PR #1 into `develop` | [WORKFLOW.md](WORKFLOW.md), [TESTING.md](TESTING.md), decisions 019 and 020 |

No product feature is complete yet. A feature moves here when its feature doc exists in `docs/features/`.

## Next up (Validate milestone, gate: log fields confirmed)

#3 JWT fields in live logs · #4 Supabase OAuth app · #5 live detector run · #6 live gateway call ·
#7 interviews. All five need something from Erik (`needs-erik`).
