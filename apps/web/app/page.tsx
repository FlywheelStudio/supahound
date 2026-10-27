import Link from "next/link";

export default function Home() {
  return (
    <main className="mx-auto flex min-h-screen max-w-3xl flex-col justify-center gap-8 px-6 py-16">
      <p className="text-sm font-semibold uppercase tracking-wide text-emerald-700">Guardbase</p>
      <h1 className="text-4xl font-semibold leading-tight sm:text-5xl">
        Know when someone is abusing your Supabase app.
      </h1>
      <p className="max-w-2xl text-lg leading-8 text-slate-700">
        Guardbase reads your project&apos;s logs, spots cross-tenant reads and leaked service keys,
        and tells you in plain English what happened and how to fix it. Read-only. No service-role key.
      </p>
      <div className="flex gap-3">
        <Link href="/login" className="rounded-md bg-slate-950 px-4 py-2 font-medium text-white hover:bg-slate-800">
          Start free
        </Link>
        <Link href="/login" className="rounded-md border border-slate-300 px-4 py-2 font-medium hover:bg-white">
          Sign in
        </Link>
      </div>
    </main>
  );
}
