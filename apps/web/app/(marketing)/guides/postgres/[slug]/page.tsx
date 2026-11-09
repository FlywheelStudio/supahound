import { notFound } from "next/navigation";
import { GuidePage } from "../../../../../components/marketing/GuidePage";
import { postgresGuide, postgresGuides } from "../../../../../content/postgres";
import { pageMetadata } from "../../../../../lib/seo";

type Props = { params: Promise<{ slug: string }> };

export const dynamicParams = false;
export function generateStaticParams() {
  return postgresGuides.map((g) => ({ slug: g.slug }));
}

export async function generateMetadata({ params }: Props) {
  const g = postgresGuide((await params).slug);
  if (!g) return {};
  return pageMetadata({ title: g.meta.title, description: g.meta.description, path: `/guides/postgres/${g.slug}`, type: "article" });
}

export default async function Page({ params }: Props) {
  const g = postgresGuide((await params).slug);
  if (!g) notFound();
  const path = `/guides/postgres/${g.slug}`;
  return (
    <GuidePage
      guide={g}
      path={path}
      eyebrow="Postgres best practices"
      crumbs={[{ name: "Home", path: "/" }, { name: "Guides", path: "/guides" }, { name: "Postgres", path: "/guides/postgres" }, { name: g.meta.h1, path }]}
      related={g.related.map((s) => postgresGuide(s)).filter((r) => r !== undefined).map((r) => ({ href: `/guides/postgres/${r.slug}`, title: r.meta.h1 }))}
    />
  );
}
