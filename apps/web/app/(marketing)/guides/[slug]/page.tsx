import { notFound } from "next/navigation";
import { Sources } from "../../../../components/marketing/Blocks";
import { GuidePage } from "../../../../components/marketing/GuidePage";
import { platform, platforms } from "../../../../content/platforms";
import { postgresGuides } from "../../../../content/postgres";
import { pageMetadata } from "../../../../lib/seo";

type Props = { params: Promise<{ slug: string }> };

// Supabase has a landing page but no platform guide: the Postgres guides cover it.
const guided = () => platforms.filter((p) => p.slug !== "supabase");

export const dynamicParams = false;
export function generateStaticParams() {
  return guided().map((p) => ({ slug: p.slug }));
}

export async function generateMetadata({ params }: Props) {
  const p = platform((await params).slug);
  if (!p) return {};
  return pageMetadata({ title: p.guide.title, description: p.guide.description, path: `/guides/${p.slug}`, type: "article" });
}

export default async function Page({ params }: Props) {
  const p = platform((await params).slug);
  if (!p || p.slug === "supabase") notFound();
  const path = `/guides/${p.slug}`;
  return (
    <>
      <GuidePage
        guide={{ slug: p.slug, meta: p.guide, sections: p.guide.sections, faqs: p.guide.faqs, related: [], updated: p.checked }}
        path={path}
        eyebrow={`${p.name} security guide`}
        crumbs={[{ name: "Home", path: "/" }, { name: "Guides", path: "/guides" }, { name: p.name, path }]}
        related={[
          { href: `/platforms/${p.slug}`, title: `Supahound for ${p.name} apps` },
          ...postgresGuides.slice(0, 3).map((g) => ({ href: `/guides/postgres/${g.slug}`, title: g.meta.h1 })),
        ]}
      />
      {p.sources.length > 0 && <div className="mt-14"><Sources sources={p.sources} checked={p.checked} /></div>}
    </>
  );
}
