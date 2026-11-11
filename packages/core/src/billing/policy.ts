// Billing rules (decision 028). Pure functions: no Stripe, no database.

export type Plan = "builder" | "agency";
export const PLANS: readonly Plan[] = ["builder", "agency"];

export function isPlan(v: unknown): v is Plan {
  return v === "builder" || v === "agency";
}

export const TRIAL_DAYS = 7;
// The authorization that validates the card, in cents. Released at once, never captured.
export const VERIFICATION_HOLD_CENTS = 100;
export const VERIFICATION_CURRENCY = "usd";
// Bump when the billing terms on the billing page change; stored with each acceptance.
export const TERMS_VERSION = "2026-11-10";

const MIN_SEATS: Record<Plan, number> = { builder: 1, agency: 10 };
export const PRICE_PER_SEAT_USD: Record<Plan, number> = { builder: 29, agency: 19 };

// Seats billed for a number of watched projects: Builder at least 1, Agency at least 10.
export function seatsFor(plan: Plan, projects: number): number {
  if (!Number.isInteger(projects) || projects < 0) throw new Error(`Invalid project count: ${projects}`);
  return Math.max(MIN_SEATS[plan], projects);
}

// Stripe subscription statuses, plus "none" before any subscription exists.
export type BillingStatus =
  | "none" | "incomplete" | "incomplete_expired" | "trialing" | "active" | "past_due" | "canceled" | "unpaid" | "paused";

const STATUSES: readonly BillingStatus[] = [
  "none", "incomplete", "incomplete_expired", "trialing", "active", "past_due", "canceled", "unpaid", "paused",
];

export function isBillingStatus(v: unknown): v is BillingStatus {
  return typeof v === "string" && (STATUSES as readonly string[]).includes(v);
}

// What a workspace may do. "grace": everything, with a banner, while Stripe retries a failed
// payment. "blocked": the billing page only.
export type Access = "full" | "grace" | "blocked";

export function accessFor(status: BillingStatus): Access {
  switch (status) {
    case "trialing":
    case "active":
      return "full";
    case "past_due":
      return "grace";
    default:
      return "blocked";
  }
}

// The statuses whose projects the poller still polls. Kept next to accessFor so the two agree.
export const POLLABLE_STATUSES: readonly BillingStatus[] = STATUSES.filter((s) => accessFor(s) !== "blocked");

// The card check (decision 028, point 3). Input comes from the $1 hold's charge, which keeps the
// issuer's answer after the hold is released. So a retried webhook reaches the same verdict
// whether or not the hold was already released.
export interface CardEvidence {
  // charge.outcome.network_status === "approved_by_network" and charge.status === "succeeded"
  approvedByIssuer: boolean;
  // charge.captured: this flow never captures, so a captured charge is a bug, not a pass.
  captured: boolean;
  cvcCheck: string | null; // "pass" | "fail" | "unavailable" | "unchecked" | null
  funding: string | null; // "credit" | "debit" | "prepaid" | "unknown" | null
}

export type CardRejection = "not_authorized" | "cvc_failed" | "prepaid";
export type CardVerdict = { ok: true } | { ok: false; reason: CardRejection };

export function checkCard(e: CardEvidence): CardVerdict {
  if (!e.approvedByIssuer || e.captured) return { ok: false, reason: "not_authorized" };
  if (e.cvcCheck === "fail") return { ok: false, reason: "cvc_failed" };
  if (e.funding === "prepaid") return { ok: false, reason: "prepaid" };
  return { ok: true };
}

export const REJECTION_TEXT: Record<CardRejection | "canceled" | "error", string> = {
  not_authorized: "Your bank did not approve the card check. Try another card.",
  cvc_failed: "The security code did not match. Check it, or try another card.",
  prepaid: "Prepaid cards are not accepted. Use a credit or debit card.",
  canceled: "No card was added.",
  error: "Something went wrong while checking the card. Try again.",
};
