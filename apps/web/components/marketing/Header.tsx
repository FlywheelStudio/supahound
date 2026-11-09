import Link from "next/link";
import { NAV, SIGN_IN_PATH, SIGN_UP_PATH } from "../../content/site";

// Static on purpose: public pages never read the session (decision 017).
export function Header() {
  return (
    <header className="border-b border-slate-200 bg-white/80 backdrop-blur">
      <div className="mx-auto flex max-w-6xl flex-wrap items-center justify-between gap-3 px-4 py-3 sm:px-6">
        <Link href="/" className="flex items-center gap-2 font-semibold">
          <span aria-hidden className="inline-block h-6 w-6 rounded-md bg-emerald-600" />
          Supahound
        </Link>
        <nav aria-label="Main" className="order-3 flex w-full gap-4 overflow-x-auto text-sm text-slate-700 sm:order-none sm:w-auto">
          {NAV.map((n) => (
            <Link key={n.href} href={n.href} className="whitespace-nowrap hover:text-slate-950">{n.label}</Link>
          ))}
        </nav>
        <div className="flex items-center gap-2 text-sm">
          <Link href={SIGN_IN_PATH} className="px-2 py-1.5 text-slate-700 hover:text-slate-950">Sign in</Link>
          <Link href={SIGN_UP_PATH} className="rounded-md bg-slate-950 px-3 py-1.5 font-medium text-white hover:bg-slate-800">Start free</Link>
        </div>
      </div>
    </header>
  );
}
