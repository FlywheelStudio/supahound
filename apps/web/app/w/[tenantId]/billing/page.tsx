import { accessFor, PRICE_PER_SEAT_USD, REJECTION_TEXT, TRIAL_DAYS, type Plan } from "@supahound/core/billing/policy";
import { getBilling } from "@supahound/core/db/billing";
import { NotAMemberError, withTenantForUser } from "@supahound/core/db/user";
import { tenantId as parseTenantId } from "@supahound/core/tenancy/scope";
import { env } from "cloudflare:workers";
import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { mode } from "../../../../lib/billing";
import { brandFrom } from "../../../../lib/brand";
import { withPool } from "../../../../lib/db";
import { termsText } from "../../../../lib/stripeMap";
import { requireUser } from "../../../../lib/supabase";
import { openPortalAction, startCheckoutAction } from "./actions";

// The billing page (decision 028). The one workspace page that opens before a card is validated,
// so it uses withTenantForUser; every other tenant page goes through the paid gate.

const ERRORS: Record<string, string> = {
  ...REJECTION_TEXT,
  terms: "Tick the box to accept the terms before you add a card.",
  role: "Only workspace owners and admins can manage billing.",
  pending: "Stripe has not finished checking your card yet. Refresh this page in a moment.",
};

const PLANS: { id: Plan; name: string; detail: string }[] = [
  { id: "builder", name: "Builder", detail: `$${PRICE_PER_SEAT_USD.builder} per watched project per month` },
  { id: "agency", name: "Agency", detail: `$${PRICE_PER_SEAT_USD.agency} per watched project per month, 10 projects minimum` },
];

export default async function Billing({
  params,
  searchParams,
}: {
  params: Promise<{ tenantId: string }>;
  searchParams: Promise<Record<string, string | undefined>>;
}) {
  const user = await requireUser();
  const { tenantId } = await params;
  let tenant;
  try {
    tenant = parseTenantId(tenantId);
  } catch {
    notFound();
  }
  if (mode() === "off") redirect(`/w/${tenant}`);

  const data = await withPool((pool) =>
    withTenantForUser(pool, user.id, tenant, async (tx, role) => ({ role, billing: await getBilling(tx) })),
  ).catch((err: unknown) => {
    if (err instanceof NotAMemberError) notFound();
    throw err;
  });

  const query = await searchParams;
  const error = query.error ? ERRORS[query.error] ?? ERRORS.error : undefined;
  const { billing, role } = data;
  const access = accessFor(billing.status);
  const brand = brandFrom(env);
  const canManage = role !== "member";

  return (
    <main className="mx-auto max-w-2xl px-6 py-10">
      <header className="mb-8 flex items-center justify-between">
        <h1 className="text-2xl font-semibold">Billing</h1>
        {access !== "blocked" && <Link href={`/w/${tenant}`} className="text-sm text-slate-600 hover:text-slate-950">Back to overview</Link>}
      </header>

      {error && <p role="alert" className="mb-6 rounded-md border border-red-200 bg-red-50 p-3 text-sm text-red-900">{error}</p>}

      {access !== "blocked" ? (
        <section className="rounded-md border border-slate-200 bg-white p-6">
          <dl className="grid grid-cols-[10rem_1fr] gap-y-2 text-sm">
            <dt className="text-slate-500">Plan</dt>
            <dd>{billing.plan === "agency" ? "Agency" : "Builder"}</dd>
            <dt className="text-slate-500">Status</dt>
            <dd>{billing.status === "trialing" ? "Free trial" : billing.status === "past_due" ? "Payment failed, retrying" : "Active"}</dd>
            {billing.status === "trialing" && billing.trialEnd && (<>
              <dt className="text-slate-500">Trial ends</dt>
              <dd>{billing.trialEnd.toISOString().slice(0, 10)}</dd>
            </>)}
            <dt className="text-slate-500">Billed projects</dt>
            <dd>{billing.seats ?? 1}</dd>
            {billing.cancelAtPeriodEnd && (<>
              <dt className="text-slate-500">Cancels</dt>
              <dd>At the end of this period</dd>
            </>)}
          </dl>
          {canManage && (
            <form action={openPortalAction} className="mt-6">
              <input type="hidden" name="tenantId" value={tenant} />
              <button className="rounded-md bg-slate-950 px-4 py-2 font-medium text-white hover:bg-slate-800">
                Manage card, plan or cancellation
              </button>
            </form>
          )}
        </section>
      ) : !canManage ? (
        <p className="rounded-md border border-slate-200 bg-white p-6 text-slate-700">
          This workspace needs a card before anyone can use it. Ask a workspace owner or admin to add one.
        </p>
      ) : (
        <section className="rounded-md border border-slate-200 bg-white p-6">
          <h2 className="text-lg font-semibold">Add a card to start your {TRIAL_DAYS}-day free trial</h2>
          <p className="mt-2 text-sm text-slate-600">
            Every Supahound workspace needs a card that your bank confirms. Stripe handles the card; Supahound never sees
            the number.
          </p>
          <form action={startCheckoutAction} className="mt-6 flex flex-col gap-4">
            <input type="hidden" name="tenantId" value={tenant} />
            <fieldset className="flex flex-col gap-3">
              <legend className="mb-2 text-sm font-medium">Plan</legend>
              {PLANS.map((p) => (
                <label key={p.id} className="flex gap-3 rounded-md border border-slate-200 p-3">
                  <input type="radio" name="plan" value={p.id} defaultChecked={(billing.plan ?? "builder") === p.id} />
                  <span>
                    <span className="font-medium">{p.name}</span>
                    <span className="block text-sm text-slate-600">{p.detail}</span>
                    <span className="mt-1 block text-xs text-slate-500">{termsText(p.id)}</span>
                  </span>
                </label>
              ))}
            </fieldset>
            <label className="flex gap-3 text-sm">
              <input type="checkbox" name="terms" required />
              <span>
                I agree to the{" "}
                {brand.termsUrl ? <a href={brand.termsUrl} className="underline">Terms</a> : "Terms"} and authorize Supahound to
                place a $1 hold now and to charge my card each month after the trial, until I cancel.
              </span>
            </label>
            <button type="submit" className="rounded-md bg-slate-950 px-4 py-2 font-medium text-white hover:bg-slate-800">
              Add card and start trial
            </button>
          </form>
        </section>
      )}
    </main>
  );
}
