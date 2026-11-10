# Marketing site (supahound.com)

Shipped 2026-11-09 through PRs #45 and #53 into `develop`. Issues #34 (pages) and #40 (Coming soon
registry). Decisions [017](../decisions/017-marketing-site.md) and
[021](../decisions/021-coming-soon-features.md).

## What it does

The public site on `https://supahound.com` sells Supahound and sends visitors to sign-up. It has 62
pages, and every page is in the sitemap:

| Section | Pages |
| --- | --- |
| Product | Home, `/pricing`, `/hack-me` |
| Platforms | `/platforms` and 17 landing pages (Supabase plus the 16 builders in decision 017) |
| Platform guides | `/guides` and 16 guides, one per builder |
| Postgres guides | `/guides/postgres` and 9 guides |
| Comparisons | `/compare` and 11 competitor pages |
| Legal | `/privacy`, `/terms` |

The site also serves `sitemap.xml`, `robots.txt`, `llms.txt` and `og.png`. Every page has a
"Made by flywheel.so" footer and a non-affiliation line. Every unbuilt feature shows "Coming soon".

## How it works

**Route group.** The pages are the `(marketing)` route group in `apps/web`. They deploy with the
web app on the same Cloudflare Worker. The group layout renders the early-access banner, the
header, the footer and the Organization JSON-LD.

**Typed content.** All copy is typed TypeScript in `apps/web/content/`. There is no CMS. Page
components read the content and render it through shared blocks.

**One list of URLs.** `content/routes.ts` (`publicRoutes()`) lists every public URL with its title,
summary, last-updated date, sitemap priority and group. The sitemap, `llms.txt` and the tests read
this list. A new page must go in this list.

**Data-driven routes.** The four `[slug]` routes (platforms, guides, Postgres guides, compare)
export `generateStaticParams` from the content arrays and set `dynamicParams = false`. An unknown
slug returns 404.

**Canonical URLs.** `SITE_URL` in `content/site.ts` is the only source of the public origin. It
feeds canonical URLs, Open Graph tags, the sitemap, `robots.txt` and JSON-LD. Never derive a public
URL from `APP_URL`.

**Metadata and JSON-LD.** `lib/seo.ts` builds page metadata (`pageMetadata`: canonical, Open Graph,
Twitter card with `og.png`) and pure JSON-LD builders. `serializeLd` escapes `<` so content cannot
close the `<script>` tag.

| JSON-LD type | Pages |
| --- | --- |
| `Organization` | Every page (group layout) |
| `SoftwareApplication` with one `Offer` per plan | Home, pricing |
| `BreadcrumbList` | Every page except home |
| `FAQPage` | Home, pricing, hack-me, platform landing pages, compare pages, guides |
| `TechArticle` | Platform guides and Postgres guides (`GuidePage.tsx`) |

**Crawlers.** `app/robots.ts` allows all crawlers and names the AI crawlers (GPTBot, ClaudeBot,
PerplexityBot and others) explicitly. It disallows the signed-in paths and `/login`.
`app/llms.txt/route.ts` writes a plain map of the site from `publicRoutes()`, plus the plans. It
appends "(coming soon)" to each plan line whose feature is not live.

**Middleware allowlist.** `isPublicMarketingPath` in `lib/security.ts` holds two lists: exact paths
(`/`, `/sitemap.xml`, `/robots.txt`, `/llms.txt`, `/og.png`, `/favicon.svg`) and sections
(`/pricing`, `/hack-me`, `/platforms`, `/guides`, `/compare`, `/privacy`, `/terms`). For a GET or
HEAD to an allowlisted path, `middleware.ts` skips the Supabase session refresh and sets
`Cache-Control: public, max-age=300, s-maxage=3600`. Every other path keeps the refresh. The list
is an allowlist on purpose: a new private route stays private by default. Marketing pages never
read the session, so they never send `Set-Cookie`.

