# Docs index

| Doc | Description |
| --- | --- |
| [STATE.md](STATE.md) | In progress and completed; the backlog is in GitHub issues |
| [ARCHITECTURE.md](ARCHITECTURE.md) | System diagram, packages, one poll step by step, isolation layers, data model |
| [ROADMAP.md](ROADMAP.md) | Phases, gates, milestones, V1 scope status with issue links |
| [TESTING.md](TESTING.md) | Test tiers, commands, E2E stack, UAT catalogue, mutation checks |
| [WORKFLOW.md](WORKFLOW.md) | Issue → branch → PR → develop → main; labels, automation, rules |
| [wip/scan-funnel.md](wip/scan-funnel.md) | Scan funnel (hackme.si): authorization backbone built, passive + web funnel next |
| [wip/baseline-free-detectors.md](wip/baseline-free-detectors.md) | Detectors 2 and 4 prototype: status, field paths, known gaps |
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
| [decisions/025-public-release-fsl.md](decisions/025-public-release-fsl.md) | Public repo under FSL-1.1-ALv2 (fair source), short CLA, marketing site to a private repo |
