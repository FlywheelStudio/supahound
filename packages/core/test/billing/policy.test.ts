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
    expect(accessForAccount({ status: "none", exempt: true })).toBe("full");
    expect(accessForAccount({ status: "canceled", exempt: true })).toBe("full");
    expect(accessForAccount({ status: "none", exempt: false })).toBe("blocked");
    expect(accessForAccount({ status: "past_due", exempt: false })).toBe("grace");
  });
});

describe("payingAccount (decision 037)", () => {
  it("counts active, past_due and a staff exemption as paying, and nothing else", () => {
    const all: BillingStatus[] = ["none", "incomplete", "incomplete_expired", "trialing", "active", "past_due", "canceled", "unpaid", "paused"];
    expect(all.filter((status) => payingAccount({ status, exempt: false }))).toEqual(["active", "past_due"]);
    expect(all.every((status) => payingAccount({ status, exempt: true }))).toBe(true);
  });
});
