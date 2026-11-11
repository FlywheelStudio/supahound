import type { Pool } from "pg";
import {
  acceptBillingTerms, claimStripeEvent, getBilling, isStripeEventProcessed, projectTiers, recordCardRejected,
  refreshProjectTiers, saveSeats, saveSubscription, setStripeCustomer, type SubscriptionSnapshot,
} from "../db/billing.js";
import { withTenant } from "../db/tenant.js";
import { withTenantForUser } from "../db/user.js";
import { tenantId as parseTenantId, type TenantId, type UserId } from "../tenancy/scope.js";
import { accessFor, checkCard, seatsFor, TERMS_VERSION, type CardEvidence, type CardRejection, type Seats } from "./policy.js";

// The billing flow (decision 028). Stripe sits behind StripeGateway, so the flow runs against a
// fake in tests. No Stripe call ever runs inside a tenant transaction.

export interface VerificationSession {
  id: string;
  status: "open" | "complete" | "expired";
  tenant: string | null; // metadata.tenant_id, set by our server when it created the session
  customerId: string | null;
  hold: (CardEvidence & { paymentIntentId: string; releasable: boolean; paymentMethodId: string | null }) | null;
}

export interface StripeGateway {
  createCustomer(input: { tenant: TenantId; email: string | null; idempotencyKey: string }): Promise<{ id: string }>;
  createVerificationCheckout(input: {
    tenant: TenantId; customerId: string; successUrl: string; cancelUrl: string;
  }): Promise<{ id: string; url: string }>;
  getVerificationSession(id: string): Promise<VerificationSession>;
  releaseHold(paymentIntentId: string): Promise<void>;
  // The customer's subscription that is not canceled, if one exists.
  liveSubscription(customerId: string): Promise<(SubscriptionSnapshot & { cardVerifiedAt: Date | null }) | null>;
  createTrialSubscription(input: {
    tenant: TenantId; customerId: string; seats: Seats; paymentMethodId: string;
    cardVerifiedAt: Date; idempotencyKey: string;
  }): Promise<SubscriptionSnapshot>;
  getSubscription(id: string): Promise<SubscriptionSnapshot & { tenant: string | null; cardVerifiedAt: Date | null }>;
  // prorate: true when the customer adds or removes a project (charged now, pro rata); false when
  // a project changes tier from its usage, which takes effect at the next renewal (decision 028).
  setSeats(subscriptionId: string, seats: Seats, prorate: boolean): Promise<void>;
  portalUrl(customerId: string, returnUrl: string): Promise<string>;
}

export interface FlowDeps {
  pool: Pool;
  stripe: StripeGateway;
  appUrl: string;
  now: () => Date;
}

function parseTenant(v: string | null): TenantId | null {
  if (!v) return null;
  try {
    return parseTenantId(v);
  } catch {
    return null;
  }
}

export const billingPath = (tenant: TenantId, error?: string) => `/w/${tenant}/billing${error ? `?error=${error}` : ""}`;

// "Add card": owners and admins only, after they accept the terms on our page. Returns where to
// send the browser: Stripe Checkout, or back to one of our pages.
export async function startCheckout(
  deps: FlowDeps,
  input: { user: UserId; email: string | null; tenant: TenantId; acceptedTerms: boolean },
): Promise<string> {
  const { tenant } = input;
  const state: { next: string } | { customerId: string | null } = await withTenantForUser(deps.pool, input.user, tenant, async (tx, role) => {
    if (role === "member") return { next: billingPath(tenant, "role") };
    const billing = await getBilling(tx);
    if (accessFor(billing.status) !== "blocked") return { next: `/w/${tenant}` };
    if (!input.acceptedTerms) return { next: billingPath(tenant, "terms") };
    await acceptBillingTerms(tx, TERMS_VERSION, deps.now());
    return { customerId: billing.customerId };
  });
  if ("next" in state) return state.next;

  let customerId = state.customerId;
  if (!customerId) {
    // The same key for the same tenant, so a double click makes one customer, not two.
    customerId = (await deps.stripe.createCustomer({ tenant, email: input.email, idempotencyKey: `customer-${tenant}` })).id;
    await withTenant(deps.pool, tenant, (tx) => setStripeCustomer(tx, customerId!));
  }
  const session = await deps.stripe.createVerificationCheckout({
    tenant, customerId,
    successUrl: `${deps.appUrl}/w/${tenant}/billing/return?session_id={CHECKOUT_SESSION_ID}`,
    cancelUrl: `${deps.appUrl}${billingPath(tenant, "canceled")}`,
  });
  return session.url;
}

export type VerificationResult = "subscribed" | CardRejection | "pending" | "ignored";