**Sign-up.** Sign-up CTAs link to `/login?signup=1`; pricing CTAs add `&plan=<id>`. `authCopy` in
`lib/signup.ts` switches the heading, button and note to sign-up copy. For a paid plan, it names
the plan and says paid plans are coming soon until `paidPlans` is live. Sign-in links stay
`/login`.

**Coming soon registry (decision 021).** `content/features.ts` is the one registry of public
features. Each feature has a status (`live` or `soon`) and the GitHub issues that ship it. Issue
numbers never render. Plan lines and capability lines carry a feature ID.
`components/marketing/Soon.tsx` renders a "Coming soon" pill for each `soon` feature, and a
site-wide early-access banner while any feature is `soon`. The PR that ships a feature flips its
status to `live` in the same commit. When the last feature ships, the banner disappears by itself.

**Contact.** `hello@flywheel.so` (`CONTACT_EMAIL`) is the only contact address, legal pages
included. The contracting party is Flywheel Studio LLC under Texas law (`LEGAL` in
`content/site.ts`).

## Key files

All paths are under `apps/web/`.

| Path | Purpose |
| --- | --- |
| `app/(marketing)/layout.tsx` | Banner, header, footer, Organization JSON-LD |
| `app/(marketing)/page.tsx`, `pricing/`, `hack-me/`, `privacy/`, `terms/` | Fixed pages |
| `app/(marketing)/platforms/[slug]/page.tsx` | Platform landing pages |
| `app/(marketing)/guides/[slug]/page.tsx` | Platform guides |
| `app/(marketing)/guides/postgres/[slug]/page.tsx` | Postgres guides |
| `app/(marketing)/compare/[slug]/page.tsx` | Competitor comparisons |
| `app/sitemap.ts`, `app/robots.ts`, `app/llms.txt/route.ts` | Crawler files |
| `content/site.ts` | `SITE_URL`, plans and prices, nav, contact, legal entity |
| `content/routes.ts` | Every public URL |
| `content/features.ts` | Coming soon registry |
| `content/platforms.ts`, `content/platforms/groupA.ts`, `groupB.ts` | 17 platform entries, split over two files |
| `content/postgres.ts`, `content/competitors.ts` | Postgres guides, comparisons |
| `content/home.ts`, `content/legal.ts`, `content/types.ts` | Home copy and FAQ, privacy and terms, content types |
| `components/marketing/` | Header, Footer, Blocks (incl. sources and check date), GuidePage, JsonLd, Soon |
| `lib/seo.ts` | Metadata and JSON-LD builders |
| `lib/security.ts` | `isPublicMarketingPath` allowlist |
| `lib/signup.ts` | Sign-up copy on `/login` |
| `middleware.ts` | Session refresh skip and public `Cache-Control` |
| `public/og.png`, `public/favicon.svg` | Open Graph image, icon |
| `scripts/check-pages.py` | Manual check of every sitemap page on a running build |

## External services

None beyond Cloudflare Workers, which already host the web app. The site uses no CMS, analytics,
font host or other new service (decision 017).

## Testing

Unit tests run in `pnpm -r test`.

- **`test/content.test.ts`: 96 cases.**
  - Route registry (3): paths are unique and all pass `isPublicMarketingPath`; every path maps to a
    `page.tsx`; nav links and legal pages are registered.
  - Page metadata (55): 54 cases check search-result limits (title plus suffix ≤ 70, description
    70–160, intro > 120 characters) on 17 landing and 17 guide entries, 9 Postgres guides and 11
    compare pages. Supabase's guide entry is checked although `/guides/supabase` has no page. One
    case checks that titles and descriptions are unique.
  - Internal links (1): every link in `content/` and `components/marketing/` points at a
    registered page.
  - Platforms (19): the slugs match decision 017; no intro, risk or FAQ answer repeats across
    platforms (no doorway pages); each of the 17 entries has at least 3 risks, 3 FAQs, 1 HTTPS
    source and, for builders, 3 guide sections.
  - Competitors (11): each page has sources, a check date, at least 2 strengths, 4 table rows and a
    "best for" line.
  - Pricing (1): plan prices match decision 013, and the `SoftwareApplication` offers match.
  - JSON-LD (2): content cannot close the script tag; the home FAQ builds a full `FAQPage`.
  - Copy rules (1): no "Guardbase"; the legal pages name Flywheel Studio LLC and Texas.
  - Coming soon registry (3): every `soon` feature has an issue; every plan line except three
    generic ones carries a feature ID; no `legal@` address, and the legal pages use
    `hello@flywheel.so`.
