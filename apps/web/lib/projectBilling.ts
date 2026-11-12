import { PRICE_CENTS, PRICE_LABEL, type BillingStatus, type Tier } from "@supahound/core/billing/policy";
import { isLive, type ProjectSub } from "@supahound/core/billing/projects";

// How the billing pages describe one project subscription (decision 041). Pure, so every branch
// is unit-tested without a browser.

const day = (d: Date) => d.toISOString().slice(0, 10);

export const STATUS_LABEL: Record<BillingStatus, string> = {
  none: "No subscription",
  trialing: "Free trial",
  active: "Active",
  past_due: "Payment failed, retrying",
  incomplete: "First payment pending",
  incomplete_expired: "First payment failed",
  unpaid: "Unpaid",
  canceled: "Ended",
  paused: "Paused",
};

export const tierLabel = (t: Tier) => (t === "pro" ? "Pro" : "Starter");

export interface SubscriptionLine {
  status: string;
  // "Next charge 2026-12-01", "First charge 2026-11-19 (after the trial)", "Ends 2026-12-01", or "".
  next: string;
  price: string;
}

export function subscriptionLine(s: ProjectSub, now: Date): SubscriptionLine {
  const price = `${PRICE_LABEL[s.tier]} per month`;
  if (!isLive(s.status)) return { status: STATUS_LABEL[s.status], next: "", price };
  const end = s.status === "trialing" ? s.trialEnd ?? s.currentPeriodEnd : s.currentPeriodEnd;
  let next = "";
  if (end && end > now) {
    if (s.cancelAtPeriodEnd) next = `Ends ${day(end)}, nothing more is charged`;
    else if (s.status === "trialing") next = `First charge ${day(end)} (after the trial)`;
    else next = `Next charge ${day(end)}`;
  }
  return { status: s.cancelAtPeriodEnd ? `${STATUS_LABEL[s.status]}, cancels at the period end` : STATUS_LABEL[s.status], next, price };
}

// What the workspace pays each month from its next charges: live subscriptions that do not cancel.
export function monthlyTotalCents(subs: readonly ProjectSub[]): number {
  return subs.filter((s) => isLive(s.status) && !s.cancelAtPeriodEnd).reduce((sum, s) => sum + PRICE_CENTS[s.tier], 0);
}

export const dollars = (cents: number) => `$${(cents / 100).toFixed(2)}`;

// The rows the workspace billing page lists: each project's current subscription, and the
// subscriptions of removed projects that still run out their period.
export function summaryRows(subs: readonly ProjectSub[], names: ReadonlyMap<string, string>): { sub: ProjectSub; name: string }[] {
  const out: { sub: ProjectSub; name: string }[] = [];
  const seen = new Set<string>();
  for (const s of [...subs].reverse()) {
    if (s.projectId) {
      if (seen.has(s.projectId) || !names.has(s.projectId)) continue;
      // A project's live subscription speaks for it; else its most recent one.
      const live = subs.find((x) => x.projectId === s.projectId && isLive(x.status));
      out.push({ sub: live ?? s, name: names.get(s.projectId)! });
      seen.add(s.projectId);
    } else if (isLive(s.status)) {
      out.push({ sub: s, name: `Removed project (${s.supabaseRef})` });
    }
  }
  return out.reverse();
}

// Who manages billing (decision 036: billing keeps the workspace role): workspace owners and
// admins open the Billing Portal. A project's Owners and Admins also see its invoices (amounts
// for their own project only); Editors and Viewers see the plan and status.
export const canManageBilling = (workspaceRole: "owner" | "admin" | "member") => workspaceRole !== "member";
export const canSeeInvoices = (workspaceRole: "owner" | "admin" | "member", projectRole: "owner" | "admin" | "editor" | "viewer") =>
  workspaceRole !== "member" || projectRole === "owner" || projectRole === "admin";
