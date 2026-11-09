# 017: The marketing site lives in the web app, on supahound.com

Date: 2026-11-08

## Context

Supahound needs a public site: landing page, pricing, sign-up, legal pages, one landing page and
one guide per AI app builder, Postgres guides, competitor comparisons and a page for the free
external scan ("hack me", decision 016). Erik made four calls on 2026-11-08.

## Decision

1. **Domain.** The canonical domain is `https://supahound.com`. One constant (`SITE_URL` in
   `apps/web/content/site.ts`) feeds canonical URLs, the sitemap, robots.txt and JSON-LD. Never
   derive public URLs from `APP_URL`.
2. **Platforms.** Sixteen builders get a landing page and a guide: Lovable, Bolt.new, v0, Replit,
   Cursor, Windsurf, Claude Code, Base44, Anything, Firebase Studio, Tempo, Softgen, Rork, Same,
   Emergent, GitHub Copilot. Supabase gets its own landing page. A platform with no native Supabase
   integration says so and covers the manual setup.
3. **Hack me.** The scan page is `/hack-me` on the same site. Its CTA goes to sign-up until the
   funnel ships. It describes only what decision 016 allows: DNS-TXT proof, apex scope, passive
   checks.
4. **Legal.** The contracting party is Flywheel Studio LLC under Texas law; contact
   legal@flywheel.so (superseded by decision 021: hello@flywheel.so only).
5. **Code location.** The pages are a `(marketing)` route group in `apps/web`, with content as
   typed TypeScript in `apps/web/content/`. No CMS, analytics, font host or other new service.
6. **Middleware.** A GET or HEAD to an allowlisted public path (`isPublicMarketingPath` in
   `lib/security.ts`) skips the Supabase session refresh and gets a public `Cache-Control`. Every
   other path keeps the refresh. Marketing pages never read the session.

## Alternatives considered

- **A separate static site.** Rejected: a second deploy and a second domain to keep in sync, and
  sign-up lives in the web app anyway.
- **A headless CMS.** Rejected: a new service (Erik's rule), and the content changes with the code.
- **A denylist of private paths in middleware.** Rejected: a new private route would be public by
  default. The allowlist fails closed.

## Consequences

- Competitor and platform facts go stale. Each compare page shows its check date and sources.
- Public pages can sit in Cloudflare's cache, so they must never render per-user content.