- **`test/publicPaths.test.ts`: 26 cases.** 12 public paths pass the allowlist. 14 paths keep the
  session refresh, including `/login`, the signed-in routes, the signed hook and near-misses such
  as `/pricingx`, `/platformsevil` and `//pricing`.
- **`test/security.test.ts`: 1 case (`authCopy`).** Sign-in copy by default, sign-up copy from
  `?signup=1`, the paid-plan "coming soon" note, and an unknown plan falls back to sign-in.
- **E2E (`e2e/specs/public.spec.ts`).** Covers the marketing site only through "the home page
  returns 200". The other signed-out checks cover sign-in and the private routes.
- **Manual page check (`scripts/check-pages.py`).** CI does not run it. It reads the sitemap from a
  running build and checks each page for one `h1`, the right canonical, a description, parseable
  JSON-LD (Organization; BreadcrumbList except home), `og:image`, the flywheel.so footer link and
  no `Set-Cookie`. It exits 1 on any problem; adding `/login` as an extra path proves it fails. Run
  it from `apps/web` after `vite build`:

  ```bash
  CLOUDFLARE_HYPERDRIVE_LOCAL_CONNECTION_STRING_HYPERDRIVE_APP=postgres://x:x@127.0.0.1:5999/x \
    npx wrangler dev --config dist/server/wrangler.json --port 8788
  python3 -I scripts/check-pages.py
  ```

Ship run (2026-11-09): typecheck, lint, `pnpm -r test` and build exited 0; all 62 sitemap pages
passed the page check; unknown slugs returned 404; `/login` stayed `private, no-store`.

## Gotchas

- **Cascade layers.** Base styles in `app/globals.css` must stay inside `@layer base`. An unlayered
  `a { color: inherit }` beat the Tailwind v4 utilities and hid the text on every dark button,
  `/login` included.
- **Phone-width screenshots.** Headless Chrome has a minimum window width. A 390px window
  screenshot is not a real phone width; render the page in a 390px iframe instead.
- **RSC payloads and the cache.** Client navigation fetches `<path>.rsc`, a separate URL from the
  HTML. An `RSC: 1` request to the HTML URL gets a 307. Both responses send `Vary` on the router
  headers, so the public `Cache-Control` cannot mix HTML and RSC payloads.
- **No `?next=` on sign-up.** The Send Email Hook does not carry `next`, so CTAs never add it.
- **New public section.** Add it to `PUBLIC_SECTIONS` in `lib/security.ts` and to `routes.ts`.
  Without the allowlist entry, the route registry test fails and the middleware treats the section
  as private.
- **Public pages are cached.** A shared cache may keep them, so they must never render per-user
  content or read the session.
- **`og.png` is a static file.** We rendered it by hand with headless Chrome. No script
  regenerates it.
- **Facts go stale.** Platform and compare pages show their check date and sources. Writers dropped
  every claim they could not source; keep that rule.

## Open items

- Legal review of the privacy policy and terms before launch.
- The privacy policy's data promises (retention, deletion within 30 days, disconnect, subprocessor
  notice) ship as data controls, issue #43.
- Each unbuilt feature flips to `live` in `content/features.ts` in the PR that ships it. The
  registry lists the issues.
- Re-check competitor prices and platform facts every quarter, and update each page's check date.
