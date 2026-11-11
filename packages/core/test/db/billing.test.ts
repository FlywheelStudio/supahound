import { randomUUID } from "node:crypto";
import { beforeAll, describe, expect, it } from "vitest";
import {
  completeVerification, handleBillingEvent, refreshSubscription, startCheckout, syncSeats,
  type FlowDeps, type StripeGateway, type VerificationSession,
} from "../../src/billing/flow.js";
import type { Plan } from "../../src/billing/policy.js";
import { getBilling, PaymentRequiredError, saveSubscription, withPaidTenantForUser, type SubscriptionSnapshot } from "../../src/db/billing.js";
import * as repo from "../../src/db/repo.js";
import { withTenant } from "../../src/db/tenant.js";
import { createWorkspace, NotAMemberError, withTenantForUser } from "../../src/db/user.js";
import { verifiedUserId, type TenantId, type UserId } from "../../src/tenancy/scope.js";
import { pgInfo, useDb } from "./harness.js";

// Billing with a validated card (decision 028) against real Postgres with forced RLS. Stripe is a
// fake that records every call, so the tests can count customers, holds and subscriptions.

type Card = { approved: boolean; cvc: string | null; funding: string | null };
const GOOD: Card = { approved: true, cvc: "pass", funding: "credit" };

class FakeStripe implements StripeGateway {
  customers: { id: string; tenant: string; key: string }[] = [];
  sessions = new Map<string, VerificationSession>();
  released: string[] = [];
  subscriptions = new Map<string, SubscriptionSnapshot & { tenant: string; cardVerifiedAt: Date | null }>();
  creates: { key: string; seats: number; plan: Plan }[] = [];
  seatUpdates: { id: string; seats: number }[] = [];
  private byKey = new Map<string, string>();
  private n = 0;
  private id = (p: string) => `${p}_${(++this.n).toString().padStart(6, "0")}`;

  async createCustomer(i: { tenant: TenantId; idempotencyKey: string }) {
    const old = this.customers.find((c) => c.key === i.idempotencyKey);
    if (old) return { id: old.id };
    const c = { id: this.id("cus"), tenant: i.tenant, key: i.idempotencyKey };
    this.customers.push(c);
    return { id: c.id };
  }
  async createVerificationCheckout(i: { tenant: TenantId; customerId: string; plan: Plan }) {
    const id = this.id("cs");
    this.sessions.set(id, { id, status: "open", tenant: i.tenant, plan: i.plan, customerId: i.customerId, hold: null });
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
    this.released.push(pi);
    for (const s of this.sessions.values()) if (s.hold?.paymentIntentId === pi) s.hold.releasable = false;
  }
  async liveSubscription(customerId: string) {
    return [...this.subscriptions.values()].find((s) => s.customerId === customerId && s.status !== "canceled") ?? null;
  }
  async createTrialSubscription(i: { tenant: TenantId; customerId: string; plan: Plan; seats: number; paymentMethodId: string; cardVerifiedAt: Date; idempotencyKey: string }) {
    this.creates.push({ key: i.idempotencyKey, seats: i.seats, plan: i.plan });
    // Like Stripe: the same idempotency key returns the first result.
    const replay = this.byKey.get(i.idempotencyKey);
    if (replay) return { ...this.subscriptions.get(replay)! };
    const sub = {
      id: this.id("sub"), customerId: i.customerId, plan: i.plan, status: "trialing" as const, seats: i.seats,
      trialEnd: new Date(Date.now() + 7 * 86_400_000), currentPeriodEnd: null, cancelAtPeriodEnd: false,
      tenant: i.tenant, cardVerifiedAt: i.cardVerifiedAt,
    };
    this.subscriptions.set(sub.id, sub);
    this.byKey.set(i.idempotencyKey, sub.id);
    return { ...sub };
  }
  async getSubscription(id: string) {
    const s = this.subscriptions.get(id);
    if (!s) throw new Error("no such subscription");
    return { ...s };
  }
  async setSeats(id: string, seats: number) {
    this.seatUpdates.push({ id, seats });
    this.subscriptions.get(id)!.seats = seats;
  }
  async portalUrl() {
    return "https://billing.stripe.test/portal";
  }
}

