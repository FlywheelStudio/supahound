import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { competitors } from "../content/competitors";
import { HOME_FAQS } from "../content/home";
import { PRIVACY, TERMS } from "../content/legal";
import { platforms } from "../content/platforms";
import { postgresGuides } from "../content/postgres";
import { publicRoutes } from "../content/routes";
import { NAV, PLANS, SITE_URL } from "../content/site";
import { isPublicMarketingPath } from "../lib/security";
import { faqLd, serializeLd, softwareLd } from "../lib/seo";

const routes = publicRoutes();
const paths = new Set(routes.map((r) => r.path));
const SUFFIX = " | Supahound".length;

// Every page's <title> (with suffix) and description fit what search results show.
const metas = [
  ...platforms.flatMap((p) => [{ id: `platform:${p.slug}`, ...p.landing }, { id: `guide:${p.slug}`, ...p.guide }]),
  ...postgresGuides.map((g) => ({ id: `postgres:${g.slug}`, ...g.meta })),
  ...competitors.map((c) => ({ id: `compare:${c.slug}`, ...c.meta })),
];

describe("route registry", () => {
  it("has unique paths, all public, all under SITE_URL", () => {
    expect(paths.size).toBe(routes.length);
    for (const r of routes) expect(isPublicMarketingPath(r.path), r.path).toBe(true);
    expect(SITE_URL).toBe("https://supahound.com");
  });

  it("maps every registered path to a route file", () => {
    const app = join(__dirname, "../app/(marketing)");
    const exists = (rel: string) => { try { return statSync(join(app, rel, "page.tsx")).isFile(); } catch { return false; } };
    for (const p of paths) {
      const seg = p === "/" ? "" : p.slice(1);
      const dynamic = seg.replace(/\/[^/]+$/, "/[slug]");
      expect(exists(seg) || exists(dynamic), p).toBe(true);
    }
  });

  it("lists every nav link and the legal pages", () => {
    for (const n of NAV) expect(paths.has(n.href), n.href).toBe(true);
    for (const p of ["/privacy", "/terms", "/hack-me", "/pricing", "/guides/postgres"]) expect(paths.has(p)).toBe(true);
  });
});

describe("page metadata", () => {
  it.each(metas.map((m) => [m.id, m] as const))("%s fits search result limits", (_id, m) => {
    expect(m.title.length + SUFFIX).toBeLessThanOrEqual(70);
    expect(m.description.length).toBeGreaterThanOrEqual(70);
    expect(m.description.length).toBeLessThanOrEqual(160);
    expect(m.intro.length).toBeGreaterThan(120);
  });

  it("uses unique titles and descriptions", () => {
    expect(new Set(metas.map((m) => m.title)).size).toBe(metas.length);
    expect(new Set(metas.map((m) => m.description)).size).toBe(metas.length);
  });
});

