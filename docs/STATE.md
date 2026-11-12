# State

Updated 2026-11-12. The backlog lives in [GitHub issues](https://github.com/FlywheelStudio/supahound/issues),
grouped by [milestone](https://github.com/FlywheelStudio/supahound/milestones) (decision 019).
This file tracks only what is in progress and what is done.

## In progress

| Feature | Issue | Current step | Blocker | WIP doc |
| --- | --- | --- | --- | --- |
| Public release (fair source, FSL-1.1-ALv2) | #63–#68, #82 | Public since 2026-11-10 (#68); site live on supahound.com; app and poller deployed to app.supahound.com on 2026-11-10 (decision 027); the sign-in fix (#87) is live; OAuth app next | OAuth app (#4). Legal review done 2026-11-11 (#81) | [wip/public-release.md](wip/public-release.md) |
| Scan funnel (hackme.si) | #51, #74 | Authorization backbone built; secrets scanner built (client code, source maps, leak paths, decision 026); repositories + other passive checks + web funnel next | Legal review before any active-scan milestone and before the leak-path probe goes public | [wip/scan-funnel.md](wip/scan-funnel.md) |
| Baseline-free detectors (2 and 4) | #3, #5 | Built with 127 tests; live run next | Token with `analytics:read` and a project ref | [wip/baseline-free-detectors.md](wip/baseline-free-detectors.md) |
| Incident engine + ZDR explainer | #6, #15 | Built (Haiku 5.5 + Grok fallback); live call next | AI Gateway key (Pro team) | [wip/incident-explainer.md](wip/incident-explainer.md) |
| Tenant isolation (storage, vault, poller) | #8 | Built; live database, login users and Hyperdrive (session pooler, caching off) up on 2026-11-10; the poller cron runs against it | Asymmetric JWT signing keys (optional: `getClaims()` works without them) | [wip/tenant-isolation.md](wip/tenant-isolation.md) |
| Billing: validated card, 7-day trial, per-project tiers (Starter $19.99, Pro $99 with SMS, Enterprise) | #25 | **Live** on app.supahound.com since 2026-11-11 with live Stripe (deployed from `develop` @ 9bfed15); site repriced (supahound-site #2). Staff exemption (#94, decision 029) built; production migration, config and deploy wait for Erik | Feature doc after the first real customer flow; SMS provider (#32) | [wip/billing.md](wip/billing.md) |
| Web app: auth, onboarding, dashboard | #9 | Sign-in, workspace, overview, OAuth connect built; E2E in CI; project picker shipped; ownership refresh (#10) next | Supahound's Supabase project, OAuth app, email domain | [wip/web-app.md](wip/web-app.md) |

## Completed

| Item | Issue | Shipped | Docs |
| --- | --- | --- | --- |
| Project removal with a grace period: a removed project stays active until its paid period ends and is deleted 7 days later unless an Owner or Admin keeps it; Keep project, re-pick and portal cancel | #118 | 2026-11-12, branch `feature/project-removal-grace`, stacked on the #99 branch; **waits for Erik** (PR, migration `20261112060000`) | [features/project-removal-grace.md](features/project-removal-grace.md), decision 042 |
| Web latency: Worker placed next to Postgres, one round trip to open a transaction, pending bar on links | #115 | 2026-11-12, into `develop` | [features/web-latency.md](features/web-latency.md), decision 039 |
| Security scan domains per project: a verified domain belongs to one project; Owners and Admins attach it; the Security scan tab lists the newest finished scan's findings with the fix | #100 | 2026-11-12, PR #111 into `develop`; waits for the production migration (Erik) before merge | [features/scan-domains.md](features/scan-domains.md), decision 040 |
| One Stripe subscription per project: workspace trial shared by its projects, billed from the day added after it, removal at the period end, Plan & billing page, conversion CLI with dry run | #99 | 2026-11-12, PR into `develop`; **rollout waits for Erik** (migration `20261112050000`, live Stripe portal and dunning settings, deploy, then `pnpm convert-subscriptions`) | [features/project-subscriptions.md](features/project-subscriptions.md), decision 041 |
| Data controls: retention (nothing deleted while a workspace pays), close at the period end with the record kept, disconnect with email and 30-day keep, revoked-grant alert, one free trial ever, subprocessor notice CLI | #43 | 2026-11-12, PR #107 into `develop`; waits for the production migration `20261112030000_data_controls.sql` (Erik) before merge | [features/data-controls.md](features/data-controls.md), decision 037 |
| Posture scan V1: tables without RLS, open policies, views without `security_invoker`, Security Advisor; daily, first poll and Scan now; raises detections on exposed tables | #11 | 2026-11-12, PR #109 into `develop`; waits for the production migration (Erik) before merge | [features/posture-scan.md](features/posture-scan.md), decision 038 |
| People and roles per project: Owner/Admin/Editor/Viewer, RLS by project, email invites (7 days, single use, bound to the address) | #24 | 2026-11-12, PR #105 into `develop`; waits for the production migration (Erik) before merge | [features/project-people.md](features/project-people.md), decision 036 |
| Incident history: 30-day list (open and resolved, keyset pages) and incident detail per project | #44 | 2026-11-12, into `develop` | [features/incident-history.md](features/incident-history.md), decision 035 |
| Project navigation: project dropdown, project dashboard, project settings (notifications with SMS Coming soon, plan) | #98 | 2026-11-11, PR #101 into `develop` | [features/project-navigation.md](features/project-navigation.md), decision 031 |
| Incident alert email: every member, every severity by default, threshold per project | #16 | 2026-11-11, into `develop` | [features/incident-alert-email.md](features/incident-alert-email.md), decision 030 |
| Ownership refresh: RLS policies read in the poll, detector 2 coverage states | #10 | 2026-11-09, PR #62 into `develop` | [features/ownership-refresh.md](features/ownership-refresh.md), decision 024 |
| Project picker: pick and remove watched projects | #9 | 2026-11-09, PR #61 into `develop` | [features/project-picker.md](features/project-picker.md), decision 022 |
| GitHub workflow: CI, templates, labels, milestones, issues, E2E + UAT, project docs (chore, no feature doc) | #2 | 2026-11-09, PR #1 into `develop` | [WORKFLOW.md](WORKFLOW.md), [TESTING.md](TESTING.md), decisions 019 and 020 |
| Marketing site (supahound.com): 62 pages, SEO/AEO, Coming soon registry | #34, #40 | 2026-11-09, PRs #45 and #53 into `develop` | Moved to the private repo `FlywheelStudio/supahound-site` (decision 025); decisions 017 and 021 |

A feature moves here when its feature doc exists in `docs/features/`.

## Next up (Validate milestone, gate: log fields confirmed)

#3 JWT fields in live logs · #4 Supabase OAuth app · #5 live detector run · #6 live gateway call ·
#7 interviews. All five need something from Erik (`needs-erik`).
