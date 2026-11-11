"use server";

import { billingPath, startCheckout } from "@supahound/core/billing/flow";
import { getBilling } from "@supahound/core/db/billing";
import { NotAMemberError, withTenantForUser } from "@supahound/core/db/user";
import { tenantId as parseTenantId, type TenantId } from "@supahound/core/tenancy/scope";
import { env } from "cloudflare:workers";
import { notFound, redirect } from "next/navigation";
import { flowDeps } from "../../../../lib/billing";
import { withPool } from "../../../../lib/db";
import { stripeGateway } from "../../../../lib/stripe";
import { requireUser } from "../../../../lib/supabase";

function tenantOr404(value: FormDataEntryValue | null): TenantId {
  try {
    return parseTenantId(String(value ?? ""));
  } catch {
    notFound();
  }
}

function memberOr404(err: unknown): never {
  if (err instanceof NotAMemberError) notFound();
  throw err;
}

// "Add card and start trial": the tenant comes from the form but is checked against the signed-in
// user's membership; Stripe gets it only from our server (metadata), never from the browser.
export async function startCheckoutAction(formData: FormData): Promise<void> {
  const user = await requireUser();
  const tenant = tenantOr404(formData.get("tenantId"));
  const next = await withPool((pool) =>
    startCheckout(flowDeps(pool), { user: user.id, email: user.email, tenant, acceptedTerms: formData.get("terms") === "on" }),
  ).catch(memberOr404);
  redirect(next);
}

// The Stripe Billing Portal: change the card or plan, or cancel. Owners and admins only.
export async function openPortalAction(formData: FormData): Promise<void> {
  const user = await requireUser();
  const tenant = tenantOr404(formData.get("tenantId"));
  const customer = await withPool((pool) =>
    withTenantForUser(pool, user.id, tenant, async (tx, role) => (role === "member" ? null : (await getBilling(tx)).customerId)),
  ).catch(memberOr404);
  if (!customer) redirect(billingPath(tenant, "role"));
  redirect(await stripeGateway().portalUrl(customer, `${env.APP_URL}${billingPath(tenant)}`));
}
