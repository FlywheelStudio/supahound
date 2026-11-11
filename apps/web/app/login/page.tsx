import { env } from "cloudflare:workers";
import { redirect } from "next/navigation";
import { mode } from "../../lib/billing";
import { brandFrom } from "../../lib/brand";
import { currentUser } from "../../lib/supabase";
import { authCopy } from "../../lib/signup";
import { sendMagicLink } from "./actions";

const ERRORS: Record<string, string> = {
  email: "Enter a valid email address.",
  rate: "Too many sign-in emails. Wait a minute, then try again.",
  link: "That sign-in link is invalid or expired. Ask for a new one.",
};

export default async function Login({ searchParams }: { searchParams: Promise<Record<string, string | undefined>> }) {
  if (await currentUser()) redirect("/app");
  const params = await searchParams;
  const error = params.error ? ERRORS[params.error] : undefined;
  const copy = authCopy(params, mode() === "stripe");
  const brand = brandFrom(env);

  return (
    <main className="mx-auto flex min-h-screen max-w-md flex-col justify-center gap-6 px-6">
      <h1 className="text-2xl font-semibold">{copy.heading}</h1>
      {copy.plan && <p className="rounded-md border border-slate-200 bg-white p-3 text-sm text-slate-700">{copy.plan}</p>}
      {params.sent ? (
        <p className="rounded-md border border-emerald-200 bg-emerald-50 p-4 text-emerald-900">
          Check your email for a sign-in link. It works once and expires in 1 hour.
        </p>
      ) : (
        <form action={sendMagicLink} className="flex flex-col gap-3">
          <label htmlFor="email" className="text-sm font-medium">Work email</label>
          <input id="email" name="email" type="email" required autoComplete="email"
            className="rounded-md border border-slate-300 px-3 py-2" placeholder="you@company.com" />
          <button type="submit" className="rounded-md bg-slate-950 px-4 py-2 font-medium text-white hover:bg-slate-800">
            {copy.button}
          </button>
        </form>
      )}
      {error && <p role="alert" className="text-sm text-red-700">{error}</p>}
      <p className="text-sm text-slate-600">{copy.note}</p>
      {(brand.termsUrl || brand.privacyUrl || brand.supportEmail) && (
        <p className="flex flex-wrap gap-x-4 text-xs text-slate-500">
          {brand.termsUrl && <a href={brand.termsUrl} className="underline-offset-2 hover:underline">Terms</a>}
          {brand.privacyUrl && <a href={brand.privacyUrl} className="underline-offset-2 hover:underline">Privacy</a>}
          {brand.supportEmail && <a href={`mailto:${brand.supportEmail}`} className="underline-offset-2 hover:underline">{brand.supportEmail}</a>}
        </p>
      )}
    </main>
  );
}
