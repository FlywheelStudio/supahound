# State

Updated 2026-11-10. The backlog lives in [GitHub issues](https://github.com/FlywheelStudio/supahound/issues),
grouped by [milestone](https://github.com/FlywheelStudio/supahound/milestones) (decision 019).
This file tracks only what is in progress and what is done.

## In progress

| Feature | Issue | Current step | Blocker | WIP doc |
| --- | --- | --- | --- | --- |
| Public release (fair source, FSL-1.1-ALv2) | #63–#68 | Public since 2026-11-10 (#68): ruleset, secret scanning and private reporting on; site live on supahound.com; rehearsal (#67) and app deploy next | OAuth app (#4), live database (#8), legal review (#81) | [wip/public-release.md](wip/public-release.md) |
| Scan funnel (hackme.si) | #51, #74 | Authorization backbone built; secrets scanner built (client code, source maps, leak paths, decision 026); repositories + other passive checks + web funnel next | Legal review before any active-scan milestone and before the leak-path probe goes public | [wip/scan-funnel.md](wip/scan-funnel.md) |
| Baseline-free detectors (2 and 4) | #3, #5 | Built; ownership now refreshes from RLS policies (#10); live run next | Token with `analytics:read` and a project ref | [wip/baseline-free-detectors.md](wip/baseline-free-detectors.md) |
| Incident engine + ZDR explainer | #6, #15 | Built (Haiku 5.5 + Grok fallback); live call next | AI Gateway key (Pro team) | [wip/incident-explainer.md](wip/incident-explainer.md) |
| Tenant isolation (storage, vault, poller) | #8 | Built; Cloudflare poller done; needs a live database | Supahound's Supabase project + Hyperdrive | [wip/tenant-isolation.md](wip/tenant-isolation.md) |
| Web app: auth, onboarding, dashboard | #16, #25 | Sign-in, workspace, overview, OAuth connect, project picker (#9) and coverage notes (#10) built; no marketing pages (decision 025); alert email (#16) and Stripe for the hosted product (#25) next | Supahound's Supabase project, OAuth app, email domain; app deploy to `app.supahound.com` is #82 | [wip/web-app.md](wip/web-app.md) |

## Completed

| Item | Issue | Shipped | Docs |
| --- | --- | --- | --- |
| Ownership refresh: RLS policies read in the poll, detector 2 coverage states | #10 | 2026-11-09, PR #62 into `develop` | [features/ownership-refresh.md](features/ownership-refresh.md), decision 024 |
| Project picker: pick and remove watched projects | #9 | 2026-11-09, PR #61 into `develop` | [features/project-picker.md](features/project-picker.md), decision 022 |
| GitHub workflow: CI, templates, labels, milestones, issues, E2E + UAT, project docs (chore, no feature doc) | #2 | 2026-11-09, PR #1 into `develop` | [WORKFLOW.md](WORKFLOW.md), [TESTING.md](TESTING.md), decisions 019 and 020 |
| Marketing site (supahound.com): 62 pages, SEO/AEO, Coming soon registry | #34, #40 | 2026-11-09, PRs #45 and #53 into `develop`; live on `supahound.com` and `www` since 2026-11-10 | Moved to the private repo `FlywheelStudio/supahound-site` (decision 025); decisions 017 and 021 |

A feature moves here when its feature doc exists in `docs/features/`.

## Next up (Validate milestone, gate: log fields confirmed)

#3 JWT fields in live logs · #4 Supabase OAuth app · #5 live detector run · #6 live gateway call ·
#7 interviews. All five need something from Erik (`needs-erik`). #4 and #8 also unblock the app
deploy to `app.supahound.com` and the self-hosting rehearsal (#67).
