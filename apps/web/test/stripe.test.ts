import Stripe from "stripe";
import { describe, expect, it } from "vitest";
import { checkCard } from "@supahound/core/billing/policy";
import { billingEventFromStripe, invoiceFromStripe, projectSubFromStripe, sessionFromStripe, subscriptionFromStripe, termsText } from "@supahound/core/billing/stripeMap";
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
    metadata: over.meta ?? { tenant_id: TENANT, purpose: "card_verification" },
    payment_intent: { id: "pi_1", status: over.piStatus ?? "requires_capture", payment_method: "pm_1", latest_charge: charge },
  };
}

const verdict = (s: Record<string, unknown>) => checkCard(sessionFromStripe(s).hold!);

describe("sessionFromStripe", () => {
  it("reads an approved card hold", () => {
    const s = sessionFromStripe(session());
    expect(s).toMatchObject({ id: "cs_test_1", status: "complete", tenant: TENANT, customerId: "cus_1" });
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
  const PRICES = { starter: "price_starter", pro: "price_pro" };
  const sub = {
    id: "sub_1", customer: "cus_1", status: "trialing", trial_end: 1_800_000_000, cancel_at_period_end: false,
    metadata: { tenant_id: TENANT, card_verified_at: "2026-11-10T12:00:00.000Z" },
    items: { data: [
      { id: "si_1", quantity: 3, current_period_end: 1_800_000_000, price: { id: "price_starter" } },
      { id: "si_2", quantity: 1, current_period_end: 1_800_000_000, price: { id: "price_pro" } },
      { id: "si_3", quantity: 9, price: { id: "price_someone_elses" } },
    ] },
  };

  it("reads status, seats per tier, dates, tenant and the verification time", () => {
    expect(subscriptionFromStripe(sub, PRICES)).toEqual({
      id: "sub_1", customerId: "cus_1", status: "trialing", seats: { starter: 3, pro: 1 },
      trialEnd: new Date(1_800_000_000_000), currentPeriodEnd: new Date(1_800_000_000_000), cancelAtPeriodEnd: false,
      tenant: TENANT, cardVerifiedAt: new Date("2026-11-10T12:00:00.000Z"),
      projectId: null, supabaseRef: null, tier: null, converted: false, defaultPaymentMethod: null, hasDiscount: false,
    });
  });

  // Decision 041: one subscription per project, one item at the project's tier.
  const project = {
    id: "sub_p1", customer: "cus_1", status: "active", trial_end: null, cancel_at_period_end: true, default_payment_method: "pm_1",
    metadata: { tenant_id: TENANT, project_id: "11111111-2222-4333-8444-555555555555", supabase_ref: "abcdefghijklmnopqrst" },
    items: { data: [{ id: "si_p", quantity: 1, current_period_end: 1_800_000_000, price: { id: "price_pro" } }] },
  };

  it("reads a project subscription's project, ref and tier, and maps it to a stored row", () => {
    const s = subscriptionFromStripe(project, PRICES);
    expect([s.projectId, s.supabaseRef, s.tier, s.cancelAtPeriodEnd, s.defaultPaymentMethod]).toEqual([
      "11111111-2222-4333-8444-555555555555", "abcdefghijklmnopqrst", "pro", true, "pm_1",
    ]);
    expect(projectSubFromStripe(s)).toEqual({
      subscriptionId: "sub_p1", projectId: "11111111-2222-4333-8444-555555555555", supabaseRef: "abcdefghijklmnopqrst", tier: "pro",
      status: "active", trialEnd: null, currentPeriodEnd: new Date(1_800_000_000_000), cancelAtPeriodEnd: true,
    });
  });

  it("fails closed on a project subscription at an unknown price or with a bad ref: no row", () => {
    const unknown = { ...project, items: { data: [{ id: "si_x", quantity: 1, price: { id: "price_someone_elses" } }] } };
    expect(projectSubFromStripe(subscriptionFromStripe(unknown, PRICES))).toBeNull();
    const badRef = { ...project, metadata: { ...project.metadata, supabase_ref: "../../etc" } };
    expect(projectSubFromStripe(subscriptionFromStripe(badRef, PRICES))).toBeNull();
    expect(projectSubFromStripe(subscriptionFromStripe(sub, PRICES))).toBeNull();
  });

  it("treats a status it does not know as canceled, which closes the gate", () => {
    expect(subscriptionFromStripe({ ...sub, status: "something_new" }, PRICES).status).toBe("canceled");
  });

  it("reads the conversion mark on a seat subscription", () => {
    expect(subscriptionFromStripe({ ...sub, metadata: { ...sub.metadata, converted: "yes" } }, PRICES).converted).toBe(true);
  });

  it("sees a discount on the subscription or an item, not on the customer", () => {
    expect(subscriptionFromStripe({ ...sub, discounts: ["di_1"] }, PRICES).hasDiscount).toBe(true);
    expect(subscriptionFromStripe({ ...sub, discounts: [] }, PRICES).hasDiscount).toBe(false);
    const itemDiscount = { ...sub, items: { data: [{ ...sub.items.data[0]!, discounts: ["di_2"] }] } };
    expect(subscriptionFromStripe(itemDiscount, PRICES).hasDiscount).toBe(true);
    expect(subscriptionFromStripe({ ...sub, customer: { id: "cus_1", discount: { id: "di_3" } } }, PRICES).hasDiscount).toBe(false);
  });
});

describe("invoiceFromStripe", () => {
  it("keeps only https links from Stripe", () => {
    const i = { id: "in_1", number: "A-1", created: 1_800_000_000, total: 1999, currency: "usd", status: "paid", hosted_invoice_url: "https://invoice.stripe.com/i/x" };
    expect(invoiceFromStripe(i)).toEqual({
      id: "in_1", number: "A-1", created: new Date(1_800_000_000_000), totalCents: 1999, currency: "usd", status: "paid", hostedUrl: "https://invoice.stripe.com/i/x",
    });
    expect(invoiceFromStripe({ ...i, hosted_invoice_url: "javascript:alert(1)" }).hostedUrl).toBeNull();
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

  it("maps a project subscription's events and invoices to its tenant and subscription (decision 041)", () => {
    const meta = { tenant_id: TENANT, project_id: "11111111-2222-4333-8444-555555555555" };
    for (const type of ["customer.subscription.created", "customer.subscription.updated", "customer.subscription.deleted", "customer.subscription.trial_will_end"]) {
      expect(billingEventFromStripe(event(type, { id: "sub_p1", metadata: meta }))).toMatchObject({ type, tenant: TENANT, subscriptionId: "sub_p1" });
    }
    for (const type of ["invoice.paid", "invoice.payment_failed", "invoice.payment_action_required"]) {
      const invoice = { id: "in_p", parent: { subscription_details: { subscription: "sub_p1", metadata: meta } } };
      expect(billingEventFromStripe(event(type, invoice))).toMatchObject({ type, tenant: TENANT, subscriptionId: "sub_p1" });
    }
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
  it("states the hold, the trial, both prices, the thresholds, the per-project rules and how to cancel", () => {
    const t = termsText();
    for (const part of ["$1 hold", "release it at once", "7 days", "$19.99", "$99", "1 million", "10 million", "Enterprise",
      "its own monthly subscription", "billed from the day you add it", "end of its paid month", "next monthly charge", "pay nothing"]) expect(t).toContain(part);
    // Decision 041: no minimum charge for a workspace with no project.
    expect(t).not.toContain("at least one project");
    expect(termsText(false)).toContain("A project is billed from the day you add it");
  });
});
