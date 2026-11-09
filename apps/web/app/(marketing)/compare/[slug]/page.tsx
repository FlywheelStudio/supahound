import Link from "next/link";
import { notFound } from "next/navigation";
import { Breadcrumbs, Cta, FaqList, PageHead, Sources } from "../../../../components/marketing/Blocks";
import { JsonLd } from "../../../../components/marketing/JsonLd";
import { competitor, competitors } from "../../../../content/competitors";
import { breadcrumbLd, faqLd, pageMetadata } from "../../../../lib/seo";

type Props = { params: Promise<{ slug: string }> };

export const dynamicParams = false;
export function generateStaticParams() {
  return competitors.map((c) => ({ slug: c.slug }));
}

export async function generateMetadata({ params }: Props) {
  const c = competitor((await params).slug);
  if (!c) return {};
  return pageMetadata({ title: c.meta.title, description: c.meta.description, path: `/compare/${c.slug}` });
}

export default async function Page({ params }: Props) {
  const c = competitor((await params).slug);
  if (!c) notFound();
  const path = `/compare/${c.slug}`;
  const crumbs = [{ name: "Home", path: "/" }, { name: "Compare", path: "/compare" }, { name: `Supahound vs ${c.name}`, path }];
  return (
    <>
      <JsonLd data={breadcrumbLd(crumbs)} />
      <JsonLd data={faqLd(c.faqs)} />
      <Breadcrumbs items={crumbs} />
      <PageHead eyebrow={c.category} h1={c.meta.h1} intro={c.meta.intro} updated={c.checked} />

      <section className="mt-12">
        <h2 className="text-2xl font-semibold">How do Supahound and {c.name} compare?</h2>
        <div className="mt-4 overflow-x-auto rounded-xl border border-slate-200 bg-white">
          <table className="w-full min-w-[640px] text-left text-sm">
            <thead className="border-b border-slate-200 bg-slate-50">
              <tr><th className="p-3 font-semibold">Question</th><th className="p-3 font-semibold">Supahound</th><th className="p-3 font-semibold">{c.name}</th></tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {c.rows.map((r) => (
                <tr key={r.feature}><th scope="row" className="p-3 align-top font-normal text-slate-700">{r.feature}</th><td className="p-3 align-top">{r.supahound}</td><td className="p-3 align-top">{r.them}</td></tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      <div className="mt-14 grid max-w-5xl gap-10 md:grid-cols-2">
        <section>
          <h2 className="text-xl font-semibold">What does {c.name} do well?</h2>
          <ul className="mt-3 list-disc space-y-1.5 pl-6 leading-7 text-slate-700">{c.strengths.map((s) => <li key={s}>{s}</li>)}</ul>
        </section>
        <section>
          <h2 className="text-xl font-semibold">What does {c.name} not cover?</h2>
          <ul className="mt-3 list-disc space-y-1.5 pl-6 leading-7 text-slate-700">{c.gaps.map((s) => <li key={s}>{s}</li>)}</ul>
        </section>
      </div>

      <section className="mt-14 max-w-3xl">
        <h2 className="text-2xl font-semibold">How much does {c.name} cost?</h2>
        <p className="mt-3 leading-7 text-slate-700">{c.pricing} Supahound&apos;s posture scan is free; runtime detection is $29 per project per month (<Link href="/pricing" className="text-emerald-700 hover:underline">pricing</Link>).</p>
      </section>

      <section className="mt-14 max-w-3xl">
        <h2 className="text-2xl font-semibold">Which one should I choose?</h2>
        <p className="mt-3 leading-7 text-slate-700"><strong>Choose {c.name}</strong> {c.bestFor}</p>
        <p className="mt-3 leading-7 text-slate-700"><strong>Choose Supahound</strong> {c.chooseSupahound}</p>
      </section>

      <section className="mt-14"><FaqList faqs={c.faqs} /></section>
      <section className="mt-14"><Cta /></section>
      <div className="mt-14"><Sources sources={c.sources} checked={c.checked} /></div>
    </>
  );
}
