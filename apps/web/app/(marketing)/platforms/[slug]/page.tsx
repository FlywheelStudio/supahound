import Link from "next/link";
import { notFound } from "next/navigation";
import { Breadcrumbs, Cta, FaqList, PageHead, Sources } from "../../../../components/marketing/Blocks";
import { JsonLd } from "../../../../components/marketing/JsonLd";
import { platform, platforms } from "../../../../content/platforms";
import { SIGN_UP_PATH } from "../../../../content/site";
import { breadcrumbLd, faqLd, pageMetadata } from "../../../../lib/seo";

type Props = { params: Promise<{ slug: string }> };

export const dynamicParams = false;
export function generateStaticParams() {
  return platforms.map((p) => ({ slug: p.slug }));
}

export async function generateMetadata({ params }: Props) {
  const p = platform((await params).slug);
  if (!p) return {};
  return pageMetadata({ title: p.landing.title, description: p.landing.description, path: `/platforms/${p.slug}` });
}

const INTEGRATION: Record<string, string> = {
  native: "has a built-in Supabase integration",
  supported: "works with Supabase when you connect it yourself",
  none: "does not use Supabase by default",
};

export default async function Page({ params }: Props) {
  const p = platform((await params).slug);
  if (!p) notFound();
  const path = `/platforms/${p.slug}`;
  const crumbs = [{ name: "Home", path: "/" }, { name: "Platforms", path: "/platforms" }, { name: p.name, path }];
  const isSupabase = p.slug === "supabase";
  return (
    <>
      <JsonLd data={breadcrumbLd(crumbs)} />
      <JsonLd data={faqLd(p.landing.faqs)} />
      <Breadcrumbs items={crumbs} />
      <PageHead eyebrow={isSupabase ? "Supabase monitoring" : `${p.name} + Supabase`} h1={p.landing.h1} intro={p.landing.intro} updated={p.checked} />
      <div className="mt-8 flex flex-wrap gap-3">
        <Link href={SIGN_UP_PATH} className="rounded-md bg-slate-950 px-5 py-2.5 font-medium text-white hover:bg-slate-800">Start free</Link>
        {!isSupabase && <Link href={`/guides/${p.slug}`} className="rounded-md border border-slate-300 bg-white px-5 py-2.5 font-medium hover:border-slate-500">Read the {p.name} security guide</Link>}
      </div>
      {!isSupabase && (
        <p className="mt-6 max-w-3xl rounded-lg border border-slate-200 bg-white p-4 text-sm text-slate-700">
          <a href={p.url} rel="nofollow noopener" className="font-medium underline underline-offset-2">{p.name}</a> {INTEGRATION[p.integration]}.
          {p.integration === "none" && " These pages apply when you connect your own Supabase project."}
        </p>
      )}

      <section className="mt-14 max-w-3xl">
        <h2 className="text-2xl font-semibold">{isSupabase ? "What attacks hit Supabase apps?" : `What are the Supabase security risks in ${p.name} apps?`}</h2>
        <ul className="mt-4 space-y-4">
          {p.landing.risks.map((r) => (
            <li key={r.title} className="rounded-xl border border-slate-200 bg-white p-5">
              <p className="font-semibold">{r.title}</p>
              <p className="mt-1.5 leading-7 text-slate-700">{r.detail}</p>
            </li>
          ))}
        </ul>
      </section>

      <section className="mt-14 max-w-3xl">
        <h2 className="text-2xl font-semibold">How does Supahound protect {isSupabase ? "your Supabase project" : `your ${p.name} app`}?</h2>
        <ul className="mt-4 list-disc space-y-2 pl-6 leading-7 text-slate-700">
          {p.landing.howSupahoundHelps.map((h) => <li key={h}>{h}</li>)}
        </ul>
      </section>

      <section className="mt-14"><FaqList faqs={p.landing.faqs} /></section>
      <section className="mt-14"><Cta title={isSupabase ? undefined : `Watch your ${p.name} app's Supabase traffic`} /></section>
      {p.sources.length > 0 && <div className="mt-14"><Sources sources={p.sources} checked={p.checked} /></div>}
    </>
  );
}
