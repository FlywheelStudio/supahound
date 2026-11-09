import { Breadcrumbs, CardGrid, Cta, PageHead } from "../../../components/marketing/Blocks";
import { JsonLd } from "../../../components/marketing/JsonLd";
import { competitors } from "../../../content/competitors";
import { SITE_UPDATED } from "../../../content/site";
import { breadcrumbLd, pageMetadata } from "../../../lib/seo";

const PATH = "/compare";
const crumbs = [{ name: "Home", path: "/" }, { name: "Compare", path: PATH }];

export const metadata = pageMetadata({
  title: "Supahound vs other Supabase security tools",
  description: "Honest comparisons of Supahound with Supabase's Security Advisor, code scanners, WAFs and app monitoring tools: what each one catches and costs.",
  path: PATH,
});

export default function Page() {
  return (
    <>
      <JsonLd data={breadcrumbLd(crumbs)} />
      <Breadcrumbs items={crumbs} />
      <PageHead h1="Supahound vs other Supabase security tools" intro="Most tools check your code or your configuration once. Supahound watches your Supabase traffic, per user and per key, all the time. These pages compare it fairly with each alternative, with sources and the date we checked." updated={SITE_UPDATED} />
      <div className="mt-10"><CardGrid items={competitors.map((c) => ({ href: `/compare/${c.slug}`, title: `Supahound vs ${c.name}`, body: c.meta.description, tag: c.category }))} /></div>
      <section className="mt-16"><Cta /></section>
    </>
  );
}
