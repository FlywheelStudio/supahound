// Every public marketing URL, in one list. sitemap.xml, llms.txt and the tests read it.
import { competitors } from "./competitors";
import { platforms } from "./platforms";
import { postgresGuides } from "./postgres";
import { SITE_UPDATED } from "./site";

export type PublicRoute = { path: string; title: string; summary: string; updated: string; priority: number; group: string };

export function publicRoutes(): PublicRoute[] {
  const r = (path: string, title: string, summary: string, priority: number, group: string, updated = SITE_UPDATED): PublicRoute =>
    ({ path, title, summary, updated, priority, group });
  return [
    r("/", "Supahound", "Abnormal-traffic monitoring for Supabase apps.", 1, "Product"),
    r("/pricing", "Pricing", "Free posture scan for 3 projects; $29 per project per month for runtime detection; $19 for agencies.", 0.9, "Product"),
    r("/hack-me", "Hack me: free external scan", "Free outside-in scan of a domain you prove you own: headers, TLS and exposed Supabase keys.", 0.9, "Product"),
    r("/platforms", "Platforms", "Supahound for apps built with each AI app builder.", 0.8, "Platforms"),
    ...platforms.map((p) => r(`/platforms/${p.slug}`, p.landing.h1, p.landing.description, 0.8, "Platforms", p.checked)),
    r("/guides", "Guides", "Security guides for each AI app builder and Postgres best practices.", 0.7, "Guides"),
    ...platforms.filter((p) => p.slug !== "supabase").map((p) => r(`/guides/${p.slug}`, p.guide.h1, p.guide.description, 0.7, "Guides", p.checked)),
    r("/guides/postgres", "Postgres best practices", "Postgres and Supabase best-practice guides.", 0.7, "Postgres guides"),
    ...postgresGuides.map((g) => r(`/guides/postgres/${g.slug}`, g.meta.h1, g.meta.description, 0.7, "Postgres guides", g.updated)),
    r("/compare", "Comparisons", "How Supahound compares with other Supabase security tools.", 0.6, "Comparisons"),
    ...competitors.map((c) => r(`/compare/${c.slug}`, c.meta.h1, c.meta.description, 0.6, "Comparisons", c.checked)),
    r("/privacy", "Privacy policy", "What data Supahound collects and how it is protected.", 0.3, "Legal"),
    r("/terms", "Terms and conditions", "The terms for using Supahound.", 0.3, "Legal"),
  ];
}