// Finishes a Checkout: checks the card, releases the hold, starts the trial. Runs from the
// webhook and from the return URL; both may run at once or more than once, with the same result.
export async function completeVerification(
  deps: FlowDeps,
  sessionId: string,
  expectedTenant: TenantId | null,
): Promise<{ tenant: TenantId | null; result: VerificationResult }> {
  const s = await deps.stripe.getVerificationSession(sessionId);
  const tenant = parseTenant(s.tenant);
  if (!tenant || (expectedTenant && tenant !== expectedTenant) || !s.customerId) return { tenant, result: "ignored" };
  if (s.status !== "complete" || !s.hold) return { tenant, result: "pending" };

  const billing = await withTenant(deps.pool, tenant, (tx) => getBilling(tx));
  // The session must belong to the customer this tenant created. Metadata alone is not enough.
  if (billing.customerId !== s.customerId) return { tenant, result: "ignored" };

  const verdict = checkCard(s.hold);
  if (s.hold.releasable) await deps.stripe.releaseHold(s.hold.paymentIntentId);
  if (!verdict.ok) {
    await withTenant(deps.pool, tenant, (tx) => recordCardRejected(tx, verdict.reason));
    return { tenant, result: verdict.reason };
  }
  if (!s.hold.paymentMethodId) {
    await withTenant(deps.pool, tenant, (tx) => recordCardRejected(tx, "not_authorized"));
    return { tenant, result: "not_authorized" };
  }

  // Reuse a live subscription: a retry after the idempotency window must not start a second one.
  const existing = await deps.stripe.liveSubscription(s.customerId);
  const now = deps.now();
  let sub: SubscriptionSnapshot;
  let verifiedAt: Date;
  if (existing) {
    sub = existing;
    verifiedAt = existing.cardVerifiedAt ?? now;
  } else {
    const tiers = await withTenant(deps.pool, tenant, (tx) => projectTiers(tx));
    sub = await deps.stripe.createTrialSubscription({
      tenant, customerId: s.customerId, seats: seatsFor(tiers.map((t) => t.tier)), paymentMethodId: s.hold.paymentMethodId,
      cardVerifiedAt: now, idempotencyKey: `trial-${s.id}`,
    });
    verifiedAt = now;
  }
  await withTenant(deps.pool, tenant, (tx) => saveSubscription(tx, sub, verifiedAt));
  return { tenant, result: "subscribed" };
}

// Copies Stripe's current view of a subscription into the tenant's row. Stripe is the source of
// truth, so event order does not matter.
export async function refreshSubscription(deps: FlowDeps, subscriptionId: string): Promise<TenantId | null> {
  const sub = await deps.stripe.getSubscription(subscriptionId);
  const tenant = parseTenant(sub.tenant);
  if (!tenant) return null;
  const saved = await withTenant(deps.pool, tenant, async (tx) => {
    const billing = await getBilling(tx);
    if (billing.customerId !== sub.customerId) return false;
    // A subscription row needs a verified card (migration CHECK). Our subscriptions carry the
    // verification time in their metadata; one without it was not created by this flow.
    if (!billing.cardVerifiedAt && !sub.cardVerifiedAt) return false;
    await saveSubscription(tx, sub, sub.cardVerifiedAt);
    return true;
  });
  return saved ? tenant : null;
}

// Bills one seat per watched project at its tier. Called after the picker adds or removes a
// project (prorate: true), after the daily usage count (prorate: false), and when the overview
// sees the stored seats drift from the projects.
export async function syncSeats(deps: FlowDeps, tenant: TenantId, prorate: boolean): Promise<void> {
  const want = await withTenant(deps.pool, tenant, async (tx) => {
    const billing = await getBilling(tx);
    if (!billing.subscriptionId || accessFor(billing.status) === "blocked") return null;
    const seats = seatsFor((await projectTiers(tx)).map((t) => t.tier));
    const same = billing.seats && billing.seats.starter === seats.starter && billing.seats.pro === seats.pro;
    return same ? null : { subscriptionId: billing.subscriptionId, seats };
  });
  if (!want) return;
  await deps.stripe.setSeats(want.subscriptionId, want.seats, prorate);
  await withTenant(deps.pool, tenant, (tx) => saveSeats(tx, want.seats));
}

// After the daily usage count: set each project's tier from its last 30 days, then bill the new
// tiers from the next renewal. A project above the Enterprise line stays on Pro (decision 028).
export async function applyUsageTiers(deps: FlowDeps, tenant: TenantId, today: string): Promise<void> {
  await withTenant(deps.pool, tenant, (tx) => refreshProjectTiers(tx, today));
  await syncSeats(deps, tenant, false);
}

// A verified Stripe event, reduced to what the flow needs (apps/web/lib/stripe.ts builds it).
export interface BillingEvent {
  id: string;
  type: string;
  tenant: string | null;
  checkoutSessionId: string | null;
  subscriptionId: string | null;
}

export type WebhookResult = "processed" | "duplicate" | "ignored";

// The webhook, after the signature check. Idempotent per tenant: a replayed event ID is skipped,
// and every step is safe to run twice, so a crash before the event is recorded only means the
// retry repeats safe work.
export async function handleBillingEvent(deps: FlowDeps, e: BillingEvent): Promise<WebhookResult> {
  const tenant = parseTenant(e.tenant);
  if (!tenant) return "ignored";
  if (await withTenant(deps.pool, tenant, (tx) => isStripeEventProcessed(tx, e.id))) return "duplicate";

  let handled = false;
  if (e.type === "checkout.session.completed" && e.checkoutSessionId) {
    const { result } = await completeVerification(deps, e.checkoutSessionId, tenant);
    handled = result !== "ignored";
  } else if (e.subscriptionId && (e.type.startsWith("customer.subscription.") || e.type.startsWith("invoice."))) {
    handled = (await refreshSubscription(deps, e.subscriptionId)) === tenant;
  }
  if (!handled) return "ignored";
  await withTenant(deps.pool, tenant, (tx) => claimStripeEvent(tx, e.id, e.type));
  return "processed";
}
