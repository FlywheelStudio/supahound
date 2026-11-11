import Stripe from "stripe";
import { describe, expect, it } from "vitest";
import { checkCard } from "@supahound/core/billing/policy";
import { billingEventFromStripe, sessionFromStripe, subscriptionFromStripe, termsText } from "../lib/stripeMap";
import { verifyStripeEvent } from "../lib/stripeWebhook";

// Stripe objects → the billing flow's inputs (decision 028), and the webhook signature check.
// Fixtures follow Stripe's API shapes; only the fields the code reads are set.

const TENANT = "0b6c2f1e-3d4a-4e5b-8c6d-7e8f9a0b1c2d";

function session(over: { charge?: Record<string, unknown> | null; piStatus?: string; meta?: Record<string, string>; status?: string } = {}) {
  const charge = over.charge === undefined
    ? {
        id: "ch_1", status: "succeeded", captured: false, payment_method: "pm_1",
        outcome: { network_status: "approved_by_network", type: "authorized" },
        payment_method_details: { type: "card", card: { funding: "credit", checks: { cvc_check: "pass" } } },
      }
    : over.charge;
  return {
    id: "cs_test_1", object: "checkout.session", status: over.status ?? "complete", customer: "cus_1",
    metadata: over.meta ?? { tenant_id: TENANT, plan: "builder", purpose: "card_verification" },
    payment_intent: { id: "pi_1", status: over.piStatus ?? "requires_capture", payment_method: "pm_1", latest_charge: charge },
  };
}

const verdict = (s: Record<string, unknown>) => checkCard(sessionFromStripe(s).hold!);

describe("sessionFromStripe", () => {
  it("reads an approved card hold", () => {
    const s = sessionFromStripe(session());
    expect(s).toMatchObject({ id: "cs_test_1", status: "complete", tenant: TENANT, plan: "builder", customerId: "cus_1" });
    expect(s.hold).toEqual({
      paymentIntentId: "pi_1", releasable: true, paymentMethodId: "pm_1",
      approvedByIssuer: true, captured: false, cvcCheck: "pass", funding: "credit",
    });
    expect(verdict(session())).toEqual({ ok: true });
  });

  it("keeps the issuer's approval after the hold is released, so a retry reaches the same verdict", () => {
    const s = sessionFromStripe(session({ piStatus: "canceled" }));
    expect(s.hold?.releasable).toBe(false);
    expect(verdict(session({ piStatus: "canceled" }))).toEqual({ ok: true });
  });

  it("fails closed on a declined charge, a missing charge, a captured charge and a non-card method", () => {
    const declined = { status: "failed", captured: false, outcome: { network_status: "declined_by_network" }, payment_method_details: { type: "card", card: {} } };
    expect(verdict(session({ charge: declined }))).toEqual({ ok: false, reason: "not_authorized" });
    expect(verdict(session({ charge: null }))).toEqual({ ok: false, reason: "not_authorized" });
    const captured = { ...session().payment_intent.latest_charge!, captured: true };
    expect(verdict(session({ charge: captured }))).toEqual({ ok: false, reason: "not_authorized" });
    const notCard = { ...session().payment_intent.latest_charge!, payment_method_details: { type: "cashapp", cashapp: {} } };
    expect(verdict(session({ charge: notCard }))).toEqual({ ok: false, reason: "not_authorized" });
  });

  it("reads a failed CVC and a prepaid card", () => {
    const base = session().payment_intent.latest_charge!;
    const cvc = { ...base, payment_method_details: { type: "card", card: { funding: "credit", checks: { cvc_check: "fail" } } } };
    const prepaid = { ...base, payment_method_details: { type: "card", card: { funding: "prepaid", checks: { cvc_check: "pass" } } } };
    expect(verdict(session({ charge: cvc }))).toEqual({ ok: false, reason: "cvc_failed" });
    expect(verdict(session({ charge: prepaid }))).toEqual({ ok: false, reason: "prepaid" });
  });

  it("takes no tenant from a session that is not our card check", () => {
    expect(sessionFromStripe(session({ meta: { tenant_id: TENANT } })).tenant).toBeNull();
  });
});

