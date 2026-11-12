// Billing rules (decision 028). Pure functions: no Stripe, no database.

// Per-project pricing by traffic (decision 028, revised 2026-11-10). Each watched project bills
// at its own tier, set from its edge-log requests in the last 30 days.
export type Tier = "starter" | "pro";
export const TIERS: readonly Tier[] = ["starter", "pro"];

export function isTier(v: unknown): v is Tier {
  return v === "starter" || v === "pro";
}

export const TRIAL_DAYS = 7;
// The authorization that validates the card, in cents. Released at once, never captured.
export const VERIFICATION_HOLD_CENTS = 100;
export const VERIFICATION_CURRENCY = "usd";
// Bump when the billing terms on the billing page change; stored with each acceptance.
export const TERMS_VERSION = "2026-11-10.2";

export const PRICE_CENTS: Record<Tier, number> = { starter: 1999, pro: 9900 };
export const PRICE_LABEL: Record<Tier, string> = { starter: "$19.99", pro: "$99" };
// Requests in 30 days at which a project moves up. Above ENTERPRISE it stays on Pro and is
// flagged for an Enterprise conversation; nothing above Pro is charged automatically.
export const PRO_FROM_REQUESTS = 1_000_000;
export const ENTERPRISE_FROM_REQUESTS = 10_000_000;
export const USAGE_WINDOW_DAYS = 30;

export function tierFor(requests30d: number | null): Tier {
  return requests30d !== null && requests30d > PRO_FROM_REQUESTS ? "pro" : "starter";
}

export function needsEnterprise(requests30d: number | null): boolean {
  return requests30d !== null && requests30d > ENTERPRISE_FROM_REQUESTS;
}

export interface Seats {
  starter: number;
  pro: number;
}

// Seats billed for a workspace: one per watched project at its tier, and at least one Starter
// seat, so a validated workspace with no projects still pays $19.99 after the trial.
export function seatsFor(tiers: readonly Tier[]): Seats {
  const pro = tiers.filter((t) => t === "pro").length;
  const starter = tiers.length - pro;
  return { starter: tiers.length === 0 ? 1 : starter, pro };
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

// Staff workspaces (decision 029): a workspace whose only owner has a verified email on an exempt
// domain gets full access with no card and no Stripe subscription.
export function accessForAccount(account: { status: BillingStatus; exempt: boolean }): Access {
  return account.exempt ? "full" : accessFor(account.status);
}

const DOMAIN = /^(?=.{1,253}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/;

// SUPAHOUND_BILLING_EXEMPT_DOMAINS: a comma-separated list such as "example.com,example.org".
// Empty or unset means no exemptions. A malformed entry throws, so a typo cannot pass silently.
export function parseExemptDomains(value: unknown): readonly string[] {
  if (value === undefined || value === null || value === "") return [];
  if (typeof value !== "string") throw new Error("SUPAHOUND_BILLING_EXEMPT_DOMAINS must be a string");
  const domains = value.split(",").map((d) => d.trim().toLowerCase()).filter((d) => d !== "");
  for (const d of domains) {
    if (!DOMAIN.test(d)) throw new Error(`SUPAHOUND_BILLING_EXEMPT_DOMAINS: "${d}" is not a domain`);
  }
  return domains;
}

// Exact match on the part after the last "@". Subdomains do not match: "a@x.example.com" is not
// on "example.com". The email must come from a verified session (getClaims()).
export function isExemptEmail(email: string | null, domains: readonly string[]): boolean {
  if (!email || domains.length === 0) return false;
  const at = email.lastIndexOf("@");
  if (at <= 0 || at === email.length - 1) return false;
  return domains.includes(email.slice(at + 1).toLowerCase());
}

// Paying (decision 037): the workspace has a live paid subscription, or a staff exemption
// (decision 029). Stripe keeps "active" until the end of a period that a closing owner canceled,
// so the paid time after a close counts. "past_due" counts: Stripe still retries the payment. A
// trial that never paid does not count, nor does a self-hosted copy without billing. While a
// workspace pays, Supahound deletes none of its data: no retention, no purge, no delete after a
// disconnect. This is the only definition; every deletion path calls it.
export const PAYING_STATUSES: readonly BillingStatus[] = ["active", "past_due"];

export function payingAccount(account: { status: BillingStatus; exempt: boolean }): boolean {
  return account.exempt || PAYING_STATUSES.includes(account.status);
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
