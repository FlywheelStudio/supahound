import { Breadcrumbs, CardGrid, Cta, PageHead } from "../../../components/marketing/Blocks";
import { JsonLd } from "../../../components/marketing/JsonLd";
import { platforms } from "../../../content/platforms";
import { SITE_UPDATED } from "../../../content/site";
import { breadcrumbLd, pageMetadata } from "../../../lib/seo";

const PATH = "/platforms";
const crumbs = [{ name: "Home", path: "/" }, { name: "Platforms", path: PATH }];

export const metadata = pageMetadata({
  title: "Supahound for every AI app builder",
  description: "Supabase security monitoring for apps built with Lovable, Bolt, v0, Cursor, Claude Code and 12 more AI app builders and editors.",
  path: PATH,
});

export default function Page() {
  return (
    <>
      <JsonLd data={breadcrumbLd(crumbs)} />
      <Breadcrumbs items={crumbs} />
      <PageHead h1="Supahound for every AI app builder" intro="Supahound monitors the Supabase project behind your app, so it works the same however you built it. Pick your builder to see its specific Supabase risks and how Supahound watches for them." updated={SITE_UPDATED} />
      <div className="mt-10"><CardGrid items={platforms.map((p) => ({ href: `/platforms/${p.slug}`, title: p.slug === "supabase" ? "Supabase" : `${p.name} + Supabase`, body: p.oneLine, tag: p.kind === "ai-editor" ? "AI editor" : p.kind === "backend" ? "Backend" : "App builder" }))} /></div>
      <section className="mt-16"><Cta /></section>
    </>
  );
}
