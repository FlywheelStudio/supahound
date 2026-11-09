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
- 2026-11-08: Home, pricing, hack-me, privacy, terms; header, footer ("Made by flywheel.so",
  non-affiliation line), JSON-LD helpers (`lib/seo.ts`).
- 2026-11-08: Another session committed this WIP as fdfb7fb and added decision 018 (276b883) on
  this branch; both unpushed. 276b883 is about the scan funnel, so Erik decides where it lives.
- 2026-11-09: Research agents failed on a network error and were resumed. Postgres guides (9) in
  `content/postgres.ts`; templates for platform landing, platform guide and compare pages;
  sitemap.ts, robots.ts (AI crawlers allowed), /llms.txt; `content/routes.ts` is the one list of
  public URLs. `test/content.test.ts` checks titles, descriptions, links, duplicates, pricing,
  JSON-LD escaping. OG image rendered with headless Chrome into `public/og.png`.
- 2026-11-09: Competitor research verified by hand (prices for SupaExplorer and Vibe App Scanner,
  Supabase Security monitor agent page, Aikido Supabase OAuth, CVE-2025-48757 "disputed" tag).
  Corrections given to writers: the Supabase agent page does not say per-user vs aggregate;
  Firebase Studio docs give no sunset date; Windsurf docs now say "Devin Desktop".
  11 compare pages written. Platform content split into `content/platforms/groupA.ts` and
  `groupB.ts` so two writers cannot collide.
- 2026-11-09: Bug: `a { color: inherit }` in globals.css sat outside a cascade layer and beat
  Tailwind v4 utilities, so every dark button (including /login) showed no text. Moved base
  styles into `@layer base`. Checked by screenshot at 1280px and in a 390px iframe (headless
  Chrome has a minimum window width, so a 390px window screenshot is not a real phone width).
- Verification on the built Worker (`wrangler dev` on dist, dummy Hyperdrive string): every
  sitemap URL returns 200 with one h1, the right canonical, parseable JSON-LD (Organization,
  BreadcrumbList, FAQPage/TechArticle), og:image, the flywheel.so footer link and no
  Set-Cookie; unknown slugs return 404; /login stays `private, no-store`. Script:
  `checkhtml.py` (scratchpad, not committed).

- 2026-11-09: 17 platform entries written (groupA: supabase, lovable, bolt, v0, softgen, rork,
  same, tempo, replit; groupB: cursor, windsurf, claude-code, github-copilot, anything, base44,
  firebase-studio, emergent). Lovable April 2026 API flaw checked against the TNW source by hand.
  Writers dropped every claim they could not source (list in their reports: Firebase Studio
  sunset date, Bolt Database provider, Rork Cloud provider, Escape.tech totals, Tempo dates).
- 2026-11-09: Sign-up made explicit: CTAs go to `/login?signup=1` (`&plan=<id>` from pricing);
  `lib/signup.ts` switches the heading, button and note, and names a paid plan. Sign-in links
  stay `/login`. Dead `?next=/hack-me` removed (the email hook does not carry `next`).
- Page check moved into the repo: `apps/web/scripts/check-pages.py`. Run the built Worker
  (`CLOUDFLARE_HYPERDRIVE_LOCAL_CONNECTION_STRING_HYPERDRIVE_APP=postgres://x:x@127.0.0.1:5999/x
  npx wrangler dev --config dist/server/wrangler.json --port 8788`), then
  `python3 -I scripts/check-pages.py`. Proved it fails: adding `/login` exits 1.
- Cache check: client navigation fetches `<path>.rsc` (text/x-component), a separate URL from the
  HTML; an `RSC: 1` request to the HTML URL gets a 307. Both send `Vary` on the router headers,
  so the public `Cache-Control` cannot mix HTML and RSC payloads.
- Final run: typecheck 0, lint 0, `pnpm -r test` 0 (core 229, web 144, poller 6; Postgres tests
  ran), build 0, 62 sitemap pages pass the HTML check, unknown slugs 404.

## Page inventory

Home, pricing, hack-me, privacy, terms; /platforms + 17 landing pages; /guides + 16 platform
guides; /guides/postgres + 9 guides; /compare + 11 comparisons; sitemap.xml, robots.txt,
llms.txt, og.png.

## Before launch

- Lawyer review of `content/legal.ts` (privacy policy and terms).
- Build the 30-day incident retention job the privacy policy promises, or change the policy.
- Confirm the inboxes `hello@flywheel.so` and `legal@flywheel.so` exist.
- Re-check competitor prices and platform facts every quarter; each page shows its check date.
- The /hack-me CTA goes to sign-up until the scan funnel ships (decision 016).
- The copy describes the V1 product. STATE.md still lists the posture scan, detectors 1, 3 and 5,
  webhook alerts, the weekly digest and Stripe billing as backlog. Ship them before deploy, or
  reframe the pages as early access.
- The privacy policy also promises account deletion within 30 days, a disconnect flow and notice
  before a new subprocessor. Confirm each exists before launch.

## Open questions

- Legal review of the privacy policy and terms before launch.
- The PR targets `develop` (it now exists). Commit 276b883 (decision 018, from another session)
  sits on this branch; Erik decides whether it moves to feature/scan-funnel before the push.
- Confirm `hello@flywheel.so` and `legal@flywheel.so` exist (`content/site.ts`).
- The privacy policy promises incident deletion after the plan's 30-day history. No retention job
  exists yet; build one before launch or change the policy.
