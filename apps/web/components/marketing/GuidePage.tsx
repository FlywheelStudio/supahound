import Link from "next/link";
import type { Guide } from "../../content/types";
import { articleLd, breadcrumbLd, faqLd } from "../../lib/seo";
import { Breadcrumbs, Cta, FaqList, PageHead, Sections } from "./Blocks";
import { JsonLd } from "./JsonLd";

// One template for every guide: answer-first intro, question headings, FAQ, related links.
export function GuidePage({ guide, path, crumbs, related, eyebrow }: {
  guide: Guide;
  path: string;
  crumbs: { name: string; path: string }[];
  related: { href: string; title: string }[];
  eyebrow: string;
}) {
  const { meta } = guide;
  return (
    <>
      <JsonLd data={articleLd({ title: meta.h1, description: meta.description, path, updated: guide.updated })} />
      <JsonLd data={breadcrumbLd(crumbs)} />
      <JsonLd data={faqLd(guide.faqs)} />
      <Breadcrumbs items={crumbs} />
      <article>
        <PageHead eyebrow={eyebrow} h1={meta.h1} intro={meta.intro} updated={guide.updated} />
        <div className="mt-12"><Sections sections={guide.sections} /></div>
        <div className="mt-16"><FaqList faqs={guide.faqs} /></div>
      </article>
      {related.length > 0 && (
        <nav aria-label="Related guides" className="mt-16 max-w-3xl">
          <h2 className="text-xl font-semibold">Related guides</h2>
          <ul className="mt-3 list-disc space-y-1.5 pl-6">
            {related.map((r) => <li key={r.href}><Link href={r.href} className="text-emerald-700 hover:underline">{r.title}</Link></li>)}
          </ul>
        </nav>
      )}
      <section className="mt-16"><Cta /></section>
    </>
  );
}
