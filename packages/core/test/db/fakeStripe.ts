import type { StripeGateway, VerificationSession } from "../../src/billing/flow.js";
import type { Seats, Tier } from "../../src/billing/policy.js";
import type { InvoiceSummary, StripeSubscription } from "../../src/billing/stripeMap.js";
import type { TenantId } from "../../src/tenancy/scope.js";

// A Stripe stand-in for the Postgres suites (decisions 028 and 041). It records every call and,
// like Stripe, returns the first result for a repeated idempotency key. Seat subscriptions are
// seeded with seedSeatSubscription (the code no longer creates them); project subscriptions are
// created through the gateway.

export type Card = { approved: boolean; cvc: string | null; funding: string | null };
export const GOOD: Card = { approved: true, cvc: "pass", funding: "credit" };

export type FakeSub = StripeSubscription & { anchor: Date | null; createKey: string | null };

export class FakeStripe implements StripeGateway {
  customers: { id: string; tenant: string; key: string; defaultPaymentMethod: string | null }[] = [];
  sessions = new Map<string, VerificationSession>();
  subscriptions = new Map<string, FakeSub>();
  // Every write, in order: what a dry run must leave empty.
  writes: { kind: string; id: string; detail?: unknown }[] = [];
  creates: { key: string; projectId: string; tier: Tier; trialEnd: Date | null; anchor: Date | null }[] = [];
  seatUpdates: { id: string; seats: Seats; prorate: boolean }[] = [];
  // Set to make the next call of that kind throw (a Stripe outage).
  failNext = new Set<string>();
  private byKey = new Map<string, unknown>();
  private n = 0;
  private id = (p: string) => `${p}_${(++this.n).toString().padStart(6, "0")}`;

  constructor(private readonly clock: () => Date = () => new Date()) {}

  private maybeFail(kind: string) {
    if (this.failNext.delete(kind)) throw new Error(`fake stripe: ${kind} failed`);
  }

  private remember<T>(key: string | undefined, make: () => T): T {
    if (key && this.byKey.has(key)) return this.byKey.get(key) as T;
    const v = make();
    if (key) this.byKey.set(key, v);
    return v;
  }