describe("internal links", () => {
  it("point only at registered pages", () => {
    const linked = [...readSources(join(__dirname, "../content")), ...readSources(join(__dirname, "../components/marketing"))]
      .flatMap((src) => [...src.matchAll(/(?:href=|\[\s*|\(|")"(\/(?:platforms|guides|compare|pricing|hack-me|privacy|terms)[^"?#]*)"/g)].map((m) => m[1]!));
    for (const l of linked) expect(paths.has(l), l).toBe(true);
  });
});

describe("platforms", () => {
  it("covers Supabase and the 16 builders from decision 017", () => {
    const want = ["supabase", "lovable", "bolt", "v0", "replit", "cursor", "windsurf", "claude-code", "base44", "anything",
      "firebase-studio", "tempo", "softgen", "rork", "same", "emergent", "github-copilot"];
    expect(platforms.map((p) => p.slug).sort()).toEqual([...want].sort());
  });

  // Templated pages must not read as doorway pages: no shared intros, risks or FAQ answers.
  it("has no duplicated intro, risk or FAQ text across platforms", () => {
    const seen = new Map<string, string>();
    for (const p of platforms) {
      const texts = [p.landing.intro, p.guide.intro, ...p.landing.risks.map((r) => r.detail), ...p.landing.faqs.map((f) => f.a), ...p.guide.faqs.map((f) => f.a)];
      for (const t of texts) {
        const prev = seen.get(t);
        expect(prev, `"${t.slice(0, 60)}…" in ${p.slug} and ${prev}`).toBeUndefined();
        seen.set(t, p.slug);
      }
    }
  });

  it.each(platforms.map((p) => [p.slug, p] as const))("%s has real content and sources", (_s, p) => {
    expect(p.landing.risks.length).toBeGreaterThanOrEqual(3);
    expect(p.landing.faqs.length).toBeGreaterThanOrEqual(3);
    expect(p.sources.length).toBeGreaterThanOrEqual(1);
    if (p.slug !== "supabase") expect(p.guide.sections.length).toBeGreaterThanOrEqual(3);
    for (const s of p.sources) expect(s.url).toMatch(/^https:\/\//);
  });
});

describe("competitors", () => {
  it.each(competitors.map((c) => [c.slug, c] as const))("%s is sourced, dated and fair", (_s, c) => {
    expect(c.sources.length).toBeGreaterThanOrEqual(1);
    expect(c.checked).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(c.strengths.length).toBeGreaterThanOrEqual(2);
    expect(c.rows.length).toBeGreaterThanOrEqual(4);
    expect(c.bestFor.length).toBeGreaterThan(20);
  });
});

describe("pricing", () => {
  it("matches decision 013", () => {
    expect(PLANS.map((p) => [p.id, p.price])).toEqual([["free", 0], ["builder", 29], ["agency", 19]]);
    const offers = softwareLd().offers.map((o) => o.price);
    expect(offers).toEqual(["0.00", "29.00", "19.00"]);
  });
});

describe("JSON-LD", () => {
  it("never lets content close the script tag", () => {
    const out = serializeLd(faqLd([{ q: "</script><script>alert(1)</script>", a: "x" }]));
    expect(out).not.toContain("</script>");
    expect(JSON.parse(out).mainEntity[0].name).toContain("</script>");
  });

  it("builds a valid FAQPage from the home FAQ", () => {
    const ld = faqLd(HOME_FAQS);
    expect(ld.mainEntity).toHaveLength(HOME_FAQS.length);
  });
});

describe("copy rules", () => {
  it("never uses the old product name, and legal pages name the entity", () => {
    const all = [...readSources(join(__dirname, "../content")), ...readSources(join(__dirname, "../app/(marketing)"))].join("\n");
    expect(all).not.toMatch(/guardbase/i);
    expect(JSON.stringify(PRIVACY) + JSON.stringify(TERMS)).toContain("Flywheel Studio LLC");
    expect(JSON.stringify(TERMS)).toContain("Texas");
  });
});

function readSources(dir: string): string[] {
  return readdirSync(dir, { recursive: true, encoding: "utf8" })
    .filter((f) => /\.(ts|tsx)$/.test(f))
    .map((f) => readFileSync(join(dir, f), "utf8"));
}

describe("coming-soon registry (decision 021)", () => {
  it("ties every feature that is not live to at least one issue", async () => {
    const { FEATURES } = await import("../content/features");
    for (const [id, f] of Object.entries(FEATURES)) {
      if (f.status === "soon") expect(f.issues.length, id).toBeGreaterThan(0);
    }
  });

  it("tags every plan line that names a product capability", () => {
    const untagged = PLANS.flatMap((p) => p.features.filter((f) => !f.feature).map((f) => f.text));
    expect(untagged.sort()).toEqual(["Everything in Builder", "Everything in Free", "No credit card"].sort());
  });

  it("uses one contact address and no legal@ inbox", () => {
    const all = [...readSources(join(__dirname, "../content")), ...readSources(join(__dirname, "../app/(marketing)"))].join("\n");
    expect(all).not.toContain("legal@");
    expect(JSON.stringify(PRIVACY) + JSON.stringify(TERMS)).toContain("hello@flywheel.so");
  });
});
