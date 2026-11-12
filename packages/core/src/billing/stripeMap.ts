import type { SubscriptionSnapshot } from "../db/billing.js";
import type { BillingEvent, VerificationSession } from "./flow.js";
import {
  ENTERPRISE_FROM_REQUESTS, isBillingStatus, PRICE_LABEL, PRO_FROM_REQUESTS, TRIAL_DAYS, USAGE_WINDOW_DAYS, type Seats, type Tier,
} from "./policy.js";
import type { ProjectSub } from "./projects.js";

// Stripe objects → the shapes the billing flow works with. Pure, so the tests run on plain
// fixtures. Fields are read defensively: an API version change must fail closed (no access),
// never open.

type Obj = Record<string, unknown>;
const obj = (v: unknown): Obj | null => (v && typeof v === "object" ? (v as Obj) : null);
const str = (v: unknown): string | null => (typeof v === "string" ? v : null);
const idOf = (v: unknown): string | null => str(v) ?? str(obj(v)?.id);
const date = (v: unknown): Date | null => (typeof v === "number" ? new Date(v * 1000) : null);
const meta = (v: unknown, key: string): string | null => str(obj(obj(v)?.metadata)?.[key]);

export const PURPOSE = "card_verification";

export interface PriceIds {
  starter: string;
  pro: string;
}

// A Checkout Session retrieved with expand: ["payment_intent.latest_charge"].
export function sessionFromStripe(s: Obj): VerificationSession {
  const status = str(s.status);
  const pi = obj(s.payment_intent);
  const charge = obj(pi?.latest_charge);
  const details = obj(charge?.payment_method_details);
  // Fail closed: only a card payment can pass the check (decision 028).
  const card = details?.type === "card" ? obj(details.card) : null;
  return {
    id: str(s.id) ?? "",
    status: status === "complete" || status === "expired" ? status : "open",
    tenant: meta(s, "purpose") === PURPOSE ? meta(s, "tenant_id") : null,
    customerId: idOf(s.customer),
    // Set by our server when it created the session (decision 037). Missing (a session from before
    // this change) means the trial rule of that time: allowed.
    trialAllowed: meta(s, "trial") !== "no",
    hold: pi
      ? {
          paymentIntentId: str(pi.id) ?? "",
          releasable: pi.status === "requires_capture",
          paymentMethodId: idOf(pi.payment_method) ?? idOf(charge?.payment_method),
          approvedByIssuer: card !== null && charge?.status === "succeeded" && obj(charge.outcome)?.network_status === "approved_by_network",
          captured: charge?.captured === true,
          cvcCheck: str(obj(card?.checks)?.cvc_check),
          funding: str(card?.funding),
        }
      : null,
  };
}

// Seats per tier from the subscription's items, matched by price ID.
export function seatsFromItems(items: unknown, prices: PriceIds): Seats & { itemIds: Partial<Record<keyof PriceIds, string>> } {
  const data = (obj(items)?.data as unknown[] | undefined) ?? [];
  const out = { starter: 0, pro: 0, itemIds: {} as Partial<Record<keyof PriceIds, string>> };
  for (const raw of data) {
    const item = obj(raw);
    const price = idOf(item?.price);
    const tier = price === prices.starter ? "starter" : price === prices.pro ? "pro" : null;
    if (!tier || !item) continue;
    out[tier] += typeof item.quantity === "number" && item.quantity > 0 ? item.quantity : 0;
    const itemId = str(item.id);
    if (itemId) out.itemIds[tier] = itemId;
  }
  return out;
}

// A subscription as the flow reads it from Stripe: a seat subscription (decision 028) or a project
// subscription (decision 041: metadata.project_id, one item at the project's tier).
export type StripeSubscription = SubscriptionSnapshot & {
  tenant: string | null;
  cardVerifiedAt: Date | null;
  projectId: string | null;
  supabaseRef: string | null;
  // The tier of a project subscription's item; null for a seat subscription.
  tier: Tier | null;
  // metadata.converted: the conversion CLI set this seat subscription to cancel (decision 041).
  converted: boolean;
  defaultPaymentMethod: string | null;
};

