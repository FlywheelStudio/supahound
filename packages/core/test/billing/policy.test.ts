import { describe, expect, it } from "vitest";
import { accessFor, checkCard, POLLABLE_STATUSES, seatsFor, type BillingStatus } from "../../src/billing/policy.js";

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

  it("bills Builder at least 1 seat and Agency at least 10", () => {
    expect([0, 1, 4].map((n) => seatsFor("builder", n))).toEqual([1, 1, 4]);
    expect([0, 9, 10, 25].map((n) => seatsFor("agency", n))).toEqual([10, 10, 10, 25]);
    expect(() => seatsFor("builder", -1)).toThrow();
    expect(() => seatsFor("builder", 1.5)).toThrow();
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
