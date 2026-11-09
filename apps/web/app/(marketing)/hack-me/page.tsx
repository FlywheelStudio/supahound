import Link from "next/link";
import { Breadcrumbs, Cta, FaqList, PageHead } from "../../../components/marketing/Blocks";
import { JsonLd } from "../../../components/marketing/JsonLd";
import { SIGN_UP_PATH, SITE_UPDATED } from "../../../content/site";
import type { Faq } from "../../../content/types";
import { breadcrumbLd, faqLd, pageMetadata } from "../../../lib/seo";

const PATH = "/hack-me";
const crumbs = [{ name: "Home", path: "/" }, { name: "Hack me", path: PATH }];

export const metadata = pageMetadata({
  title: "Hack me: free external security scan for your app",
  description: "Prove you own your domain and get a free outside-in security scan: headers, TLS and exposed Supabase keys in your public JavaScript.",
  path: PATH,
});

const STEPS = [
  { t: "Enter your app's URL", b: "Supahound works out the registrable domain (for example, app.example.com becomes example.com). The scan never leaves that domain." },
  { t: "Prove you own the domain", b: "Add a TXT record we give you to your DNS. Supahound reads it through several public DNS resolvers, and they must agree. A meta tag or file upload is not enough, because it only proves control of the current web host." },
  { t: "Accept the scope agreement", b: "You confirm that you own or are authorized to test the domain. Supahound keeps that agreement as an append-only record." },
  { t: "Get your report", b: "You get a score, every finding with its evidence and a fix, and the full report by email." },
];

const CHECKS = [
  ["Security headers", "Content-Security-Policy, Strict-Transport-Security, X-Frame-Options, Referrer-Policy and Permissions-Policy, checked on your pages."],
  ["TLS", "Certificate validity and expiry, protocol versions and HTTPS redirects."],
  ["Supabase exposure", "Supahound reads your public JavaScript and network calls to find your Supabase project URL and the keys your frontend ships. It flags a service_role or secret key in the browser at once."],
  ["Next steps", "Each finding maps to the Supahound monitor that would catch someone using it. Connect your Supabase org to turn the snapshot into always-on detection."],
];

const FAQS: Faq[] = [
  { q: "Is the hack me scan free?", a: "Yes. The external scan is free. It is the one-time snapshot; Supahound's paid plans are the always-on version." },
  { q: "Can I scan a site I do not own?", a: "No. The scan runs only after you prove control of the domain with a DNS TXT record, and only against that domain. Government, military and major platform domains are blocked even with a TXT record." },
  { q: "Will the scan break my app?", a: "No. Today the scan runs passive checks only: it reads the same headers, certificates and public JavaScript that any visitor's browser receives. It does not try exploits or send attack payloads." },
  { q: "Why DNS and not a file upload?", a: "A DNS TXT record proves control of the domain itself, not only of today's web host, and it keeps working if you move hosts. That makes it the stronger authorization record." },
  { q: "What happens to my report?", a: "Your report lives in your Supahound account, under the same tenant isolation as the rest of your data." },
];

export default function HackMe() {
  return (
    <>
      <JsonLd data={breadcrumbLd(crumbs)} />
      <JsonLd data={faqLd(FAQS)} />
      <Breadcrumbs items={crumbs} />
      <PageHead
        eyebrow="Free external scan"
        h1="Hack me: see your app the way an attacker does"
        intro="Hack me is a free, outside-in security scan of your web app. You prove you own the domain with a DNS record, and Supahound checks your security headers, TLS and the Supabase keys your frontend ships to every visitor. You get a score and a fix for every finding."
        updated={SITE_UPDATED}
      />
      <div className="mt-8 flex flex-wrap items-center gap-3">
        <Link href={SIGN_UP_PATH} className="rounded-md bg-slate-950 px-5 py-2.5 font-medium text-white hover:bg-slate-800">Create a free account to scan</Link>
        <p className="text-sm text-slate-600">The scan is in development. Create your account now and the scan shows up in it at launch.</p>
      </div>

      <section className="mt-16 max-w-3xl">
        <h2 className="text-2xl font-semibold">How does the hack me scan work?</h2>
        <ol className="mt-6 space-y-4">
          {STEPS.map((s, i) => (
            <li key={s.t} className="flex gap-4">
              <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-emerald-600 text-sm font-semibold text-white">{i + 1}</span>
              <div><p className="font-semibold">{s.t}</p><p className="mt-1 leading-7 text-slate-700">{s.b}</p></div>
            </li>
          ))}
        </ol>
      </section>

      <section className="mt-16 max-w-3xl">
        <h2 className="text-2xl font-semibold">What does the scan check?</h2>
        <dl className="mt-4 divide-y divide-slate-200 border-y border-slate-200">
          {CHECKS.map(([t, b]) => <div key={t} className="py-4"><dt className="font-semibold">{t}</dt><dd className="mt-1 leading-7 text-slate-700">{b}</dd></div>)}
        </dl>
      </section>

      <section className="mt-16 max-w-3xl">
        <h2 className="text-2xl font-semibold">Why is a scan not enough?</h2>
        <p className="mt-3 leading-7 text-slate-700">
          A scan is a photo of one moment. It cannot tell you that a user started reading other users&apos; rows an hour
          after you shipped a new policy, or that your service key just called your API from a network it has never
          used. Supahound&apos;s runtime detection watches your Supabase logs every 1–2 minutes for exactly that.
        </p>
        <p className="mt-3"><Link href="/pricing" className="font-medium text-emerald-700 hover:underline">See runtime detection plans</Link></p>
      </section>

      <section className="mt-16"><FaqList faqs={FAQS} /></section>
      <section className="mt-16"><Cta title="Scan your app, then keep watching it" /></section>
    </>
  );
}
