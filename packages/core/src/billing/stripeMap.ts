import type { SubscriptionSnapshot } from "../db/billing.js";
import type { BillingEvent, VerificationSession } from "./flow.js";
import {
  ENTERPRISE_FROM_REQUESTS, isBillingStatus, PRICE_LABEL, PRO_FROM_REQUESTS, TRIAL_DAYS, USAGE_WINDOW_DAYS, type Seats,
} from "./policy.js";

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

export function subscriptionFromStripe(s: Obj, prices: PriceIds): SubscriptionSnapshot & {
  tenant: string | null;
  cardVerifiedAt: Date | null;
} {
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
export function termsText(): string {
  return `Free for ${TRIAL_DAYS} days. We place a $1 hold on your card to confirm it with your bank, and release it at once. ` +
    `After the trial, each watched project costs ${PRICE_LABEL.starter} per month, or ${PRICE_LABEL.pro} per month if it sent more than ` +
    `${millions(PRO_FROM_REQUESTS)} requests in the last ${USAGE_WINDOW_DAYS} days (you pay for at least one project). ` +
    `A project's price follows its traffic and changes at the next monthly charge. Above ${millions(ENTERPRISE_FROM_REQUESTS)} requests ` +
    `a project stays at ${PRICE_LABEL.pro} and we contact you about Enterprise. ` +
    `Cancel any time from Billing; cancel before the trial ends and you pay nothing.`;
}
