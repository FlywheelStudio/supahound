import Link from "next/link";
import type { Faq, Section, Source } from "../../content/types";
import { SIGN_UP_PATH } from "../../content/site";

export function Breadcrumbs({ items }: { items: { name: string; path: string }[] }) {
  return (
    <nav aria-label="Breadcrumb" className="text-sm text-slate-500">
      <ol className="flex flex-wrap gap-1">
        {items.map((it, i) => (
          <li key={it.path} className="flex gap-1">
            {i > 0 && <span aria-hidden>/</span>}
            {i < items.length - 1 ? <Link href={it.path} className="hover:text-slate-900">{it.name}</Link> : <span aria-current="page">{it.name}</span>}
          </li>
        ))}
      </ol>
    </nav>
  );
}

export function PageHead({ eyebrow, h1, intro, updated }: { eyebrow?: string; h1: string; intro: string; updated?: string }) {
  return (
    <div className="mt-6 max-w-3xl">
      {eyebrow && <p className="text-sm font-semibold uppercase tracking-wide text-emerald-700">{eyebrow}</p>}
      <h1 className="mt-2 text-3xl font-semibold leading-tight sm:text-4xl">{h1}</h1>
      <p className="mt-4 text-lg leading-8 text-slate-700">{intro}</p>
      {updated && <p className="mt-3 text-sm text-slate-500">Last updated <time dateTime={updated}>{updated}</time></p>}
    </div>
  );
}

export function Sections({ sections }: { sections: Section[] }) {
  return (
    <div className="max-w-3xl space-y-10">
      {sections.map((s) => (
        <section key={s.heading}>
          <h2 className="text-2xl font-semibold">{s.heading}</h2>
          {s.paragraphs?.map((p) => <p key={p} className="mt-3 leading-7 text-slate-700">{p}</p>)}
          {s.bullets && <ul className="mt-3 list-disc space-y-1.5 pl-6 text-slate-700">{s.bullets.map((b) => <li key={b}>{b}</li>)}</ul>}
          {s.steps && <ol className="mt-3 list-decimal space-y-1.5 pl-6 text-slate-700">{s.steps.map((b) => <li key={b}>{b}</li>)}</ol>}
          {s.code?.map((c) => (
            <figure key={c.code} className="mt-4">
              <pre className="overflow-x-auto rounded-lg bg-slate-950 p-4 text-sm leading-6 text-slate-100"><code>{c.code}</code></pre>
              {c.caption && <figcaption className="mt-1.5 text-sm text-slate-500">{c.caption}</figcaption>}
            </figure>
          ))}
        </section>
      ))}
    </div>
  );
}

export function FaqList({ faqs, heading = "Frequently asked questions" }: { faqs: Faq[]; heading?: string }) {
  return (
    <section className="max-w-3xl">
      <h2 className="text-2xl font-semibold">{heading}</h2>
      <dl className="mt-4 divide-y divide-slate-200 border-y border-slate-200">
        {faqs.map((f) => (
          <div key={f.q} className="py-4">
            <dt className="font-medium">{f.q}</dt>
            <dd className="mt-1.5 leading-7 text-slate-700">{f.a}</dd>
          </div>
        ))}
      </dl>
    </section>
  );
}

export function Sources({ sources, checked }: { sources: Source[]; checked?: string }) {
  return (
    <section className="max-w-3xl text-sm text-slate-600">
      <h2 className="text-base font-semibold text-slate-900">Sources</h2>
      {checked && <p className="mt-1">Checked on <time dateTime={checked}>{checked}</time>. Products change; check each source for current details.</p>}
      <ul className="mt-2 list-disc space-y-1 pl-5">
        {sources.map((s) => <li key={s.url}><a href={s.url} rel="nofollow noopener" className="underline underline-offset-2">{s.label}</a></li>)}
      </ul>
    </section>
  );
}

export function Cta({ title = "Find out if someone is abusing your app", body = "Connect your Supabase org read-only. The free posture scan runs in minutes. No credit card." }: { title?: string; body?: string }) {
  return (
    <section className="rounded-2xl bg-slate-950 px-6 py-10 text-white sm:px-10">
      <h2 className="text-2xl font-semibold">{title}</h2>
      <p className="mt-2 max-w-2xl text-slate-300">{body}</p>
      <div className="mt-6 flex flex-wrap gap-3">
        <Link href={SIGN_UP_PATH} className="rounded-md bg-emerald-500 px-4 py-2 font-medium text-slate-950 hover:bg-emerald-400">Start free</Link>
        <Link href="/pricing" className="rounded-md border border-slate-700 px-4 py-2 font-medium hover:bg-slate-900">See pricing</Link>
      </div>
    </section>
  );
}

export function CardGrid({ items }: { items: { href: string; title: string; body: string; tag?: string }[] }) {
  return (
    <ul className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
      {items.map((it) => (
        <li key={it.href}>
          <Link href={it.href} className="block h-full rounded-xl border border-slate-200 bg-white p-5 hover:border-slate-400">
            {it.tag && <p className="text-xs font-semibold uppercase tracking-wide text-emerald-700">{it.tag}</p>}
            <p className="mt-1 font-semibold">{it.title}</p>
            <p className="mt-1.5 text-sm leading-6 text-slate-600">{it.body}</p>
          </Link>
        </li>
      ))}
    </ul>
  );
}
