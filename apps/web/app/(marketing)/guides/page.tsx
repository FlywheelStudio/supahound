import { Breadcrumbs, CardGrid, Cta, PageHead } from "../../../components/marketing/Blocks";
import { JsonLd } from "../../../components/marketing/JsonLd";
import { platforms } from "../../../content/platforms";
import { postgresGuides } from "../../../content/postgres";
import { SITE_UPDATED } from "../../../content/site";
import { breadcrumbLd, pageMetadata } from "../../../lib/seo";

const PATH = "/guides";
const crumbs = [{ name: "Home", path: "/" }, { name: "Guides", path: PATH }];

export const metadata = pageMetadata({
  title: "Supabase security guides for AI-built apps",
  description: "Step-by-step Supabase security guides for each AI app builder, plus Postgres best practices for RLS, API keys, indexing and pagination.",
  path: PATH,
});

export default function Page() {
  return (
    <>
      <JsonLd data={breadcrumbLd(crumbs)} />
      <Breadcrumbs items={crumbs} />
      <PageHead
        h1="Supabase security guides"
        intro="Each AI app builder wires Supabase up its own way, so each one leaks data its own way. Pick your builder for a step-by-step guide, or start with the Postgres guides, which apply to every Supabase app."
        updated={SITE_UPDATED}
      />
      <section className="mt-12">
        <h2 className="text-2xl font-semibold">Postgres best practices</h2>
        <div className="mt-4"><CardGrid items={postgresGuides.map((g) => ({ href: `/guides/postgres/${g.slug}`, title: g.meta.h1, body: g.meta.description }))} /></div>
      </section>
      <section className="mt-12">
        <h2 className="text-2xl font-semibold">Guides by platform</h2>
        <div className="mt-4"><CardGrid items={platforms.filter((p) => p.slug !== "supabase").map((p) => ({ href: `/guides/${p.slug}`, title: p.guide.h1, body: p.guide.description }))} /></div>
      </section>
      <section className="mt-16"><Cta /></section>
    </>
  );
}
