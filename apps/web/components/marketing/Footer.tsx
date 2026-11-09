import Link from "next/link";
import { MAKER } from "../../content/site";

const COLUMNS = [
  { title: "Product", links: [["/pricing", "Pricing"], ["/hack-me", "Free scan (hack me)"], ["/platforms/supabase", "Supabase monitoring"], ["/login?signup=1", "Sign up"]] },
  { title: "Learn", links: [["/guides", "Platform guides"], ["/guides/postgres", "Postgres best practices"], ["/compare", "Comparisons"], ["/platforms", "All platforms"]] },
  { title: "Legal", links: [["/privacy", "Privacy policy"], ["/terms", "Terms and conditions"]] },
] as const;

export function Footer() {
  return (
    <footer className="mt-24 border-t border-slate-200 bg-white">
      <div className="mx-auto grid max-w-6xl gap-8 px-4 py-12 sm:grid-cols-4 sm:px-6">
        <div>
          <p className="font-semibold">Supahound</p>
          <p className="mt-2 text-sm text-slate-600">Abnormal-traffic monitoring for Supabase apps.</p>
        </div>
        {COLUMNS.map((c) => (
          <nav key={c.title} aria-label={c.title}>
            <p className="text-sm font-semibold">{c.title}</p>
            <ul className="mt-2 space-y-1.5 text-sm text-slate-600">
              {c.links.map(([href, label]) => (
                <li key={href}><Link href={href} className="hover:text-slate-950">{label}</Link></li>
              ))}
            </ul>
          </nav>
        ))}
      </div>
      <div className="border-t border-slate-100">
        <div className="mx-auto flex max-w-6xl flex-col gap-2 px-4 py-6 text-xs text-slate-500 sm:px-6">
          <p>
            Made by{" "}
            <a href={MAKER.url} className="font-medium text-slate-700 underline-offset-2 hover:underline">flywheel.so</a>
            {" "}· © {new Date().getFullYear()} {MAKER.legalName}
          </p>
          <p>
            Supahound is an independent product. It is not affiliated with or endorsed by Supabase, Inc. or any other
            company or product named on this site. Product names are trademarks of their owners.
          </p>
        </div>
      </div>
    </footer>
  );
}
