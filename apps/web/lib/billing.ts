import { parseExemptDomains, type Access } from "@supahound/core/billing/policy";
import { billingPath, syncSeats, type FlowDeps } from "@supahound/core/billing/flow";
import { billingMode, PaymentRequiredError, withPaidTenantForUser, type BillingMode } from "@supahound/core/db/billing";
import type { TenantTx } from "@supahound/core/db/tenant";
import type { Role } from "@supahound/core/db/user";
import type { TenantId, UserId } from "@supahound/core/tenancy/scope";
import { env } from "cloudflare:workers";
import { redirect } from "next/navigation";
import type pg from "pg";
import { stripeGateway } from "./stripe";

// The web side of the billing gate (decision 028). Every tenant page and action calls paidTenant;
// ESLint blocks the ungated withTenantForUser outside app/w/[tenantId]/billing.

export function mode(): BillingMode {
  return billingMode(env.SUPAHOUND_BILLING);
}

// Decision 029: the email domains whose sole owners get a workspace without billing.
export function exemptDomains(): readonly string[] {
  return parseExemptDomains(env.SUPAHOUND_BILLING_EXEMPT_DOMAINS);
}

export function paidTenant<T>(
  pool: pg.Pool,
  user: UserId,
  tenant: TenantId,
  fn: (tx: TenantTx, role: Role, access: Access) => Promise<T>,
): Promise<T> {
  return withPaidTenantForUser(pool, mode(), user, tenant, fn);
}

// For .catch() on a gated call: a workspace without a validated card goes to its billing page.
export function toBillingIfUnpaid(err: unknown): void {
  if (err instanceof PaymentRequiredError) redirect(billingPath(err.tenant));
}

export function flowDeps(pool: pg.Pool): FlowDeps {
  return { pool, stripe: stripeGateway(), appUrl: env.APP_URL, now: () => new Date() };
}

// After the picker adds or removes a project: bill the new count now, pro rata. A failure is logged, not shown;
// the overview syncs again when it sees the stored seats drift from the project count.
// prorate: true after the picker (a project added now is billed now); false when the overview
// repairs drift, so a repair never charges anything before the next renewal.
export async function syncSeatsAfterChange(pool: pg.Pool, tenant: TenantId, prorate = true): Promise<void> {
  if (mode() === "off") return;
  try {
    await syncSeats(flowDeps(pool), tenant, prorate);
  } catch {
    console.log(JSON.stringify({ event: "seat_sync_failed", tenant_id: tenant }));
  }
}
