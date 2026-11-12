# Docs index

| Doc | Description |
| --- | --- |
| [../README.md](../README.md), [../CONTRIBUTING.md](../CONTRIBUTING.md), [../SECURITY.md](../SECURITY.md), [../CLA.md](../CLA.md), [../LICENSE.md](../LICENSE.md) | Public-repo front door: what it is, how to contribute, vulnerability reporting, the CLA, FSL-1.1-ALv2 |
| [STATE.md](STATE.md) | In progress and completed; the backlog is in GitHub issues |
| [ARCHITECTURE.md](ARCHITECTURE.md) | System diagram, packages, one poll step by step, isolation layers, data model |
| [ROADMAP.md](ROADMAP.md) | Phases, gates, milestones, V1 scope status with issue links |
| [TESTING.md](TESTING.md) | Test tiers, commands, E2E stack, UAT catalogue, mutation checks |
| [self-hosting.md](self-hosting.md) | Run Supahound on your own Supabase and Cloudflare accounts: every key, step and limit (alpha) |
| [WORKFLOW.md](WORKFLOW.md) | Issue → branch → PR → develop → main; labels, automation, rules |
| [features/scan-domains.md](features/scan-domains.md) | Security scan domains per project (#100): one project per verified domain, attach and detach by Owners and Admins, the Security scan tab, RLS on the scan tables, tests |
| [features/project-removal-grace.md](features/project-removal-grace.md) | Project removal with a grace period (decision 042): active until the period ends, deleted 7 days later unless kept; Keep project, re-pick, portal cancel by webhook, the data job, tests |
| [features/project-subscriptions.md](features/project-subscriptions.md) | One Stripe subscription per project (#99): shared workspace trial, reconcile, removal at the period end, Plan & billing, conversion CLI, rollout steps, tests |
| [features/data-controls.md](features/data-controls.md) | Data controls (#43): "paying" keeps all data; retention job; close at the period end, purge keeps the record; disconnect and revoked-grant emails; one trial ever; subprocessor notice CLI; tests |
| [features/posture-scan.md](features/posture-scan.md) | Posture scan (#11): RLS coverage, open policies, views, Security Advisor; first poll, daily and Scan now; severity raise; fix prompts; tests |
| [features/project-people.md](features/project-people.md) | People and roles per project (#24): Owner/Admin/Editor/Viewer, RLS by project, email invites, the role matrix, tests |
| [features/web-latency.md](features/web-latency.md) | Web latency: Worker placed next to Postgres, one round trip to open a transaction, pending bar on links, no loading.tsx |
| [features/incident-history.md](features/incident-history.md) | Incident history (#44): 30-day list per project with keyset pages, incident detail, 404 rules, tests |
| [features/project-navigation.md](features/project-navigation.md) | Project navigation (#98): project dropdown, project dashboard and settings, the URL holds the project |
| [features/incident-alert-email.md](features/incident-alert-email.md) | Incident alert email (#16): threshold per project, the incident row as outbox, tests; recipients per project since #24 |
| [features/ownership-refresh.md](features/ownership-refresh.md) | Ownership refresh (#10): RLS policies read in the poll, detector 2 coverage states, tests |
| [features/project-picker.md](features/project-picker.md) | Project picker (#9): pick and remove watched projects, Management API client, tests |
| [wip/public-release.md](wip/public-release.md) | Public release: what PR #69 did, the rehearsal and the publish steps left |
| [wip/scan-funnel.md](wip/scan-funnel.md) | Scan funnel (hackme.si): authorization backbone and secrets scanner built, other passive checks + web funnel next |
| [wip/baseline-free-detectors.md](wip/baseline-free-detectors.md) | Detectors 2 and 4 prototype: status, field paths, known gaps |
| [wip/billing.md](wip/billing.md) | Billing: validated card ($1 hold), 7-day trial, the gate, Stripe webhooks |
| [wip/web-app.md](wip/web-app.md) | Web app: magic-link auth, onboarding, dashboard, setup steps |
| [wip/tenant-isolation.md](wip/tenant-isolation.md) | Multi-tenant storage, RLS, token vault, poller |
| [wip/incident-explainer.md](wip/incident-explainer.md) | Incident engine and ZDR-only LLM explainer |
| [decisions/001-typescript-node-worker.md](decisions/001-typescript-node-worker.md) | TypeScript on Node.js 22+, no framework |
| [decisions/002-ownership-from-rls-policies.md](decisions/002-ownership-from-rls-policies.md) | Ownership from RLS policies, per command, not column names |
| [decisions/003-service-role-network-memory.md](decisions/003-service-role-network-memory.md) | Service-role networks learned on the first poll |
| [decisions/004-tenant-isolation.md](decisions/004-tenant-isolation.md) | Postgres with forced RLS, scoped transactions, per-tenant token keys |
| [decisions/005-zdr-only-model-calls.md](decisions/005-zdr-only-model-calls.md) | Every model call uses zero data retention through one module |
| [decisions/006-no-cross-tenant-learning.md](decisions/006-no-cross-tenant-learning.md) | No fleet priors or other learning across tenants |
| [decisions/007-share-patterns-not-data.md](decisions/007-share-patterns-not-data.md) | Aggregate patterns may cross tenants; data never does (supersedes 006) |
| [decisions/008-supabase-and-cloudflare-hosting.md](decisions/008-supabase-and-cloudflare-hosting.md) | Cloudflare Workers + Supabase Postgres via Hyperdrive, caching off |
| [decisions/009-auth-supabase-magic-link.md](decisions/009-auth-supabase-magic-link.md) | Supabase Auth magic links, emails sent by a Cloudflare Worker |
| [decisions/010-ui-nextjs-on-workers.md](decisions/010-ui-nextjs-on-workers.md) | Next.js on Cloudflare Workers with vinext |
| [decisions/011-models-haiku-and-grok.md](decisions/011-models-haiku-and-grok.md) | Haiku 5.5, Grok 4.20 non-reasoning fallback, Luna dropped |
| [decisions/012-connect-with-supabase-oauth.md](decisions/012-connect-with-supabase-oauth.md) | Supabase OAuth connect with bound state, PKCE and locked refresh |
| [decisions/013-billing-stripe.md](decisions/013-billing-stripe.md) | Stripe Checkout and webhooks, tenant set server-side |
| [decisions/014-email-cloudflare.md](decisions/014-email-cloudflare.md) | Cloudflare Email Service for magic links, alerts and digests |
| [decisions/015-name-supahound.md](decisions/015-name-supahound.md) | The product is named Supahound; every identifier follows |
| [decisions/016-scan-funnel.md](decisions/016-scan-funnel.md) | hackme.si scan funnel: shared tenancy, DNS-TXT + scope-lock gates, passive first |
| [decisions/017-marketing-site.md](decisions/017-marketing-site.md) | Marketing site in the web app on supahound.com (moved to a private repo by 025) |
| [decisions/018-vercel-ai-sdk.md](decisions/018-vercel-ai-sdk.md) | Keep the Vercel AI SDK + Vercel AI Gateway; Cloudflare AI Gateway declined on ZDR coverage |
| [decisions/019-github-issues-and-three-branches.md](decisions/019-github-issues-and-three-branches.md) | GitHub issues hold the work; feature / develop / main; CI gates merges |
| [decisions/020-e2e-with-fake-supabase-auth.md](decisions/020-e2e-with-fake-supabase-auth.md) | E2E runs the built Worker, Postgres and a fake Supabase Auth |
| [decisions/021-coming-soon-features.md](decisions/021-coming-soon-features.md) | Unbuilt features show Coming soon via one registry tied to issues; hello@ only |
| [decisions/022-remove-project-keeps-audit-log.md](decisions/022-remove-project-keeps-audit-log.md) | Removing a project deletes its history, keeps its audit rows; typed-name confirm (point 3 superseded by 042) |
| [decisions/023-oauth-scope-projects-read.md](decisions/023-oauth-scope-projects-read.md) | OAuth adds read-only `projects:read` for the project picker (amends 012) |
| [decisions/024-ownership-refresh-and-detector-coverage.md](decisions/024-ownership-refresh-and-detector-coverage.md) | Ownership refreshes in the poll every 24 h; detector 2 coverage has three states |
| [decisions/025-public-release-fsl.md](decisions/025-public-release-fsl.md) | Public repo under FSL-1.1-ALv2 (fair source), short CLA, marketing site to a private repo |
| [decisions/026-scan-secrets-leak-paths.md](decisions/026-scan-secrets-leak-paths.md) | Scan funnel secrets scanner: client code plus a fixed leak-path list; scope on every hop; no secret in evidence (amends 016) |
| [decisions/027-hosted-deploy-config-private.md](decisions/027-hosted-deploy-config-private.md) | Flywheel's hosted deploy config in a private repo; public `wrangler.jsonc` files stay templates; deploys from a fresh clone |
| [decisions/028-card-validated-trial.md](decisions/028-card-validated-trial.md) | A validated card ($1 hold, released) before any use; 7-day trial; per project $19.99 (Starter) or $99 (Pro, above 1M requests/30 days); Enterprise above 10M (supersedes 013's plans) |
| [decisions/029-staff-billing-exemption.md](decisions/029-staff-billing-exemption.md) | Staff workspaces need no card while a staff member (exempt email domain) is their only owner; a customer workspace with staff in it still pays |
| [decisions/030-incident-alert-email.md](decisions/030-incident-alert-email.md) | Incident alerts email every member; every severity by default, changeable per project; the incident row is the outbox (builds on 014) |
| [decisions/031-project-navigation.md](decisions/031-project-navigation.md) | Project dropdown in a sidebar shell; the URL holds the project; other workspaces' project IDs 404; alert threshold moves to project settings (amends 030) |
| [decisions/032-subscription-per-project.md](decisions/032-subscription-per-project.md) | One Stripe subscription per project; the workspace keeps the customer and card (supersedes 028's seats; built in #99, how: 041) |
| [decisions/033-people-per-project.md](decisions/033-people-per-project.md) | Per-project roles Owner/Admin/Editor/Viewer with email invites, enforced by RLS (built, #24; how: 036) |
| [decisions/034-scan-domains-per-project.md](decisions/034-scan-domains-per-project.md) | A verified scan domain belongs to one project; the project's Security scan tab lists them (built, #100; how: 040) |
| [decisions/036-project-roles-and-invites.md](decisions/036-project-roles-and-invites.md) | Project roles: workspace owners/admins implicit on every project, RLS by project, the role matrix, single-use email-bound invites, alerts to the project's people (builds 033, amends 030) |
| [decisions/037-data-controls.md](decisions/037-data-controls.md) | Data controls with Erik's answers: nothing deleted while paying; close cancels at the period end and never deletes the record or payment history; disconnect keeps history 30 days and emails; revoked grant detected from `invalid_grant`; one free trial per workspace and per owner; notifier role |
| [decisions/038-posture-scan.md](decisions/038-posture-scan.md) | Posture scan in the poll: catalog SQL plus the Security Advisor, `public` only, severities by grants, structured evidence only, per-source results, raise on cross-tenant findings, Scan now for editors and up |
| [decisions/040-scan-domain-links.md](decisions/040-scan-domain-links.md) | Scan domain links: a bridge table, one project per verified domain, Owners and Admins link, scan data follows the link in RLS, unlinked domains are workspace data, evidence allowlist (builds 034) |
| [decisions/035-incident-history-window.md](decisions/035-incident-history-window.md) | Incident history: last seen in 30 days or still open; keyset pages; actor alias; the suggested fix is the explainer's next steps, no generated SQL |
| [decisions/039-web-latency.md](decisions/039-web-latency.md) | Web latency: placement region next to Postgres, `begin()` in one round trip, asymmetric JWT keys, why not loading.tsx |
| [decisions/041-project-subscriptions-build.md](decisions/041-project-subscriptions-build.md) | How per-project billing is built: billing model column, card check makes no subscription, standing, reconcile, no minimum charge, removal keeps payment history, "paying" per project, conversion with `billing_cycle_anchor` at the seat period end (amends 028, 037) |
| [decisions/042-project-removal-grace.md](decisions/042-project-removal-grace.md) | A removed project stays active until its paid period ends and is deleted 7 days later unless an Owner or Admin keeps it; portal cancel by webhook; supersedes 022 point 3 and 041 point 7 |
