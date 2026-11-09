import { Breadcrumbs, CardGrid, Cta, PageHead } from "../../../../components/marketing/Blocks";
import { JsonLd } from "../../../../components/marketing/JsonLd";
import { postgresGuides } from "../../../../content/postgres";
import { SITE_UPDATED } from "../../../../content/site";
import { breadcrumbLd, pageMetadata } from "../../../../lib/seo";

const PATH = "/guides/postgres";
const crumbs = [{ name: "Home", path: "/" }, { name: "Guides", path: "/guides" }, { name: "Postgres", path: PATH }];

export const metadata = pageMetadata({
  title: "Postgres and Supabase best practices",
  description: "Practical Postgres guides for Supabase apps: RLS, multi-tenant isolation, API keys, secure views, indexing, pooling, pagination and schema design.",
  path: PATH,
});

export default function Page() {
  return (
    <>
      <JsonLd data={breadcrumbLd(crumbs)} />
      <Breadcrumbs items={crumbs} />
      <PageHead
        eyebrow="Guides"
        h1="Postgres best practices for Supabase apps"
        intro="Most Supabase data leaks and slowdowns come from a short list of database mistakes: missing or wrong RLS policies, leaked service keys, views that skip RLS and missing indexes. Each guide below fixes one of them, with SQL you can copy."
        updated={SITE_UPDATED}
      />
      <div className="mt-10">
        <CardGrid items={postgresGuides.map((g) => ({ href: `/guides/postgres/${g.slug}`, title: g.meta.h1, body: g.meta.description }))} />
      </div>
      <section className="mt-16"><Cta /></section>
    </>
  );
}