describe("subscriptionFromStripe", () => {
  const sub = {
    id: "sub_1", customer: "cus_1", status: "trialing", trial_end: 1_800_000_000, cancel_at_period_end: false,
    metadata: { tenant_id: TENANT, plan: "agency", card_verified_at: "2026-11-10T12:00:00.000Z" },
    items: { data: [{ id: "si_1", quantity: 12, current_period_end: 1_800_000_000, price: { id: "price_agency" } }] },
  };

  it("reads status, seats, dates, tenant and the verification time", () => {
    expect(subscriptionFromStripe(sub, () => null)).toEqual({
      id: "sub_1", customerId: "cus_1", plan: "agency", status: "trialing", seats: 12,
      trialEnd: new Date(1_800_000_000_000), currentPeriodEnd: new Date(1_800_000_000_000), cancelAtPeriodEnd: false,
      tenant: TENANT, cardVerifiedAt: new Date("2026-11-10T12:00:00.000Z"),
    });
  });

  it("treats a status it does not know as canceled, which closes the gate", () => {
    expect(subscriptionFromStripe({ ...sub, status: "something_new" }, () => null).status).toBe("canceled");
  });
});

describe("billingEventFromStripe", () => {
  const event = (type: string, object: Record<string, unknown>) => ({ id: "evt_1", type, data: { object } });

  it("maps our checkout, subscription and invoice events to a tenant", () => {
    expect(billingEventFromStripe(event("checkout.session.completed", session()))).toEqual({
      id: "evt_1", type: "checkout.session.completed", tenant: TENANT, checkoutSessionId: "cs_test_1", subscriptionId: null,
    });
    expect(billingEventFromStripe(event("customer.subscription.updated", { id: "sub_1", metadata: { tenant_id: TENANT } }))).toMatchObject({
      tenant: TENANT, subscriptionId: "sub_1",
    });
    const invoice = { id: "in_1", parent: { type: "subscription_details", subscription_details: { subscription: "sub_1", metadata: { tenant_id: TENANT } } } };
    expect(billingEventFromStripe(event("invoice.payment_failed", invoice))).toMatchObject({ tenant: TENANT, subscriptionId: "sub_1" });
  });

  it("gives no tenant to other checkouts and other event types", () => {
    expect(billingEventFromStripe(event("checkout.session.completed", { id: "cs_2", metadata: { tenant_id: TENANT } })).tenant).toBeNull();
    expect(billingEventFromStripe(event("charge.refunded", { id: "ch_1", metadata: { tenant_id: TENANT } })).tenant).toBeNull();
  });
});

describe("verifyStripeEvent", () => {
  const stripe = new Stripe("sk_test_unused", { httpClient: Stripe.createFetchHttpClient() });
  const secret = "whsec_test_secret_for_unit_tests_only";
  const body = JSON.stringify({ id: "evt_sig1", type: "customer.subscription.updated", data: { object: { id: "sub_1", metadata: { tenant_id: TENANT } } } });
  const sign = (payload: string, key = secret, timestamp?: number) =>
    stripe.webhooks.generateTestHeaderStringAsync({ payload, secret: key, timestamp, cryptoProvider: Stripe.createSubtleCryptoProvider() });

  it("accepts Stripe's signature", async () => {
    expect(await verifyStripeEvent(stripe, body, await sign(body), secret)).toMatchObject({ id: "evt_sig1", tenant: TENANT });
  });

  it("rejects a wrong secret, a tampered body, a garbage header and a stale timestamp", async () => {
    await expect(verifyStripeEvent(stripe, body, await sign(body, "whsec_other"), secret)).rejects.toThrow();
    await expect(verifyStripeEvent(stripe, body.replace("sub_1", "sub_2"), await sign(body), secret)).rejects.toThrow();
    await expect(verifyStripeEvent(stripe, body, "t=1,v1=deadbeef", secret)).rejects.toThrow();
    const old = Math.floor(Date.now() / 1000) - 3600;
    await expect(verifyStripeEvent(stripe, body, await sign(body, secret, old), secret)).rejects.toThrow();
  });
});

describe("termsText", () => {
  it("states the hold, the trial, the price after it, the minimum and how to cancel", () => {
    for (const [plan, price, min] of [["builder", "$29", "1 project minimum"], ["agency", "$19", "10 projects minimum"]] as const) {
      const t = termsText(plan);
      for (const part of ["$1 hold", "release it at once", "7 days", price, min, "until you cancel", "pay nothing"]) expect(t, plan).toContain(part);
    }
  });
});
