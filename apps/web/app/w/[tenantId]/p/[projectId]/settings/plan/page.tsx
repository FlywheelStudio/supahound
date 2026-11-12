import { ENTERPRISE_FROM_REQUESTS, needsEnterprise, PRICE_LABEL, PRO_FROM_REQUESTS, USAGE_WINDOW_DAYS } from "@supahound/core/billing/policy";
import { currentSubFor, trialEndsAt } from "@supahound/core/billing/projects";
import type { InvoiceSummary } from "@supahound/core/billing/stripeMap";
import { getBilling, listProjectSubscriptions } from "@supahound/core/db/billing";
import Link from "next/link";
import { Shell } from "../../../../../../../components/Shell";
import { mode } from "../../../../../../../lib/billing";
import { workspacePath } from "../../../../../../../lib/nav";
import { loadProjectPage } from "../../../../../../../lib/projectPage";
import { canManageBilling, canSeeInvoices, dollars, STATUS_LABEL, subscriptionLine, tierLabel } from "../../../../../../../lib/projectBilling";
import { stripeGateway } from "../../../../../../../lib/stripe";
import { openProjectPortalAction } from "./actions";

// Project settings → Plan & billing (issues #98 and #99). Each project has its own Stripe
// subscription (decisions 032 and 041): this page shows its plan, status, next charge and
// invoices. The tier follows traffic (decision 028). Workspace owners and admins open the Billing
// Portal; a project's Owners and Admins see its invoices; Editors and Viewers see the plan.

const millions = (n: number) => `${n / 1_000_000} million`;
const INVOICES = 12;

