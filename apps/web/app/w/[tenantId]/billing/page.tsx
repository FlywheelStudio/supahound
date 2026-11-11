import { accessFor, accessForAccount, isExemptEmail, needsEnterprise, PRICE_LABEL, REJECTION_TEXT, TRIAL_DAYS } from "@supahound/core/billing/policy";
import { termsText } from "@supahound/core/billing/stripeMap";
import { getBilling, grantExemption, projectTiers } from "@supahound/core/db/billing";
import { listProjects } from "@supahound/core/db/repo";
import { NotAMemberError, withTenantForUser } from "@supahound/core/db/user";
import { tenantId as parseTenantId } from "@supahound/core/tenancy/scope";
import { env } from "cloudflare:workers";
import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { exemptDomains, mode } from "../../../../lib/billing";
import { brandFrom } from "../../../../lib/brand";
import { withPool } from "../../../../lib/db";
import { requireUser } from "../../../../lib/supabase";
import { openPortalAction, startCheckoutAction } from "./actions";

// The billing page (decision 028). The one workspace page that opens before a card is validated,
// so it uses withTenantForUser; every other tenant page goes through the paid gate.
// It also grants the staff exemption (decision 029): when the sole owner signs in with an email on
// an exempt domain, the workspace needs no card. The gate sends a new staff workspace here first.

const ERRORS: Record<string, string> = {
  ...REJECTION_TEXT,
  terms: "Tick the box to accept the terms before you add a card.",
  role: "Only workspace owners and admins can manage billing.",
  pending: "Stripe has not finished checking your card yet. Refresh this page in a moment.",
};

