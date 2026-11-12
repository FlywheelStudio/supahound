import { ENTERPRISE_FROM_REQUESTS, needsEnterprise, PRICE_LABEL, PRO_FROM_REQUESTS, USAGE_WINDOW_DAYS } from "@supahound/core/billing/policy";
import Link from "../../../../../../../components/NavLink";
import { ComingSoon, Shell } from "../../../../../../../components/Shell";
import { mode } from "../../../../../../../lib/billing";
import { workspacePath } from "../../../../../../../lib/nav";
import { loadProjectPage } from "../../../../../../../lib/projectPage";

// Project settings → Plan & billing (issue #98). Read-only: the tier follows traffic (decision 028).
// The card, invoices and the Stripe portal stay on the workspace billing page until each project
// gets its own subscription (issue #99, decision 032).

const millions = (n: number) => `${n / 1_000_000} million`;

export default async function ProjectPlan({ params }: { params: Promise<{ tenantId: string; projectId: string }> }) {
  const d = await loadProjectPage(params);
  const { tenant, project: p } = d;
  const billingOn = mode() !== "off";
  const tier = d.tiers.find((t) => t.id === p.id);

  return (
    <Shell tenant={tenant} role={d.role} projects={d.projects} tiers={d.tiers} billingOn={billingOn} active={{ kind: "project", project: p, page: "plan" }}>
      <h1 className="mb-6 text-2xl font-semibold">Plan &amp; billing</h1>
      {!billingOn || !tier ? (
        <p className="text-slate-600">Billing is off on this copy of Supahound.</p>
      ) : (
        <>
          <section aria-labelledby="plan-heading" className="mb-6 rounded-md border border-slate-200 bg-white p-6">
            <h2 id="plan-heading" className="mb-1 text-sm font-medium uppercase tracking-wide text-slate-500">Current plan</h2>
            <p className="text-2xl font-semibold">
              {tier.tier === "pro" ? "Pro" : "Starter"} <span className="text-base font-normal text-slate-600">{PRICE_LABEL[tier.tier]} per month</span>
            </p>
            <p className="mt-2 text-sm text-slate-700">
              {tier.requests30d === null
                ? "Supahound counts this project's requests once a day. The first count sets the plan."
                : `${tier.requests30d.toLocaleString("en-US")} requests in the last ${USAGE_WINDOW_DAYS} days.`}
            </p>
            {needsEnterprise(tier.requests30d) && (
              <p className="mt-2 text-sm text-amber-900">Above {millions(ENTERPRISE_FROM_REQUESTS)} requests: the project stays on Pro, and we will contact you about Enterprise.</p>
            )}
          </section>

          <section className="mb-6 rounded-md border border-slate-200 bg-white p-6 text-sm text-slate-700">
            <h2 className="mb-2 font-semibold text-slate-950">How the plan is set</h2>
            <p>
              Traffic sets the plan. Up to {millions(PRO_FROM_REQUESTS)} requests in {USAGE_WINDOW_DAYS} days is Starter ({PRICE_LABEL.starter}).
              Above that is Pro ({PRICE_LABEL.pro}). A change takes effect at the next renewal.
            </p>
          </section>

          <ComingSoon title="A subscription for each project">
            <p className="mb-2">Each project will get its own subscription, with its own invoices and next charge on this page.</p>
            {d.role !== "member" && (
              <p>
                Until then, the card, invoices and receipts for every project are on{" "}
                <Link href={workspacePath(tenant, "billing")} className="underline">workspace billing</Link>.
              </p>
            )}
          </ComingSoon>
        </>
      )}
    </Shell>
  );
}
