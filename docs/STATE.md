# State

Updated 2026-10-27.

## In progress

| Feature | Current step | Blocker | WIP doc |
| --- | --- | --- | --- |
| Marketing site (supahound.com) | 62 pages built and verified; PR into develop next | Legal review; incident retention job; 276b883 placement | [wip/marketing-site.md](wip/marketing-site.md) |
| Tenant isolation (storage, vault, poller) | Built; Cloudflare poller and memberships done; needs live Supabase + Hyperdrive | Supahound Supabase project | [wip/tenant-isolation.md](wip/tenant-isolation.md) |
| Incident engine + ZDR explainer | Built (Haiku 5.5 + Grok fallback); live call next | AI Gateway key (Pro team) | [wip/incident-explainer.md](wip/incident-explainer.md) |
| Web app: auth, onboarding, dashboard | Sign-in, workspace, overview, Supabase OAuth connect built; project picker next | Supahound Supabase project, Hyperdrive, email domain | [wip/web-app.md](wip/web-app.md) |
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
- Web: project picker + ownership load, Stripe billing, alert email, signed webhooks, team invites, Turnstile, shadcn/ui
- Weekly digest; agency client report (V2)
- Detectors 1, 3 and 5; posture scan