export default async function ProjectPlan({
  params,
  searchParams,
}: {
  params: Promise<{ tenantId: string; projectId: string }>;
  searchParams: Promise<Record<string, string | undefined>>;
}) {
  const d = await loadProjectPage(params, async (tx, project) => {
    const billing = await getBilling(tx);
    return { billing, sub: currentSubFor(project.id, await listProjectSubscriptions(tx)) };
  });
  const { tenant, project: p } = d;
  const { billing, sub } = d.extra;
  const billingOn = mode() !== "off";
  const tier = d.tiers.find((t) => t.id === p.id);
  const now = new Date();
  const manage = canManageBilling(d.role);
  const showInvoices = canSeeInvoices(d.role, d.projectRole);
  const query = await searchParams;

  // Stripe is read outside the database transaction. A failure hides the list, not the page.
  let invoices: InvoiceSummary[] | null = null;
  if (billingOn && showInvoices && sub) {
    invoices = await stripeGateway().invoices(sub.subscriptionId, INVOICES).catch(() => null);
  }
  const line = sub ? subscriptionLine(sub, now) : null;
  const trialEnd = trialEndsAt(billing, now);

  return (
    <Shell tenant={tenant} role={d.role} projects={d.projects} tiers={d.tiers} billingOn={billingOn} active={{ kind: "project", project: p, page: "plan" }}>
      <h1 className="mb-6 text-2xl font-semibold">Plan &amp; billing</h1>
      {query.error === "role" && (
        <p role="alert" className="mb-6 rounded-md border border-red-200 bg-red-50 p-3 text-sm text-red-900">
          Only workspace owners and admins can manage billing.
        </p>
      )}
      {!billingOn || !tier ? (
        <p className="text-slate-600">Billing is off on this copy of Supahound.</p>
      ) : (
        <>
          <section aria-labelledby="plan-heading" className="mb-6 rounded-md border border-slate-200 bg-white p-6">
            <h2 id="plan-heading" className="mb-1 text-sm font-medium uppercase tracking-wide text-slate-500">Current plan</h2>
            <p className="text-2xl font-semibold">
              {tierLabel(tier.tier)} <span className="text-base font-normal text-slate-600">{PRICE_LABEL[tier.tier]} per month</span>
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

          <section aria-label="Subscription" className="mb-6 rounded-md border border-slate-200 bg-white p-6">
            <h2 className="mb-3 font-semibold">Subscription</h2>
            {billing.exempt ? (
              <p className="text-sm text-slate-700">Complimentary: this workspace is not billed.</p>
            ) : billing.model === "workspace" ? (
              <p className="text-sm text-slate-700">
                This workspace is still billed on one subscription for all its projects. It moves to one subscription per project
                at its next renewal, with no double charge.{" "}
                {manage && <Link href={workspacePath(tenant, "billing")} className="underline">Workspace billing</Link>}
              </p>
            ) : !sub || !line ? (
              <p className="text-sm text-slate-700">
                {p.paused ? "This project is paused, so it is not billed." : "Supahound is setting up this project's subscription. Refresh in a moment."}
              </p>
            ) : (
              <dl className="grid grid-cols-[10rem_1fr] gap-y-2 text-sm">
                <dt className="text-slate-500">Status</dt>
                <dd data-testid="subscription-status">{line.status}</dd>
                <dt className="text-slate-500">Billed at</dt>
                <dd>{tierLabel(sub.tier)}, {line.price}</dd>
                {line.next && (<>
                  <dt className="text-slate-500">Next</dt>
                  <dd data-testid="subscription-next">{line.next}</dd>
                </>)}
                {sub.tier !== tier.tier && (<>
                  <dt className="text-slate-500">From the next renewal</dt>
                  <dd>{tierLabel(tier.tier)}, {PRICE_LABEL[tier.tier]} per month</dd>
                </>)}
              </dl>
            )}
            {billing.model === "project" && trialEnd && !sub && !p.paused && (
              <p className="mt-2 text-sm text-slate-600">The workspace trial runs until {trialEnd.toISOString().slice(0, 10)}.</p>
            )}
            {manage && billing.model === "project" && !billing.exempt && (
              <form action={openProjectPortalAction} className="mt-6">
                <input type="hidden" name="tenantId" value={tenant} />
                <input type="hidden" name="projectId" value={p.id} />
                <button className="rounded-md bg-slate-950 px-4 py-2 font-medium text-white hover:bg-slate-800">Manage card and invoices</button>
              </form>
            )}
            {!manage && billing.model === "project" && (
              <p className="mt-4 text-sm text-slate-600">Workspace owners and admins manage the card and billing.</p>
            )}
          </section>

          {showInvoices && billing.model === "project" && sub && (
            <section aria-label="Invoices" className="mb-6 rounded-md border border-slate-200 bg-white p-6">
              <h2 className="mb-3 font-semibold">Invoices</h2>
              {invoices === null ? (
                <p className="text-sm text-slate-600">The invoices could not be loaded. Try again in a moment.</p>
              ) : invoices.length === 0 ? (
                <p className="text-sm text-slate-600">No invoices yet.</p>
              ) : (
                <ul className="divide-y divide-slate-200 text-sm">
                  {invoices.map((i) => (
                    <li key={i.id} className="flex justify-between py-2">
                      <span>{i.created ? i.created.toISOString().slice(0, 10) : ""} · {i.number ?? "Draft"}</span>
                      <span>
                        {dollars(i.totalCents)} · {i.status}
                        {i.hostedUrl && <> · <a href={i.hostedUrl} className="underline">View</a></>}
                      </span>
                    </li>
                  ))}
                </ul>
              )}
            </section>
          )}

          <section className="mb-6 rounded-md border border-slate-200 bg-white p-6 text-sm text-slate-700">
            <h2 className="mb-2 font-semibold text-slate-950">How the plan is set</h2>
            <p>
              Traffic sets the plan. Up to {millions(PRO_FROM_REQUESTS)} requests in {USAGE_WINDOW_DAYS} days is Starter ({PRICE_LABEL.starter}).
              Above that is Pro ({PRICE_LABEL.pro}). A change takes effect at the next renewal. Removing the project stops its
              charges at the end of its paid month.
            </p>
            {sub && sub.status !== "active" && sub.status !== "trialing" && (
              <p className="mt-2">Status now: {STATUS_LABEL[sub.status]}.</p>
            )}
          </section>
        </>
      )}
    </Shell>
  );
}
