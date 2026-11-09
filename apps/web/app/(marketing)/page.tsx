import Link from "next/link";
import { CardGrid, Cta, FaqList } from "../../components/marketing/Blocks";
import { JsonLd } from "../../components/marketing/JsonLd";
import { DETECTORS, HOME_FAQS, STEPS } from "../../content/home";
import { builders } from "../../content/platforms";
import { PLANS, SIGN_UP_PATH, SITE_DESCRIPTION } from "../../content/site";
import { faqLd, pageMetadata, softwareLd } from "../../lib/seo";

export const metadata = {
  ...pageMetadata({ title: "Supabase abuse and attack monitoring", description: SITE_DESCRIPTION, path: "/" }),
  title: { absolute: "Supahound: Supabase abuse and attack monitoring" },
};

export default function Home() {
  return (
    <>
      <JsonLd data={softwareLd()} />
      <JsonLd data={faqLd(HOME_FAQS)} />

      <section className="max-w-3xl py-8 sm:py-14">
        <p className="text-sm font-semibold uppercase tracking-wide text-emerald-700">For apps built on Supabase</p>
        <h1 className="mt-3 text-4xl font-semibold leading-tight sm:text-5xl">Know when someone is abusing your Supabase app.</h1>
        <p className="mt-5 text-lg leading-8 text-slate-700">
          Supahound reads your Supabase logs and catches cross-tenant reads, leaked service keys, credential stuffing
          and scraping within minutes. Each alert says what happened in plain English and gives you the SQL to fix it.
          Read-only access. No service-role key.
        </p>
        <div className="mt-8 flex flex-wrap gap-3">
          <Link href={SIGN_UP_PATH} className="rounded-md bg-slate-950 px-5 py-2.5 font-medium text-white hover:bg-slate-800">Start free</Link>
          <Link href="/hack-me" className="rounded-md border border-slate-300 bg-white px-5 py-2.5 font-medium hover:border-slate-500">Get a free external scan</Link>
        </div>
        <p className="mt-3 text-sm text-slate-500">Free posture scan for up to 3 projects. No credit card.</p>
      </section>

      <section className="py-10">
        <h2 className="text-2xl font-semibold">Why does RLS alone not keep my Supabase data safe?</h2>
        <p className="mt-3 max-w-3xl leading-7 text-slate-700">
          Row Level Security decides who can read each row, but a policy can be on and still be wrong. AI app builders
          write many policies fast, and a single <code>using (true)</code> or a missing owner check lets any signed-in
          user read everyone&apos;s data. Config scanners see that the policy exists. Only the traffic shows that someone
          is using the hole.
        </p>
      </section>

      <section className="py-10">
        <h2 className="text-2xl font-semibold">How does Supahound work?</h2>
        <ol className="mt-6 grid gap-4 sm:grid-cols-3">
          {STEPS.map((s, i) => (
            <li key={s.title} className="rounded-xl border border-slate-200 bg-white p-5">
              <p className="text-sm font-semibold text-emerald-700">Step {i + 1}</p>
              <p className="mt-1 font-semibold">{s.title}</p>
              <p className="mt-2 text-sm leading-6 text-slate-600">{s.body}</p>
            </li>
          ))}
        </ol>
      </section>

      <section className="py-10">
        <h2 className="text-2xl font-semibold">What attacks does Supahound detect?</h2>
        <ul className="mt-6 grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {DETECTORS.map((d) => (
            <li key={d.name} className="rounded-xl border border-slate-200 bg-white p-5">
              <p className="font-semibold">{d.name}</p>
              <p className="mt-2 text-sm leading-6 text-slate-600">{d.body}</p>
            </li>
          ))}
        </ul>
        <p className="mt-4 max-w-3xl text-sm text-slate-600">
          Cross-tenant reads, service-key misuse, credential stuffing and tampering alert from day one. Behavioral
          detectors learn your project&apos;s normal traffic for 7 days first.
        </p>
      </section>

      <section className="py-10">
        <h2 className="text-2xl font-semibold">Which app builders does Supahound support?</h2>
        <p className="mt-3 max-w-3xl leading-7 text-slate-700">
          Supahound watches the Supabase project, so it works the same however you built the app.
        </p>
        <div className="mt-6">
          <CardGrid items={builders().slice(0, 9).map((p) => ({ href: `/platforms/${p.slug}`, title: `${p.name} + Supabase`, body: p.oneLine }))} />
        </div>
        <p className="mt-4 text-sm"><Link href="/platforms" className="font-medium text-emerald-700 hover:underline">See all {builders().length} platforms</Link></p>
      </section>

      <section className="py-10">
        <h2 className="text-2xl font-semibold">How much does Supahound cost?</h2>
        <ul className="mt-6 grid gap-4 sm:grid-cols-3">
          {PLANS.map((p) => (
            <li key={p.id} className={`rounded-xl border bg-white p-5 ${p.highlight ? "border-emerald-500" : "border-slate-200"}`}>
              <p className="font-semibold">{p.name}</p>
              <p className="mt-2"><span className="text-3xl font-semibold">{p.priceLabel}</span> <span className="text-sm text-slate-600">{p.unit}</span></p>
              <p className="mt-2 text-sm text-slate-600">{p.blurb}</p>
            </li>
          ))}
        </ul>
        <p className="mt-4 text-sm"><Link href="/pricing" className="font-medium text-emerald-700 hover:underline">Compare plans</Link></p>
      </section>

      <section className="py-10"><FaqList faqs={HOME_FAQS} /></section>
      <section className="py-10"><Cta /></section>
    </>
  );
}