const TIER_TABLE = [
  { name: "Starter", price: `${PRICE_LABEL.starter} per project per month`, detail: "Up to 1 million requests per project in 30 days." },
  { name: "Pro", price: `${PRICE_LABEL.pro} per project per month`, detail: "1 to 10 million requests per project in 30 days. SMS alerts (coming soon)." },
  { name: "Enterprise", price: "Contact us", detail: "Above 10 million requests per project. The project stays on Pro until we agree terms." },
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

  const staff = isExemptEmail(user.email, exemptDomains());
  const data = await withPool((pool) =>
    withTenantForUser(pool, user.id, tenant, async (tx, role) => {
      let billing = await getBilling(tx);
      if (!billing.exempt && staff && role === "owner") {
        const blocked = accessForAccount(billing) === "blocked";
        if (await grantExemption(tx, user.id, new Date())) {
          if (blocked) return { granted: true as const };
          billing = await getBilling(tx);
        }
      }
      const names = new Map((await listProjects(tx)).map((p) => [p.id, p.name]));
      const tiers = (await projectTiers(tx)).map((t) => ({ ...t, name: names.get(t.id) ?? "Project" }));
      return { granted: false as const, role, billing, tiers };
    }),
  ).catch((err: unknown) => {
    if (err instanceof NotAMemberError) notFound();
    throw err;
  });

  // A new staff workspace: straight on to the overview, after the transaction committed.
  if (data.granted) redirect(`/w/${tenant}`);

  const query = await searchParams;
  const error = query.error ? ERRORS[query.error] ?? ERRORS.error : undefined;
  const { billing, role, tiers } = data;
  const access = accessForAccount(billing);
  const liveSubscription = billing.subscriptionId !== null && accessFor(billing.status) !== "blocked";
  const brand = brandFrom(env);
  const canManage = role !== "member";

  return (
    <main className="mx-auto max-w-2xl px-6 py-10">
      <header className="mb-8 flex items-center justify-between">
        <h1 className="text-2xl font-semibold">Billing</h1>
        {access !== "blocked" && <Link href={`/w/${tenant}`} className="text-sm text-slate-600 hover:text-slate-950">Back to overview</Link>}
      </header>

      {error && <p role="alert" className="mb-6 rounded-md border border-red-200 bg-red-50 p-3 text-sm text-red-900">{error}</p>}

      <section aria-label="Prices" className="mb-6 grid gap-3 sm:grid-cols-3">
        {TIER_TABLE.map((t) => (
          <div key={t.name} className="rounded-md border border-slate-200 bg-white p-4">
            <h2 className="font-semibold">{t.name}</h2>
            <p className="text-sm font-medium">{t.price}</p>
            <p className="mt-1 text-xs text-slate-600">{t.detail}</p>
          </div>
        ))}
      </section>

      {billing.exempt ? (
        <section aria-label="Complimentary workspace" className="rounded-md border border-slate-200 bg-white p-6">
          <dl className="grid grid-cols-[10rem_1fr] gap-y-2 text-sm">
            <dt className="text-slate-500">Status</dt>
            <dd>Complimentary</dd>
          </dl>
          <p className="mt-4 text-sm text-slate-600">
            This workspace needs no card while its only owner signs in with a staff email. If ownership moves to anyone
            else, the workspace needs a card.
          </p>
          {liveSubscription && canManage && (
            <form action={openPortalAction} className="mt-6">
              <input type="hidden" name="tenantId" value={tenant} />
              <p className="mb-3 text-sm text-slate-700">This workspace still has a Stripe subscription. Cancel it to stop charges.</p>
              <button className="rounded-md bg-slate-950 px-4 py-2 font-medium text-white hover:bg-slate-800">
                Manage card, invoices or cancellation
              </button>
            </form>
          )}
        </section>
      ) : access !== "blocked" ? (
        <section className="rounded-md border border-slate-200 bg-white p-6">
          <dl className="grid grid-cols-[10rem_1fr] gap-y-2 text-sm">
            <dt className="text-slate-500">Status</dt>
            <dd>{billing.status === "trialing" ? "Free trial" : billing.status === "past_due" ? "Payment failed, retrying" : "Active"}</dd>
            {billing.status === "trialing" && billing.trialEnd && (<>
              <dt className="text-slate-500">Trial ends</dt>
              <dd>{billing.trialEnd.toISOString().slice(0, 10)}</dd>
            </>)}
            <dt className="text-slate-500">Billed projects</dt>
            <dd>{billing.seats ? `${billing.seats.starter} Starter, ${billing.seats.pro} Pro` : "1 Starter"}</dd>
            {billing.cancelAtPeriodEnd && (<>
              <dt className="text-slate-500">Cancels</dt>
              <dd>At the end of this period</dd>
            </>)}
          </dl>
          {tiers.length > 0 && (
            <ul aria-label="Projects and their tier" className="mt-6 divide-y divide-slate-200 rounded-md border border-slate-200 text-sm">
              {tiers.map((t) => (
                <li key={t.id} className="flex justify-between px-3 py-2">
                  <span>{t.name}</span>
                  <span className="text-slate-600">
                    {t.tier === "pro" ? "Pro" : "Starter"} · {t.requests30d === null ? "usage counted daily" : `${t.requests30d.toLocaleString("en-US")} requests in 30 days`}
                    {needsEnterprise(t.requests30d) ? " · Enterprise: we will contact you" : ""}
                  </span>
                </li>
              ))}
            </ul>
          )}
          {canManage && (
            <form action={openPortalAction} className="mt-6">
              <input type="hidden" name="tenantId" value={tenant} />
              <button className="rounded-md bg-slate-950 px-4 py-2 font-medium text-white hover:bg-slate-800">
                Manage card, invoices or cancellation
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
          <p id="billing-terms" className="mt-4 rounded-md bg-slate-50 p-3 text-sm text-slate-700">{termsText()}</p>
          <form action={startCheckoutAction} className="mt-6 flex flex-col gap-4">
            <input type="hidden" name="tenantId" value={tenant} />
            <label className="flex gap-3 text-sm">
              <input type="checkbox" name="terms" required aria-describedby="billing-terms" />
              <span>
                I agree to the{" "}
                {brand.termsUrl ? <a href={brand.termsUrl} className="underline">Terms</a> : "Terms"} and authorize Supahound to
                place a $1 hold now and to charge my card each month after the trial, as described above, until I cancel.
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