export function subscriptionFromStripe(s: Obj, prices: PriceIds): StripeSubscription {
  const seats = seatsFromItems(s.items, prices);
  const firstItem = obj((obj(s.items)?.data as unknown[] | undefined)?.[0]);
  const status = str(s.status);
  const verified = meta(s, "card_verified_at");
  const verifiedAt = verified ? new Date(verified) : null;
  return {
    id: str(s.id) ?? "",
    customerId: idOf(s.customer) ?? "",
    // Unknown status: treat as canceled, which closes the gate.
    status: isBillingStatus(status) && status !== "none" ? status : "canceled",
    seats: { starter: seats.starter, pro: seats.pro },
    trialEnd: date(s.trial_end),
    currentPeriodEnd: date(firstItem?.current_period_end) ?? date(s.current_period_end),
    cancelAtPeriodEnd: s.cancel_at_period_end === true,
    tenant: meta(s, "tenant_id"),
    cardVerifiedAt: verifiedAt && !Number.isNaN(verifiedAt.getTime()) ? verifiedAt : null,
    projectId: meta(s, "project_id"),
    supabaseRef: meta(s, "supabase_ref"),
    tier: meta(s, "project_id") === null ? null : seats.pro > 0 ? "pro" : seats.starter > 0 ? "starter" : null,
    converted: meta(s, "converted") === "yes",
    defaultPaymentMethod: idOf(s.default_payment_method),
  };
}

// A project subscription in the shape project_subscriptions stores. Null when it is not one, or
// when its item is not at a known price (fail closed: no row, so it counts for nothing).
export function projectSubFromStripe(s: StripeSubscription): (Omit<ProjectSub, "projectId"> & { projectId: string }) | null {
  if (!s.projectId || !s.tier || !s.supabaseRef || !/^[a-z0-9]{20}$/.test(s.supabaseRef)) return null;
  return {
    subscriptionId: s.id, projectId: s.projectId, supabaseRef: s.supabaseRef, tier: s.tier, status: s.status,
    trialEnd: s.trialEnd, currentPeriodEnd: s.currentPeriodEnd, cancelAtPeriodEnd: s.cancelAtPeriodEnd,
  };
}

export interface InvoiceSummary {
  id: string;
  number: string | null;
  created: Date | null;
  totalCents: number;
  currency: string;
  status: string;
  hostedUrl: string | null;
}

// An invoice, for the project's Plan & billing page. Only https links from Stripe are kept.
export function invoiceFromStripe(i: Obj): InvoiceSummary {
  const url = str(i.hosted_invoice_url);
  return {
    id: str(i.id) ?? "", number: str(i.number), created: date(i.created),
    totalCents: typeof i.total === "number" ? i.total : 0, currency: str(i.currency) ?? "usd",
    status: str(i.status) ?? "unknown", hostedUrl: url && url.startsWith("https://") ? url : null,
  };
}

// A verified Stripe event → what the flow needs. Unknown types carry no tenant and are ignored.
export function billingEventFromStripe(e: Obj): BillingEvent {
  const type = str(e.type) ?? "";
  const o = obj(obj(e.data)?.object) ?? {};
  const base = { id: str(e.id) ?? "", type, tenant: null, checkoutSessionId: null, subscriptionId: null };
  if (type === "checkout.session.completed" || type === "checkout.session.async_payment_succeeded") {
    if (meta(o, "purpose") !== PURPOSE) return base;
    return { ...base, type: "checkout.session.completed", tenant: meta(o, "tenant_id"), checkoutSessionId: str(o.id) };
  }
  if (type.startsWith("customer.subscription.")) {
    return { ...base, tenant: meta(o, "tenant_id"), subscriptionId: str(o.id) };
  }
  if (type.startsWith("invoice.")) {
    const details = obj(obj(o.parent)?.subscription_details);
    return { ...base, tenant: meta(details, "tenant_id"), subscriptionId: idOf(details?.subscription) };
  }
  return base;
}

const millions = (n: number) => `${n / 1_000_000} million`;

// The billing terms shown on our page and next to Stripe's pay button (decision 028, point 6).
// trial false: the workspace or its owner already had the free trial (decision 037).
export function termsText(trial = true): string {
  const start = trial
    ? `Free for ${TRIAL_DAYS} days. `
    : "No free trial: this workspace or its owner already had one, so the first charge is today. ";
  const end = trial ? "Cancel any time from Billing; cancel before the trial ends and you pay nothing." : "Cancel any time from Billing.";
  return `${start}We place a $1 hold on your card to confirm it with your bank, and release it at once. ` +
    `Each watched project has its own monthly subscription: ${PRICE_LABEL.starter} per month, or ${PRICE_LABEL.pro} per month if it sent more than ` +
    `${millions(PRO_FROM_REQUESTS)} requests in the last ${USAGE_WINDOW_DAYS} days. ` +
    `${trial ? "Projects you add during the trial are free until it ends; a project added after it" : "A project"} is billed from the day you add it, ` +
    "and removing a project stops its charges at the end of its paid month. " +
    `A project's price follows its traffic and changes at the next monthly charge. Above ${millions(ENTERPRISE_FROM_REQUESTS)} requests ` +
    `a project stays at ${PRICE_LABEL.pro} and we contact you about Enterprise. ` +
    end;
}
