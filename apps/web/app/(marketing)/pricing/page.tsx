import Link from "next/link";
import { Breadcrumbs, Cta, FaqList, PageHead } from "../../../components/marketing/Blocks";
import { JsonLd } from "../../../components/marketing/JsonLd";
import { CONTACT_EMAIL, PLANS, SIGN_UP_PATH, SITE_UPDATED } from "../../../content/site";
import type { Faq } from "../../../content/types";
import { breadcrumbLd, faqLd, pageMetadata, softwareLd } from "../../../lib/seo";

const PATH = "/pricing";
const crumbs = [{ name: "Home", path: "/" }, { name: "Pricing", path: PATH }];

export const metadata = pageMetadata({
  title: "Pricing: free posture scan, $29 per project",
  description: "Supahound pricing: a free daily posture scan for up to 3 Supabase projects, $29 per project per month for runtime detection, $19 for agencies.",
  path: PATH,
});

const MATRIX: [string, string, string, string][] = [
  ["Projects", "Up to 3", "Per project", "10 minimum"],
  ["Posture scan (RLS, Security Advisor, exposed tables)", "Daily", "Daily", "Daily"],
  ["Runtime detectors (cross-tenant, service key, stuffing, scraping, tampering)", "—", "Every 1–2 minutes", "Every 1–2 minutes"],
  ["Plain-English incident with a paste-ready fix", "—", "Yes", "Yes"],
  ["Email alerts", "Yes", "Yes", "Yes"],
  ["Signed webhook alerts (Slack, Discord)", "—", "Yes", "Yes"],
  ["Weekly digest", "Yes", "Yes", "Yes"],
  ["Incident history", "—", "30 days", "30 days"],
  ["Multi-project dashboard and client reports", "—", "—", "Yes"],
];

const FAQS: Faq[] = [
  { q: "What counts as a project?", a: "One Supabase project, identified by its project ref. A production and a staging project are two projects." },
  { q: "Is the free plan really free?", a: "Yes. The free plan runs a daily posture scan on up to 3 projects with email alerts and a weekly digest. It does not need a credit card and it does not expire." },
  { q: "Why is runtime detection paid?", a: "Runtime detection polls each project's logs every 1–2 minutes and runs every detector on every poll. That costs real compute per project. The posture scan runs once a day, so it costs very little." },
  { q: "Can I cancel?", a: "Yes. Cancel any time. Your paid plan runs to the end of the billing period, then the project drops back to the free posture scan." },
  { q: "Do you offer a trial of runtime detection?", a: `Start on Free and see your posture findings first. Email ${CONTACT_EMAIL} if you want to test runtime detection on a project before you pay.` },
  { q: "How does the agency plan work?", a: "Agency costs $19 per project per month with a 10-project minimum, so it starts at $190 per month. You get one dashboard for every client project and client-ready reports. Rates drop further at 25+ projects." },
];

export default function Pricing() {
  return (
    <>
      <JsonLd data={softwareLd()} />
      <JsonLd data={breadcrumbLd(crumbs)} />
      <JsonLd data={faqLd(FAQS)} />
      <Breadcrumbs items={crumbs} />
      <PageHead
        h1="Supahound pricing"
        intro="The posture scan is free for up to 3 Supabase projects. Runtime detection, which catches attacks while they happen, costs $29 per project per month. Agencies pay $19 per project per month with a 10-project minimum."
        updated={SITE_UPDATED}
      />

      <ul className="mt-10 grid gap-4 lg:grid-cols-3">
        {PLANS.map((p) => (
          <li key={p.id} className={`flex flex-col rounded-2xl border bg-white p-6 ${p.highlight ? "border-emerald-500 ring-1 ring-emerald-500" : "border-slate-200"}`}>
            <h2 className="text-lg font-semibold">{p.name}</h2>
            <p className="mt-1 text-sm text-slate-600">{p.blurb}</p>
            <p className="mt-4"><span className="text-4xl font-semibold">{p.priceLabel}</span> <span className="text-sm text-slate-600">{p.unit}</span></p>
            <ul className="mt-6 flex-1 space-y-2 text-sm text-slate-700">
              {p.features.map((f) => <li key={f} className="flex gap-2"><span aria-hidden className="text-emerald-600">✓</span>{f}</li>)}
            </ul>
            <Link href={`${SIGN_UP_PATH}&plan=${p.id}`} className={`mt-6 rounded-md px-4 py-2 text-center font-medium ${p.highlight ? "bg-slate-950 text-white hover:bg-slate-800" : "border border-slate-300 hover:border-slate-500"}`}>{p.cta}</Link>
          </li>
        ))}
      </ul>
      <p className="mt-3 text-sm text-slate-500">Prices in US dollars, billed monthly. Taxes may apply.</p>

      <section className="mt-16">
        <h2 className="text-2xl font-semibold">What does each plan include?</h2>
        <div className="mt-4 overflow-x-auto rounded-xl border border-slate-200 bg-white">
          <table className="w-full min-w-[640px] text-left text-sm">
            <thead className="border-b border-slate-200 bg-slate-50">
              <tr><th className="p-3 font-semibold">Feature</th>{PLANS.map((p) => <th key={p.id} className="p-3 font-semibold">{p.name}</th>)}</tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {MATRIX.map(([f, ...cells]) => (
                <tr key={f}><th scope="row" className="p-3 font-normal text-slate-700">{f}</th>{cells.map((c, i) => <td key={i} className="p-3">{c}</td>)}</tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      <section className="mt-16"><FaqList faqs={FAQS} /></section>
      <section className="mt-16"><Cta /></section>
    </>
  );
}