  async createCustomer(i: { tenant: TenantId; email?: string | null; idempotencyKey: string }) {
    const old = this.customers.find((c) => c.key === i.idempotencyKey);
    if (old) return { id: old.id };
    const c = { id: this.id("cus"), tenant: i.tenant, key: i.idempotencyKey, defaultPaymentMethod: null };
    this.customers.push(c);
    this.writes.push({ kind: "customer", id: c.id });
    return { id: c.id };
  }
  async createVerificationCheckout(i: { tenant: TenantId; customerId: string; trial: boolean }) {
    const id = this.id("cs");
    this.sessions.set(id, { id, status: "open", tenant: i.tenant, customerId: i.customerId, trialAllowed: i.trial, hold: null });
    return { id, url: `https://checkout.stripe.test/${id}` };
  }
  // What Stripe does when the customer pays on the Checkout page.
  pay(sessionId: string, card: Card) {
    const s = this.sessions.get(sessionId)!;
    s.status = "complete";
    s.hold = {
      paymentIntentId: this.id("pi"), releasable: card.approved, paymentMethodId: card.approved ? this.id("pm") : null,
      approvedByIssuer: card.approved, captured: false, cvcCheck: card.cvc, funding: card.funding,
    };
  }
  async getVerificationSession(id: string) {
    const s = this.sessions.get(id);
    if (!s) throw new Error("no such session");
    return structuredClone(s);
  }
  async releaseHold(pi: string) {
    for (const s of this.sessions.values()) if (s.hold?.paymentIntentId === pi) s.hold.releasable = false;
  }
  async liveSubscription(customerId: string) {
    const s = [...this.subscriptions.values()].find((x) => x.customerId === customerId && !x.projectId && !["canceled", "incomplete_expired"].includes(x.status));
    return s ? { ...s } : null;
  }
  async getSubscription(id: string) {
    const s = this.subscriptions.get(id);
    if (!s) throw new Error("no such subscription");
    return { ...s };
  }
  async setSeats(id: string, seats: Seats, prorate: boolean) {
    this.maybeFail("seats");
    this.seatUpdates.push({ id, seats: { ...seats }, prorate });
    this.writes.push({ kind: "seats", id });
    this.subscriptions.get(id)!.seats = { ...seats };
  }
  async portalUrl() {
    return "https://billing.stripe.test/portal";
  }
  async setCancelAtPeriodEnd(id: string, cancel: boolean, options?: { converted?: boolean; idempotencyKey?: string }) {
    this.maybeFail("cancel");
    const s = this.subscriptions.get(id);
    if (!s) throw new Error("no such subscription");
    s.cancelAtPeriodEnd = cancel;
    if (options?.converted) s.converted = true;
    this.writes.push({ kind: cancel ? "cancel" : "resume", id });
    return { ...s };
  }
  async setInvoicePaymentMethod(customerId: string, paymentMethodId: string) {
    const c = this.customers.find((x) => x.id === customerId);
    if (!c) throw new Error("no such customer");
    c.defaultPaymentMethod = paymentMethodId;
    this.writes.push({ kind: "default_pm", id: customerId });
  }
  async createProjectSubscription(i: {
    tenant: TenantId; projectId: string; supabaseRef: string; customerId: string; tier: Tier;
    trialEnd: Date | null; anchor: Date | null; idempotencyKey: string;
  }) {
    this.maybeFail("create");
    const sub = this.remember(`create:${i.idempotencyKey}`, () => {
      this.creates.push({ key: i.idempotencyKey, projectId: i.projectId, tier: i.tier, trialEnd: i.trialEnd, anchor: i.anchor });
      const now = this.clock();
      const s: FakeSub = {
        id: this.id("sub"), customerId: i.customerId, status: i.trialEnd ? "trialing" : "active",
        seats: { starter: i.tier === "starter" ? 1 : 0, pro: i.tier === "pro" ? 1 : 0 },
        trialEnd: i.trialEnd, currentPeriodEnd: i.trialEnd ?? i.anchor ?? new Date(now.getTime() + 30 * 86_400_000),
        cancelAtPeriodEnd: false, tenant: i.tenant, cardVerifiedAt: null, projectId: i.projectId, supabaseRef: i.supabaseRef,
        tier: i.tier, converted: false, defaultPaymentMethod: null, anchor: i.anchor, createKey: i.idempotencyKey,
      };
      this.subscriptions.set(s.id, s);
      this.writes.push({ kind: "create", id: s.id });
      return s;
    });
    return { ...sub };
  }
  async customerSubscriptions(customerId: string) {
    return [...this.subscriptions.values()].filter((s) => s.customerId === customerId).map((s) => ({ ...s }));
  }
  async setProjectTier(id: string, tier: Tier) {
    this.maybeFail("tier");
    const s = this.subscriptions.get(id);
    if (!s) throw new Error("no such subscription");
    s.tier = tier;
    s.seats = { starter: tier === "starter" ? 1 : 0, pro: tier === "pro" ? 1 : 0 };
    this.writes.push({ kind: "tier", id, detail: tier });
    return { ...s };
  }
  async invoices(): Promise<InvoiceSummary[]> {
    return [];
  }

  // A seat subscription as the code before decision 041 created it.
  seedSeatSubscription(i: { tenant: TenantId; customerId: string; seats: Seats; trial: boolean; periodEnd: Date; paymentMethod?: string }): FakeSub {
    const s: FakeSub = {
      id: this.id("sub"), customerId: i.customerId, status: i.trial ? "trialing" : "active", seats: { ...i.seats },
      trialEnd: i.trial ? i.periodEnd : null, currentPeriodEnd: i.periodEnd, cancelAtPeriodEnd: false, tenant: i.tenant,
      cardVerifiedAt: new Date(), projectId: null, supabaseRef: null, tier: null, converted: false,
      defaultPaymentMethod: i.paymentMethod ?? this.id("pm"), anchor: null, createKey: null,
    };
    this.subscriptions.set(s.id, s);
    return s;
  }

  // Stripe changes a subscription on its own (a renewal, a failed payment, the period end).
  set(id: string, change: Partial<FakeSub>) {
    Object.assign(this.subscriptions.get(id)!, change);
  }

  projectSubs(tenant: string): FakeSub[] {
    return [...this.subscriptions.values()].filter((s) => s.tenant === tenant && s.projectId);
  }
}
