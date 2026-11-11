import { describe, expect, it } from "vitest";
import {
  accessFor, checkCard, needsEnterprise, POLLABLE_STATUSES, seatsFor, tierFor, type BillingStatus,
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
