# Marketing site (WIP)

Goal: public site on supahound.com with AEO/SEO best practice, clear pricing and sign-up, privacy
policy, terms, "Made by Flywheel" footer, platform landing pages + guides, Postgres guides,
competitor comparisons and a /hack-me page. Decision 017.

## Approach

- `(marketing)` route group in `apps/web/app`; typed content in `apps/web/content/`.
- `generateStaticParams` + `dynamicParams = false` for every data-driven route.
- JSON-LD: Organization, SoftwareApplication with offers, BreadcrumbList, FAQPage, Article.
- sitemap.ts, robots.ts (AI crawlers allowed, private paths disallowed), /llms.txt.
- Middleware skips the session refresh for allowlisted public paths.

## Build log

- 2026-11-08: Branched `feature/marketing-site` from main. Middleware allowlist + tests.
  Research agents started for competitors and platform facts.

## Open questions

- Legal review of the privacy policy and terms before launch.
- Which branch the PR targets: no `develop` branch exists yet.
