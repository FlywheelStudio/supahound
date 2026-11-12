import type { ProjectSub } from "@supahound/core/billing/projects";
import { describe, expect, it } from "vitest";
import { canManageBilling, canSeeInvoices, dollars, monthlyTotalCents, subscriptionLine, summaryRows } from "../lib/projectBilling";

// How the billing pages describe project subscriptions (decision 041).

const NOW = new Date("2026-11-12T12:00:00Z");
const at = (days: number) => new Date(NOW.getTime() + days * 86_400_000);
const sub = (over: Partial<ProjectSub>): ProjectSub => ({
  subscriptionId: "sub_1", projectId: "p1", supabaseRef: "a".repeat(20), tier: "starter", status: "active", trialEnd: null,
  currentPeriodEnd: at(10), cancelAtPeriodEnd: false, ...over,
});

describe("subscriptionLine", () => {
  it("names the next charge, the first charge after a trial, and the end of a cancelled one", () => {
    expect(subscriptionLine(sub({}), NOW)).toEqual({ status: "Active", next: "Next charge 2026-11-22", price: "$19.99 per month" });
    expect(subscriptionLine(sub({ status: "trialing", trialEnd: at(3), tier: "pro" }), NOW)).toEqual({
      status: "Free trial", next: "First charge 2026-11-15 (after the trial)", price: "$99 per month",
    });
    expect(subscriptionLine(sub({ cancelAtPeriodEnd: true }), NOW)).toEqual({
      status: "Active, cancels at the period end", next: "Ends 2026-11-22, nothing more is charged", price: "$19.99 per month",
    });
    expect(subscriptionLine(sub({ status: "canceled" }), NOW).next).toBe("");
    expect(subscriptionLine(sub({ status: "past_due" }), NOW).status).toBe("Payment failed, retrying");
  });
});

describe("totals and rows", () => {
  it("adds up only live subscriptions that do not cancel", () => {
    const subs = [sub({ tier: "pro" }), sub({ subscriptionId: "sub_2", projectId: "p2" }), sub({ subscriptionId: "sub_3", cancelAtPeriodEnd: true }), sub({ subscriptionId: "sub_4", status: "canceled" })];
    expect(dollars(monthlyTotalCents(subs))).toBe("$118.99");
  });

  it("lists each project once (its live subscription) and removed projects still running out their period", () => {
    const subs = [
      sub({ subscriptionId: "sub_old", status: "canceled" }), sub({ subscriptionId: "sub_new" }),
      sub({ subscriptionId: "sub_gone", projectId: null, supabaseRef: "b".repeat(20), cancelAtPeriodEnd: true }),
      sub({ subscriptionId: "sub_gone_ended", projectId: null, status: "canceled" }),
      sub({ subscriptionId: "sub_hidden", projectId: "p9" }),
    ];
    const rows = summaryRows(subs, new Map([["p1", "Shop"]]));
    expect(rows.map((r) => [r.sub.subscriptionId, r.name])).toEqual([["sub_new", "Shop"], ["sub_gone", `Removed project (${"b".repeat(20)})`]]);
  });
});

describe("who manages billing (decision 036)", () => {
  it("lets workspace owners and admins open the portal, and project Owners and Admins see invoices", () => {
    expect([canManageBilling("owner"), canManageBilling("admin"), canManageBilling("member")]).toEqual([true, true, false]);
    expect(canSeeInvoices("member", "owner")).toBe(true);
    expect(canSeeInvoices("member", "admin")).toBe(true);
    expect(canSeeInvoices("member", "editor")).toBe(false);
    expect(canSeeInvoices("member", "viewer")).toBe(false);
    expect(canSeeInvoices("admin", "viewer")).toBe(true);
  });
});
