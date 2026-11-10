# State

Updated 2026-11-10. The backlog lives in [GitHub issues](https://github.com/FlywheelStudio/supahound/issues),
grouped by [milestone](https://github.com/FlywheelStudio/supahound/milestones) (decision 019).
This file tracks only what is in progress and what is done.

## In progress

| Feature | Issue | Current step | Blocker | WIP doc |
| --- | --- | --- | --- | --- |
| Public release (fair source, FSL-1.1-ALv2) | #63–#68, #82 | Public since 2026-11-10 (#68); site live on supahound.com; app and poller deployed to app.supahound.com on 2026-11-10 (decision 027); Erik's sign-in test and the OAuth app next | OAuth app (#4), legal review of `CLA.md` and `LICENSE.md` | [wip/public-release.md](wip/public-release.md) |
| Scan funnel (hackme.si) | #51, #74 | Authorization backbone built; secrets scanner built (client code, source maps, leak paths, decision 026); repositories + other passive checks + web funnel next | Legal review before any active-scan milestone and before the leak-path probe goes public | [wip/scan-funnel.md](wip/scan-funnel.md) |
| Baseline-free detectors (2 and 4) | #3, #5 | Built with 127 tests; live run next | Token with `analytics:read` and a project ref | [wip/baseline-free-detectors.md](wip/baseline-free-detectors.md) |
| Incident engine + ZDR explainer | #6, #15 | Built (Haiku 5.5 + Grok fallback); live call next | AI Gateway key (Pro team) | [wip/incident-explainer.md](wip/incident-explainer.md) |
| Tenant isolation (storage, vault, poller) | #8 | Built; live database, login users and Hyperdrive (session pooler, caching off) up on 2026-11-10; the poller cron runs against it | Asymmetric JWT signing keys (optional: `getClaims()` works without them) | [wip/tenant-isolation.md](wip/tenant-isolation.md) |
| Web app: auth, onboarding, dashboard | #9 | Sign-in, workspace, overview, OAuth connect built; E2E in CI; project picker shipped; ownership refresh (#10) next | Supahound's Supabase project, OAuth app, email domain | [wip/web-app.md](wip/web-app.md) |

## Completed

| Item | Issue | Shipped | Docs |
| --- | --- | --- | --- |
| Ownership refresh: RLS policies read in the poll, detector 2 coverage states | #10 | 2026-11-09, PR #62 into `develop` | [features/ownership-refresh.md](features/ownership-refresh.md), decision 024 |
| Project picker: pick and remove watched projects | #9 | 2026-11-09, PR #61 into `develop` | [features/project-picker.md](features/project-picker.md), decision 022 |
| GitHub workflow: CI, templates, labels, milestones, issues, E2E + UAT, project docs (chore, no feature doc) | #2 | 2026-11-09, PR #1 into `develop` | [WORKFLOW.md](WORKFLOW.md), [TESTING.md](TESTING.md), decisions 019 and 020 |
| Marketing site (supahound.com): 62 pages, SEO/AEO, Coming soon registry | #34, #40 | 2026-11-09, PRs #45 and #53 into `develop` | Moved to the private repo `FlywheelStudio/supahound-site` (decision 025); decisions 017 and 021 |

A feature moves here when its feature doc exists in `docs/features/`.

## Next up (Validate milestone, gate: log fields confirmed)

#3 JWT fields in live logs · #4 Supabase OAuth app · #5 live detector run · #6 live gateway call ·
#7 interviews. All five need something from Erik (`needs-erik`).