describe.skipIf(pgInfo === null)("billing with a validated card", () => {
  const db = useDb();
  let stripe: FakeStripe;
  let deps: FlowDeps;
  const owner = verifiedUserId(randomUUID());
  const member = verifiedUserId(randomUUID());
  const stranger = verifiedUserId(randomUUID());

  beforeAll(() => {
    stripe = new FakeStripe();
    deps = { pool: db.app, stripe, appUrl: "https://app.supahound.test", now: () => new Date() };
  });

  async function workspace(name: string, user: UserId = owner): Promise<TenantId> {
    return createWorkspace(db.app, user, name);
  }

  async function checkout(tenant: TenantId, plan: Plan = "builder"): Promise<string> {
    const url = await startCheckout(deps, { user: owner, email: "owner@example.com", tenant, plan, acceptedTerms: true });
    return url.split("/").at(-1)!;
  }

  async function paidWorkspace(name: string, plan: Plan = "builder"): Promise<TenantId> {
    const t = await workspace(name);
    const session = await checkout(t, plan);
    stripe.pay(session, GOOD);
    expect((await completeVerification(deps, session, t)).result).toBe("subscribed");
    return t;
  }

  describe("the gate", () => {
    it("blocks a workspace with no subscription before the callback runs", async () => {
      const t = await workspace("Unpaid");
      let ran = false;
      await expect(withPaidTenantForUser(db.app, "stripe", owner, t, async () => { ran = true; })).rejects.toBeInstanceOf(PaymentRequiredError);
      expect(ran).toBe(false);
    });

    it("checks membership first: a stranger gets the same answer as for a missing workspace", async () => {
      const t = await workspace("Members only");
      await expect(withPaidTenantForUser(db.app, "stripe", stranger, t, async () => undefined)).rejects.toBeInstanceOf(NotAMemberError);
    });

    it.each([
      ["trialing", "full"], ["active", "full"], ["past_due", "grace"],
    ] as const)("lets %s in with %s access", async (status, access) => {
      const t = await paidWorkspace(`Paid ${status}`);
      await db.admin.query("UPDATE supahound.billing_accounts SET status = $2 WHERE tenant_id = $1", [t, status]);
      expect(await withPaidTenantForUser(db.app, "stripe", owner, t, async (_tx, _role, a) => a)).toBe(access);
    });

    it.each(["canceled", "unpaid", "incomplete", "incomplete_expired", "paused"])("blocks %s", async (status) => {
      const t = await paidWorkspace(`Lapsed ${status}`);
      await db.admin.query("UPDATE supahound.billing_accounts SET status = $2 WHERE tenant_id = $1", [t, status]);
      await expect(withPaidTenantForUser(db.app, "stripe", owner, t, async () => undefined)).rejects.toBeInstanceOf(PaymentRequiredError);
    });

    it("is off for self-hosting without billing", async () => {
      const t = await workspace("Self-hosted");
      expect(await withPaidTenantForUser(db.app, "off", owner, t, async (_tx, _role, a) => a)).toBe("full");
    });
  });

  describe("the scheduler", () => {
    it("polls only tenants whose subscription allows it, and all of them with billing off", async () => {
      const paid = await paidWorkspace("Polled");
      const unpaid = await workspace("Not polled");
      const lapsed = await paidWorkspace("Lapsed polled");
      await db.admin.query("UPDATE supahound.billing_accounts SET status = 'canceled' WHERE tenant_id = $1", [lapsed]);
      for (const t of [paid, unpaid, lapsed]) {
        await withTenant(db.app, t, async (tx) => {
          const conn = await repo.createConnection(tx, db.vault, { label: "org", token: "tok" });
          await repo.createProject(tx, { connectionId: conn, supabaseRef: "abcdefghijklmnopqrst", name: "app" });
        });
      }
      const due = (await repo.dueProjects(db.scheduler, 60, 1000, "stripe")).map((s) => s.tenantId);
      expect(due).toContain(paid);
      expect(due).not.toContain(unpaid);
      expect(due).not.toContain(lapsed);
      const all = (await repo.dueProjects(db.scheduler, 60, 1000, "off")).map((s) => s.tenantId);
      expect(all).toEqual(expect.arrayContaining([paid, unpaid, lapsed]));
    });
  });

  describe("checkout", () => {
    it("sends an owner who accepted the terms to Stripe, and records the plan and terms", async () => {
      const t = await workspace("Checkout");
      const url = await startCheckout(deps, { user: owner, email: null, tenant: t, plan: "agency", acceptedTerms: true });
      expect(url).toMatch(/^https:\/\/checkout\.stripe\.test\/cs_/);
      const b = await withTenant(db.app, t, getBilling);
      expect([b.plan, b.status, b.termsVersion !== null, b.termsAcceptedAt !== null, b.customerId?.startsWith("cus_")]).toEqual([
        "agency", "none", true, true, true,
      ]);
    });

    it("makes one Stripe customer per workspace, however often the owner clicks", async () => {
      const t = await workspace("Double click");
      await checkout(t);
      await checkout(t);
      expect(stripe.customers.filter((c) => c.tenant === t)).toHaveLength(1);
    });

    it("refuses without the terms, and refuses members", async () => {
      const t = await workspace("Rules");
      await withTenantForUser(db.app, owner, t, (tx) =>
        tx.query("INSERT INTO supahound.memberships (tenant_id, user_id, role) VALUES ($1, $2, 'member')", [t, member]),
      );
      expect(await startCheckout(deps, { user: owner, email: null, tenant: t, plan: "builder", acceptedTerms: false })).toBe(`/w/${t}/billing?error=terms`);
      expect(await startCheckout(deps, { user: member, email: null, tenant: t, plan: "builder", acceptedTerms: true })).toBe(`/w/${t}/billing?error=role`);
      await expect(startCheckout(deps, { user: stranger, email: null, tenant: t, plan: "builder", acceptedTerms: true })).rejects.toBeInstanceOf(NotAMemberError);
      expect(stripe.customers.filter((c) => c.tenant === t)).toHaveLength(0);
    });

    it("sends a workspace that already pays straight back to it", async () => {
      const t = await paidWorkspace("Already paid");
      expect(await startCheckout(deps, { user: owner, email: null, tenant: t, plan: "builder", acceptedTerms: true })).toBe(`/w/${t}`);
    });
  });

  describe("the card check", () => {
    it("starts a 7-day trial on a validated card, at 1 seat for Builder and 10 for Agency, and releases the hold", async () => {
      const builder = await paidWorkspace("Builder trial", "builder");
      const agency = await paidWorkspace("Agency trial", "agency");
      for (const [t, seats] of [[builder, 1], [agency, 10]] as const) {
        const b = await withTenant(db.app, t, getBilling);
        expect([b.status, b.seats, b.cardVerifiedAt !== null, b.verificationError]).toEqual(["trialing", seats, true, null]);
      }
      const sessions = [...stripe.sessions.values()].filter((s) => s.tenant === builder || s.tenant === agency);
      expect(sessions.every((s) => s.hold && !s.hold.releasable)).toBe(true);
    });

    it.each([
      ["a declined hold", { approved: false, cvc: null, funding: "credit" }, "not_authorized"],
      ["a failed CVC", { approved: true, cvc: "fail", funding: "credit" }, "cvc_failed"],
      ["a prepaid card", { approved: true, cvc: "pass", funding: "prepaid" }, "prepaid"],
    ] as const)("refuses %s, releases any hold, and starts no subscription", async (_name, card, reason) => {
      const t = await workspace(`Refused ${reason}`);
      const session = await checkout(t);
      stripe.pay(session, card);
      expect((await completeVerification(deps, session, t)).result).toBe(reason);
      const b = await withTenant(db.app, t, getBilling);
      expect([b.status, b.subscriptionId, b.verificationError]).toEqual(["none", null, reason]);
      expect(stripe.sessions.get(session)!.hold!.releasable).toBe(false);
      await expect(withPaidTenantForUser(db.app, "stripe", owner, t, async () => undefined)).rejects.toBeInstanceOf(PaymentRequiredError);
    });

    it("accepts a CVC the issuer did not check", async () => {
      const t = await workspace("CVC unavailable");
      const session = await checkout(t);
      stripe.pay(session, { approved: true, cvc: "unavailable", funding: "debit" });
      expect((await completeVerification(deps, session, t)).result).toBe("subscribed");
    });

    it("gives the same result when the webhook and the return URL both finish the session", async () => {
      const t = await workspace("Race");
      const session = await checkout(t);
      stripe.pay(session, GOOD);
      const results = await Promise.all([completeVerification(deps, session, t), completeVerification(deps, session, null)]);
      expect(results.map((r) => r.result)).toEqual(["subscribed", "subscribed"]);
      // A third run, after the hold is gone, still sees the issuer's approval on the charge.
      expect((await completeVerification(deps, session, t)).result).toBe("subscribed");
      const live = [...stripe.subscriptions.values()].filter((s) => s.tenant === t);
      expect(live).toHaveLength(1);
      expect(stripe.creates.filter((c) => c.key === `trial-${session}`).length).toBeGreaterThanOrEqual(1);
      expect((await withTenant(db.app, t, getBilling)).status).toBe("trialing");
    });

    it("ignores a session that is still open, one for another workspace, and one whose customer is not this workspace's", async () => {
      const t = await workspace("Mismatch");
      const other = await workspace("Other");
      const open = await checkout(t);
      expect((await completeVerification(deps, open, t)).result).toBe("pending");
      stripe.pay(open, GOOD);
      expect((await completeVerification(deps, open, other)).result).toBe("ignored");
      // Forge the metadata: a session made for t's customer but claiming to be for `other`.
      stripe.sessions.get(open)!.tenant = other;
      expect((await completeVerification(deps, open, other)).result).toBe("ignored");
      expect((await withTenant(db.app, other, getBilling)).status).toBe("none");
    });
  });

  describe("webhooks", () => {
    it("processes an event once per tenant and skips the replay", async () => {
      const t = await workspace("Webhook");
      const session = await checkout(t);
      stripe.pay(session, GOOD);
      const event = { id: "evt_replay1", type: "checkout.session.completed", tenant: t, checkoutSessionId: session, subscriptionId: null };
      expect(await handleBillingEvent(deps, event)).toBe("processed");
      expect(await handleBillingEvent(deps, event)).toBe("duplicate");
      expect((await withTenant(db.app, t, getBilling)).status).toBe("trialing");
    });

    it("ignores events with no tenant or a tenant that does not own the subscription", async () => {
      const t = await paidWorkspace("Owner of sub");
      const other = await workspace("Not the owner");
      const sub = (await withTenant(db.app, t, getBilling)).subscriptionId!;
      expect(await handleBillingEvent(deps, { id: "evt_none1", type: "customer.subscription.updated", tenant: null, checkoutSessionId: null, subscriptionId: sub })).toBe("ignored");
      stripe.subscriptions.get(sub)!.tenant = other;
      expect(await handleBillingEvent(deps, { id: "evt_other1", type: "customer.subscription.updated", tenant: other, checkoutSessionId: null, subscriptionId: sub })).toBe("ignored");
      expect((await withTenant(db.app, other, getBilling)).subscriptionId).toBeNull();
    });

    it("copies a cancellation from Stripe, which closes the gate", async () => {
      const t = await paidWorkspace("Cancels");
      const sub = (await withTenant(db.app, t, getBilling)).subscriptionId!;
      stripe.subscriptions.get(sub)!.status = "canceled";
      expect(await handleBillingEvent(deps, { id: "evt_cancel1", type: "customer.subscription.deleted", tenant: t, checkoutSessionId: null, subscriptionId: sub })).toBe("processed");
      await expect(withPaidTenantForUser(db.app, "stripe", owner, t, async () => undefined)).rejects.toBeInstanceOf(PaymentRequiredError);
    });

    it("saves a subscription event that arrives before the checkout finishes saving", async () => {
      const t = await workspace("Early event");
      const session = await checkout(t);
      stripe.pay(session, GOOD);
      const customer = stripe.customers.find((c) => c.tenant === t)!.id;
      const sub = await stripe.createTrialSubscription({
        tenant: t, customerId: customer, plan: "builder", seats: 1, paymentMethodId: "pm_x", cardVerifiedAt: new Date(), idempotencyKey: "early",
      });
      expect(await refreshSubscription(deps, sub.id)).toBe(t);
      expect((await withTenant(db.app, t, getBilling)).status).toBe("trialing");
    });
  });

  describe("seats", () => {
    it("bills one seat per watched project above the plan minimum", async () => {
      const t = await paidWorkspace("Seats");
      const sub = (await withTenant(db.app, t, getBilling)).subscriptionId!;
      await syncSeats(deps, t); // 0 projects, Builder minimum 1: no change
      expect(stripe.seatUpdates.filter((u) => u.id === sub)).toEqual([]);
      await withTenant(db.app, t, async (tx) => {
        const conn = await repo.createConnection(tx, db.vault, { label: "org", token: "tok" });
        for (const [i, ref] of ["aaaaaaaaaaaaaaaaaaaa", "bbbbbbbbbbbbbbbbbbbb", "cccccccccccccccccccc"].entries()) {
          await repo.createProject(tx, { connectionId: conn, supabaseRef: ref, name: `app ${i}` });
        }
      });
      await syncSeats(deps, t);
      await syncSeats(deps, t); // already in step: no second call
      expect(stripe.seatUpdates.filter((u) => u.id === sub)).toEqual([{ id: sub, seats: 3 }]);
      expect((await withTenant(db.app, t, getBilling)).seats).toBe(3);
    });

    it("never touches Stripe for a workspace that has not paid", async () => {
      const t = await workspace("No seats");
      const before = stripe.seatUpdates.length;
      await syncSeats(deps, t);
      expect(stripe.seatUpdates.length).toBe(before);
      expect((await withTenant(db.app, t, getBilling)).seats).toBeNull();
    });
  });

  it("refuses a subscription row without a verified card (database CHECK)", async () => {
    const t = await workspace("Check constraint");
    await expect(
      withTenant(db.app, t, (tx) =>
        saveSubscription(tx, {
          id: "sub_nocard1", customerId: "cus_nocard1", plan: "builder", status: "active", seats: 1,
          trialEnd: null, currentPeriodEnd: null, cancelAtPeriodEnd: false,
        }, null),
      ),
    ).rejects.toThrow(/check constraint/);
  });
});
