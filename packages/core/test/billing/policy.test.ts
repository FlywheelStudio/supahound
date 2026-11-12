import { describe, expect, it } from "vitest";
import {
  accessFor, accessForAccount, checkCard, isExemptEmail, needsEnterprise, parseExemptDomains, payingAccount, POLLABLE_STATUSES, seatsFor, tierFor, type BillingStatus,
} from "../../src/billing/policy.js";

const ALL: BillingStatus[] = ["none", "incomplete", "incomplete_expired", "trialing", "active", "past_due", "canceled", "unpaid", "paused"];

describe("billing policy (decision 028)", () => {
  it("opens the app only while trialing, active, or past due (with a banner)", () => {
    expect(Object.fromEntries(ALL.map((s) => [s, accessFor(s)]))).toEqual({
      none: "blocked", incomplete: "blocked", incomplete_expired: "blocked", trialing: "full", active: "full",
      past_due: "grace", canceled: "blocked", unpaid: "blocked", paused: "blocked",
    });
  });

  it("polls exactly the statuses the gate lets in", () => {
    expect([...POLLABLE_STATUSES].sort()).toEqual(["active", "past_due", "trialing"]);
  });

  it("puts a project on Pro above 1 million requests in 30 days, and flags Enterprise above 10 million", () => {
    expect([null, 0, 999_999, 1_000_000, 1_000_001, 9_999_999, 50_000_000].map(tierFor)).toEqual([
      "starter", "starter", "starter", "starter", "pro", "pro", "pro",
    ]);
    expect([null, 10_000_000, 10_000_001].map(needsEnterprise)).toEqual([false, false, true]);
  });

  it("bills one seat per project at its tier, and at least one Starter seat", () => {
    expect(seatsFor([])).toEqual({ starter: 1, pro: 0 });
    expect(seatsFor(["starter", "starter", "pro"])).toEqual({ starter: 2, pro: 1 });
    expect(seatsFor(["pro"])).toEqual({ starter: 0, pro: 1 });
  });

  const ok = { approvedByIssuer: true, captured: false, cvcCheck: "pass", funding: "credit" };

  it("accepts an issuer-approved hold whose CVC did not fail", () => {
    for (const cvcCheck of ["pass", "unavailable", "unchecked", null]) {
      expect(checkCard({ ...ok, cvcCheck }), String(cvcCheck)).toEqual({ ok: true });
    }
    expect(checkCard({ ...ok, funding: "debit" })).toEqual({ ok: true });
  });

  it("refuses a declined or captured hold, a failed CVC, and a prepaid card", () => {
    expect(checkCard({ ...ok, approvedByIssuer: false })).toEqual({ ok: false, reason: "not_authorized" });
    expect(checkCard({ ...ok, captured: true })).toEqual({ ok: false, reason: "not_authorized" });
    expect(checkCard({ ...ok, cvcCheck: "fail" })).toEqual({ ok: false, reason: "cvc_failed" });
    expect(checkCard({ ...ok, funding: "prepaid" })).toEqual({ ok: false, reason: "prepaid" });
  });
});

describe("staff exemption (decision 029)", () => {
  const domains = parseExemptDomains(" Example.com , example.org ");

  it("parses a comma-separated list, lowercased; empty or unset means none", () => {
    expect(domains).toEqual(["example.com", "example.org"]);
    expect(parseExemptDomains("")).toEqual([]);
    expect(parseExemptDomains(undefined)).toEqual([]);
  });

  it("refuses a malformed entry instead of ignoring it", () => {
    for (const bad of ["example", "@example.com", "*.example.com", "example.com/x", "exa mple.com", "https://example.com"]) {
      expect(() => parseExemptDomains(bad), bad).toThrow(/SUPAHOUND_BILLING_EXEMPT_DOMAINS/);
    }
    expect(() => parseExemptDomains(1)).toThrow();
  });

  it("matches the exact domain after the last @, in any case", () => {
    expect(isExemptEmail("dev@example.com", domains)).toBe(true);
    expect(isExemptEmail("Dev@EXAMPLE.COM", domains)).toBe(true);
    expect(isExemptEmail("dev@example.org", domains)).toBe(true);
  });

  it("refuses look-alike domains, subdomains, quoted local parts and missing emails", () => {
    for (const email of [
      "dev@evilexample.com", "dev@example.com.evil.net", "dev@x.example.com", "\"dev@example.com\"@evil.net",
      "dev@example.co", "example.com", "@example.com", "dev@", "", null,
    ]) {
      expect(isExemptEmail(email, domains), String(email)).toBe(false);
    }
    expect(isExemptEmail("dev@example.com", [])).toBe(false);
  });

  it("gives an exempt workspace full access whatever its Stripe status", () => {
    const seat = { model: "workspace" as const, cardVerifiedAt: null };
    expect(accessForAccount({ status: "none", exempt: true, ...seat })).toBe("full");
    expect(accessForAccount({ status: "canceled", exempt: true, ...seat })).toBe("full");
    expect(accessForAccount({ status: "none", exempt: false, ...seat })).toBe("blocked");
    expect(accessForAccount({ status: "past_due", exempt: false, ...seat })).toBe("grace");
  });

  it("per-project model: a validated card with nothing billed is full access; the standing decides the rest (decision 041)", () => {
    const card = new Date();
    const project = (status: BillingStatus, cardVerifiedAt: Date | null = card) => accessForAccount({ status, exempt: false, model: "project", cardVerifiedAt });
    expect(Object.fromEntries(ALL.map((s) => [s, project(s)]))).toEqual({
      none: "full", incomplete: "grace", incomplete_expired: "blocked", trialing: "full", active: "full",
      past_due: "grace", canceled: "blocked", unpaid: "blocked", paused: "blocked",
    });
    expect(project("none", null)).toBe("blocked");
    expect(accessForAccount({ status: "canceled", exempt: true, model: "project", cardVerifiedAt: null })).toBe("full");
  });
});

describe("payingAccount (decisions 037 and 041)", () => {
  it("seat model: counts active, past_due and a staff exemption as paying, and nothing else", () => {
    const seat = (status: BillingStatus, exempt = false) => payingAccount({ status, exempt, model: "workspace", projectStatuses: [] });
    expect(ALL.filter((status) => seat(status))).toEqual(["active", "past_due"]);
    expect(ALL.every((status) => seat(status, true))).toBe(true);
    // A seat workspace ignores project subscriptions (none exist until the conversion).
    expect(payingAccount({ status: "trialing", exempt: false, model: "workspace", projectStatuses: ["active"] })).toBe(false);
  });

  it("per-project model: pays while any project subscription is active or past_due, whatever the standing", () => {
    const project = (projectStatuses: BillingStatus[], status: BillingStatus = "none") => payingAccount({ status, exempt: false, model: "project", projectStatuses });
    for (const s of ALL) expect([s, project([s])]).toEqual([s, s === "active" || s === "past_due"]);
    // A removed project's subscription runs out its paid period: still paying.
    expect(project(["canceled", "active"])).toBe(true);
    expect(project(["trialing", "canceled"])).toBe(false);
    expect(project([])).toBe(false);
    // The standing is not a Stripe status in this model: "active" there alone does not count.
    expect(project([], "active")).toBe(false);
    expect(payingAccount({ status: "none", exempt: true, model: "project", projectStatuses: [] })).toBe(true);
  });
});
