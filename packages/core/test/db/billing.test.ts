import { randomUUID } from "node:crypto";
import { beforeAll, describe, expect, it } from "vitest";
import {
  applyUsageTiers, completeVerification, handleBillingEvent, reconcileProjects, refreshSubscription, startCheckout, syncSeats,
  type FlowDeps,
} from "../../src/billing/flow.js";
import { countDailyUsage, previousUtcDay } from "../../src/billing/usage.js";
import {
  getBilling, PaymentRequiredError, projectTiers, saveDailyUsage, saveSubscription, setStripeCustomer, withPaidTenantForUser,
} from "../../src/db/billing.js";
import * as repo from "../../src/db/repo.js";
import { withTenant } from "../../src/db/tenant.js";
import { createWorkspace, NotAMemberError, withTenantForUser } from "../../src/db/user.js";
import type { ProjectId, TenantId, UserId } from "../../src/tenancy/scope.js";
import { verifiedUserId } from "../../src/tenancy/scope.js";
import { FakeStripe, GOOD } from "./fakeStripe.js";
import { pgInfo, useDb } from "./harness.js";

// Billing with a validated card, priced per project by traffic (decision 028), against real
// Postgres with forced RLS. Stripe is a fake that records every call.

// The Stripe stand-in is shared with the per-project suites (fakeStripe.ts). Since decision 041 a
// card check starts the per-project model; seat workspaces (decision 028) are seeded as the code
// before it left them, and keep their own tests until the conversion CLI moves them.
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

  // `owner` adds the card in every workspace here. Decision 037 refuses a second trial to a user who
  // OWNS another workspace that had one, so each workspace gets its own creator-owner and `owner`
  // joins as admin (admins may add the card too). The per-owner rule has its own test below.
  async function workspace(name: string, user: UserId = owner): Promise<TenantId> {
    if (user !== owner) return createWorkspace(db.app, user, name);
    const t = await createWorkspace(db.app, verifiedUserId(randomUUID()), name);
    await db.admin.query("INSERT INTO supahound.memberships (tenant_id, user_id, role) VALUES ($1, $2, 'admin')", [t, owner]);
    return t;
  }

  async function checkout(tenant: TenantId): Promise<string> {
    const url = await startCheckout(deps, { user: owner, email: "owner@example.com", tenant, acceptedTerms: true });
    return url.split("/").at(-1)!;
  }

  async function paidWorkspace(name: string): Promise<TenantId> {
    const t = await workspace(name);
    const session = await checkout(t);
    stripe.pay(session, GOOD);
    expect((await completeVerification(deps, session, t)).result).toBe("subscribed");
    return t;
  }

  async function addProjects(t: TenantId, refs: string[]): Promise<ProjectId[]> {
    return withTenant(db.app, t, async (tx) => {
      const conn = await repo.createConnection(tx, db.vault, { label: "org", token: "tok" });
      const ids: ProjectId[] = [];
      for (const [i, ref] of refs.entries()) ids.push(await repo.createProject(tx, { connectionId: conn, supabaseRef: ref, name: `app ${i}` }));
      return ids;
    });
  }

  const subOf = async (t: TenantId) => (await withTenant(db.app, t, getBilling)).subscriptionId!;

  // A workspace on one seat subscription (decision 028), as the code before decision 041 left it.
  async function seatWorkspace(name: string, trial = true): Promise<TenantId> {
    const t = await workspace(name);
    const { id: customerId } = await stripe.createCustomer({ tenant: t, email: null, idempotencyKey: `customer-${t}` });
    const sub = stripe.seedSeatSubscription({ tenant: t, customerId, seats: { starter: 1, pro: 0 }, trial, periodEnd: new Date(Date.now() + 7 * 86_400_000) });
    await withTenant(db.app, t, async (tx) => {
      await setStripeCustomer(tx, customerId);
      await saveSubscription(tx, sub, new Date());
    });
    return t;
  }

  const projectSubsOf = (t: TenantId) => stripe.projectSubs(t);

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
    ] as const)("lets a seat workspace in with status %s and %s access", async (status, access) => {
      const t = await seatWorkspace(`Paid ${status}`);
      await db.admin.query("UPDATE supahound.billing_accounts SET status = $2 WHERE tenant_id = $1", [t, status]);
      expect(await withPaidTenantForUser(db.app, "stripe", owner, t, async (_tx, _role, a) => a)).toBe(access);
    });

    it.each(["canceled", "unpaid", "incomplete", "incomplete_expired", "paused"])("blocks a seat workspace with status %s", async (status) => {
      const t = await seatWorkspace(`Lapsed ${status}`);
      await db.admin.query("UPDATE supahound.billing_accounts SET status = $2 WHERE tenant_id = $1", [t, status]);
      await expect(withPaidTenantForUser(db.app, "stripe", owner, t, async () => undefined)).rejects.toBeInstanceOf(PaymentRequiredError);
    });

    it("is off for self-hosting without billing", async () => {
      const t = await workspace("Self-hosted");
      expect(await withPaidTenantForUser(db.app, "off", owner, t, async (_tx, _role, a) => a)).toBe("full");
    });
  });

  describe("the scheduler", () => {
    it("polls, and counts usage for, only tenants whose subscription allows it; all of them with billing off", async () => {
      const paid = await seatWorkspace("Polled");
      const unpaid = await workspace("Not polled");
      const lapsed = await seatWorkspace("Lapsed polled");
      await db.admin.query("UPDATE supahound.billing_accounts SET status = 'canceled' WHERE tenant_id = $1", [lapsed]);
      for (const t of [paid, unpaid, lapsed]) await addProjects(t, ["abcdefghijklmnopqrst"]);
      const due = (await repo.dueProjects(db.scheduler, 60, 1000, "stripe")).map((s) => s.tenantId);
      expect(due).toContain(paid);
      expect(due).not.toContain(unpaid);
      expect(due).not.toContain(lapsed);
      const all = (await repo.dueProjects(db.scheduler, 60, 1000, "off")).map((s) => s.tenantId);
      expect(all).toEqual(expect.arrayContaining([paid, unpaid, lapsed]));
      const billed = await repo.billedTenants(db.scheduler);
      expect(billed).toContain(paid);
      expect(billed).not.toContain(unpaid);
      expect(billed).not.toContain(lapsed);
    });
  });

  describe("checkout", () => {
    it("sends an owner who accepted the terms to Stripe, and records the terms", async () => {
      const t = await workspace("Checkout");
      const url = await startCheckout(deps, { user: owner, email: null, tenant: t, acceptedTerms: true });
      expect(url).toMatch(/^https:\/\/checkout\.stripe\.test\/cs_/);
      const b = await withTenant(db.app, t, getBilling);
      expect([b.status, b.termsVersion !== null, b.termsAcceptedAt !== null, b.customerId?.startsWith("cus_")]).toEqual(["none", true, true, true]);
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
      expect(await startCheckout(deps, { user: owner, email: null, tenant: t, acceptedTerms: false })).toBe(`/w/${t}/billing?error=terms`);
      expect(await startCheckout(deps, { user: member, email: null, tenant: t, acceptedTerms: true })).toBe(`/w/${t}/billing?error=role`);
      await expect(startCheckout(deps, { user: stranger, email: null, tenant: t, acceptedTerms: true })).rejects.toBeInstanceOf(NotAMemberError);
      expect(stripe.customers.filter((c) => c.tenant === t)).toHaveLength(0);
    });

    it("sends a workspace that already pays straight back to it", async () => {
      const t = await paidWorkspace("Already paid");
      expect(await startCheckout(deps, { user: owner, email: null, tenant: t, acceptedTerms: true })).toBe(`/w/${t}`);
    });
  });

  describe("the card check", () => {
    it("starts the workspace's 7-day trial on a validated card, creates no subscription, and releases the hold (decision 041)", async () => {
      const before = Date.now();
      const t = await paidWorkspace("Trial");
      const b = await withTenant(db.app, t, getBilling);
      expect([b.model, b.status, b.subscriptionId, b.seats, b.cardVerifiedAt !== null, b.verificationError]).toEqual(["project", "none", null, null, true, null]);
      expect(b.trialEnd!.getTime()).toBeGreaterThanOrEqual(before + 7 * 86_400_000 - 1000);
      expect(b.trialEnd!.getTime()).toBeLessThanOrEqual(Date.now() + 7 * 86_400_000);
      expect(projectSubsOf(t)).toEqual([]);
      const session = [...stripe.sessions.values()].find((x) => x.tenant === t)!;
      expect(session.hold!.releasable).toBe(false);
      // The card becomes the customer's default, so every project subscription bills it.
      expect(stripe.customers.find((c) => c.tenant === t)!.defaultPaymentMethod).toBe(session.hold!.paymentMethodId);
      // A validated card with no project to bill opens the workspace.
      expect(await withPaidTenantForUser(db.app, "stripe", owner, t, async (_tx, _role, a) => a)).toBe("full");
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

    it("starts no trial for a checkout begun before the workspace closed, and still releases the hold (decision 037)", async () => {
      const t = await workspace("Closed mid-checkout");
      const session = await checkout(t);
      await withTenant(db.app, t, (tx) => tx.query(
        "INSERT INTO supahound.account_closures (tenant_id, closed_at, closed_by, access_ends_at, purge_after) VALUES ($1, now(), $2, now(), now() + interval '30 days')",
        [t, owner],
      ));
      stripe.pay(session, GOOD);
      const creates = stripe.creates.length;
      expect((await completeVerification(deps, session, t)).result).toBe("ignored");
      expect(stripe.creates.length).toBe(creates);
      expect(stripe.sessions.get(session)!.hold!.releasable).toBe(false);
      expect((await withTenant(db.app, t, getBilling)).subscriptionId).toBeNull();
    });

    it("gives one free trial per workspace, ever: after a lapse, a second card bills its projects at once (decisions 037, 041)", async () => {
      const t = await paidWorkspace("Second card");
      await addProjects(t, ["secondcardaaaaaaaaaa"]);
      await reconcileProjects(deps, t);
      const [first] = projectSubsOf(t);
      expect(first!.status).toBe("trialing");
      // Stripe ends the subscription (say, the card failed at the trial end): the workspace is blocked.
      stripe.set(first!.id, { status: "canceled" });
      await refreshSubscription(deps, first!.id);
      await expect(withPaidTenantForUser(db.app, "stripe", owner, t, async () => undefined)).rejects.toBeInstanceOf(PaymentRequiredError);
      // The lapse comes after the trial (inside it, the new subscription would share what is left of it).
      await db.admin.query("UPDATE supahound.billing_accounts SET trial_end = now() - interval '1 day' WHERE tenant_id = $1", [t]);
      const trialEnd = (await withTenant(db.app, t, getBilling)).trialEnd;
      const session = await checkout(t);
      expect(stripe.sessions.get(session)!.trialAllowed).toBe(false);
      stripe.pay(session, GOOD);
      expect((await completeVerification(deps, session, t)).result).toBe("subscribed");
      const subs = projectSubsOf(t);
      expect(subs.map((x) => [x.status, x.trialEnd])).toEqual([["canceled", first!.trialEnd], ["active", null]]);
      const b = await withTenant(db.app, t, getBilling);
      expect([b.status, b.trialEnd]).toEqual(["active", trialEnd]);
    });

    it("gives one trial even when two checkouts start before either finishes (decision 037)", async () => {
      const t = await workspace("Two tabs");
      const first = await checkout(t);
      const second = await checkout(t);
      expect([stripe.sessions.get(first)!.trialAllowed, stripe.sessions.get(second)!.trialAllowed]).toEqual([true, true]);
      stripe.pay(first, GOOD);
      await completeVerification(deps, first, t);
      const trialEnd = (await withTenant(db.app, t, getBilling)).trialEnd;
      expect(trialEnd).not.toBeNull();
      // The second tab's checkout still says "trial"; the workspace keeps its first trial end.
      stripe.pay(second, GOOD);
      expect((await completeVerification(deps, second, t)).result).toBe("subscribed");
      expect((await withTenant(db.app, t, getBilling)).trialEnd).toEqual(trialEnd);
    });

    it("refuses a trial to a user who owns another workspace that had one, but not to a new owner (decision 037)", async () => {
      const repeat = verifiedUserId(randomUUID());
      const first = await createWorkspace(db.app, repeat, "First owned");
      const s1 = (await startCheckout(deps, { user: repeat, email: null, tenant: first, acceptedTerms: true })).split("/").at(-1)!;
      stripe.pay(s1, GOOD);
      await completeVerification(deps, s1, first);
      expect((await withTenant(db.app, first, getBilling)).trialEnd).not.toBeNull();

      const second = await createWorkspace(db.app, repeat, "Second owned");
      const s2 = (await startCheckout(deps, { user: repeat, email: null, tenant: second, acceptedTerms: true })).split("/").at(-1)!;
      expect(stripe.sessions.get(s2)!.trialAllowed).toBe(false);
      stripe.pay(s2, GOOD);
      await completeVerification(deps, s2, second);
      const b2 = await withTenant(db.app, second, getBilling);
      expect([b2.model, b2.trialEnd, b2.cardVerifiedAt !== null]).toEqual(["project", null, true]);
      // A user who never owned a trialed workspace still gets one, even as another workspace's admin.
      const fresh = verifiedUserId(randomUUID());
      const third = await createWorkspace(db.app, fresh, "Fresh owner");
      await db.admin.query("INSERT INTO supahound.memberships (tenant_id, user_id, role) VALUES ($1, $2, 'admin')", [first, fresh]);
      const s3 = (await startCheckout(deps, { user: fresh, email: null, tenant: third, acceptedTerms: true })).split("/").at(-1)!;
      expect(stripe.sessions.get(s3)!.trialAllowed).toBe(true);
    });

    it("keeps a live seat subscription found at the card check instead of starting the per-project model", async () => {
      const t = await workspace("Seat retry");
      const session = await checkout(t);
      stripe.pay(session, GOOD);
      const customer = stripe.customers.find((c) => c.tenant === t)!.id;
      stripe.seedSeatSubscription({ tenant: t, customerId: customer, seats: { starter: 1, pro: 0 }, trial: true, periodEnd: new Date(Date.now() + 86_400_000) });
      expect((await completeVerification(deps, session, t)).result).toBe("subscribed");
      const b = await withTenant(db.app, t, getBilling);
      expect([b.model, b.status, b.seats]).toEqual(["workspace", "trialing", { starter: 1, pro: 0 }]);
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
      expect([...stripe.subscriptions.values()].filter((s) => s.tenant === t)).toHaveLength(0);
      const b = await withTenant(db.app, t, getBilling);
      expect([b.model, b.status, b.trialEnd !== null]).toEqual(["project", "none", true]);
    });

    it("ignores a session that is still open, one for another workspace, and one whose customer is not this workspace's", async () => {
      const t = await workspace("Mismatch");
      const other = await workspace("Other");
      const open = await checkout(t);
      expect((await completeVerification(deps, open, t)).result).toBe("pending");
      stripe.pay(open, GOOD);
      expect((await completeVerification(deps, open, other)).result).toBe("ignored");
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
      expect((await withTenant(db.app, t, getBilling)).model).toBe("project");
    });

    it("ignores events with no tenant or a tenant that does not own the subscription", async () => {
      const t = await seatWorkspace("Owner of sub");
      const other = await workspace("Not the owner");
      const sub = await subOf(t);
      expect(await handleBillingEvent(deps, { id: "evt_none1", type: "customer.subscription.updated", tenant: null, checkoutSessionId: null, subscriptionId: sub })).toBe("ignored");
      stripe.subscriptions.get(sub)!.tenant = other;
      expect(await handleBillingEvent(deps, { id: "evt_other1", type: "customer.subscription.updated", tenant: other, checkoutSessionId: null, subscriptionId: sub })).toBe("ignored");
      expect((await withTenant(db.app, other, getBilling)).subscriptionId).toBeNull();
    });

    it("copies a seat subscription's cancellation from Stripe, which closes the gate", async () => {
      const t = await seatWorkspace("Cancels");
      const sub = await subOf(t);
      stripe.subscriptions.get(sub)!.status = "canceled";
      expect(await handleBillingEvent(deps, { id: "evt_cancel1", type: "customer.subscription.deleted", tenant: t, checkoutSessionId: null, subscriptionId: sub })).toBe("processed");
      await expect(withPaidTenantForUser(db.app, "stripe", owner, t, async () => undefined)).rejects.toBeInstanceOf(PaymentRequiredError);
    });

    it("saves a seat subscription event that arrives before the workspace row has it", async () => {
      const t = await workspace("Early event");
      const session = await checkout(t);
      stripe.pay(session, GOOD);
      const customer = stripe.customers.find((c) => c.tenant === t)!.id;
      const sub = stripe.seedSeatSubscription({ tenant: t, customerId: customer, seats: { starter: 1, pro: 0 }, trial: true, periodEnd: new Date(Date.now() + 86_400_000) });
      expect(await refreshSubscription(deps, sub.id)).toBe(t);
      expect((await withTenant(db.app, t, getBilling)).status).toBe("trialing");
    });
  });

  describe("seat model (decision 028), until the conversion CLI moves the workspace", () => {
    it("bills each added project at Starter right away, pro rata", async () => {
      const t = await seatWorkspace("Seats");
      const sub = await subOf(t);
      await syncSeats(deps, t, true); // no projects: the 1-seat minimum, already billed
      expect(stripe.seatUpdates.filter((u) => u.id === sub)).toEqual([]);
      await addProjects(t, ["aaaaaaaaaaaaaaaaaaaa", "bbbbbbbbbbbbbbbbbbbb", "cccccccccccccccccccc"]);
      await syncSeats(deps, t, true);
      await syncSeats(deps, t, true); // in step: no second call
      expect(stripe.seatUpdates.filter((u) => u.id === sub)).toEqual([{ id: sub, seats: { starter: 3, pro: 0 }, prorate: true }]);
      expect((await withTenant(db.app, t, getBilling)).seats).toEqual({ starter: 3, pro: 0 });
    });

    it("moves a project above 1 million requests in 30 days to Pro at the next renewal, and back down", async () => {
      const t = await seatWorkspace("Tiers");
      const sub = await subOf(t);
      const [busy, quiet] = await addProjects(t, ["dddddddddddddddddddd", "eeeeeeeeeeeeeeeeeeee"]);
      await syncSeats(deps, t, true);
      const today = "2026-11-10";
      // 30 days at 40,000 a day = 1.2 million for `busy`; 10,000 a day for `quiet`.
      await withTenant(db.app, t, async (tx) => {
        for (let d = 0; d < 30; d++) {
          const day = new Date(Date.UTC(2026, 10, 10 - d)).toISOString().slice(0, 10);
          await saveDailyUsage(tx, busy!, day, 40_000);
          await saveDailyUsage(tx, quiet!, day, 10_000);
        }
        // Older than the window: never counted.
        await saveDailyUsage(tx, quiet!, "2026-09-01", 50_000_000);
      });
      await applyUsageTiers(deps, t, today);
      const tiers = await withTenant(db.app, t, projectTiers);
      expect(tiers.map((x) => [x.id, x.tier, x.requests30d])).toEqual([[busy, "pro", 1_200_000], [quiet, "starter", 300_000]]);
      expect(stripe.seatUpdates.filter((u) => u.id === sub).at(-1)).toEqual({ id: sub, seats: { starter: 1, pro: 1 }, prorate: false });

      // A quiet month later, `busy` drops back to Starter, again from the next renewal.
      await withTenant(db.app, t, async (tx) => {
        for (let d = 0; d < 30; d++) {
          await saveDailyUsage(tx, busy!, new Date(Date.UTC(2026, 11, 10 - d)).toISOString().slice(0, 10), 1_000);
        }
      });
      await applyUsageTiers(deps, t, "2026-12-10");
      expect(stripe.seatUpdates.filter((u) => u.id === sub).at(-1)).toEqual({ id: sub, seats: { starter: 2, pro: 0 }, prorate: false });
    });

    it("never touches Stripe for a workspace that has not paid", async () => {
      const t = await workspace("No seats");
      await addProjects(t, ["ffffffffffffffffffff"]);
      const before = stripe.seatUpdates.length;
      await syncSeats(deps, t, true);
      await applyUsageTiers(deps, t, "2026-11-10");
      expect(stripe.seatUpdates.length).toBe(before);
      expect((await withTenant(db.app, t, getBilling)).seats).toBeNull();
    });
  });

  describe("the daily usage count", () => {
    it("counts yesterday's requests per project, audits each query, and skips a project whose count fails", async () => {
      const t = await paidWorkspace("Counting");
      const [ok, broken] = await addProjects(t, ["gggggggggggggggggggg", "hhhhhhhhhhhhhhhhhhhh"]);
      const now = new Date("2026-11-11T00:20:00Z");
      const windows: { ref: string; start: string; end: string }[] = [];
      const result = await countDailyUsage(t, {
        app: db.app, vault: db.vault, oauth: null, now: () => now,
        queryLogs: async (q) => {
          windows.push({ ref: q.projectRef, start: q.start.toISOString(), end: q.end.toISOString() });
          if (q.projectRef === "hhhhhhhhhhhhhhhhhhhh") throw new Error("Supabase is down");
          expect(q.sql).toMatch(/count\(\) AS requests/);
          return [{ requests: 4321 }];
        },
      });
      expect(result).toEqual({ day: "2026-11-10", counted: 1, failed: 1 });
      expect(windows.every((w) => w.start === "2026-11-10T00:00:00.000Z" && w.end === "2026-11-11T00:00:00.000Z")).toBe(true);
      const rows = await db.admin.query("SELECT project_id, day::text AS day, requests::int AS requests FROM supahound.project_usage WHERE tenant_id = $1", [t]);
      expect(rows.rows).toEqual([{ project_id: ok, day: "2026-11-10", requests: 4321 }]);
      const audit = await db.admin.query(
        "SELECT project_id, detail->>'purpose' AS purpose FROM supahound.audit_log WHERE tenant_id = $1 AND action = 'logs_query'", [t],
      );
      expect(audit.rows).toEqual([{ project_id: ok, purpose: "usage_count" }]);
      void broken;
    });

    it("names the previous UTC day whatever the time of day", () => {
      expect(previousUtcDay(new Date("2026-11-11T00:20:00Z")).day).toBe("2026-11-10");
      expect(previousUtcDay(new Date("2026-11-11T23:59:00Z")).day).toBe("2026-11-10");
      expect(previousUtcDay(new Date("2026-03-01T00:00:00Z")).day).toBe("2026-02-28");
    });
  });

  it("refuses a subscription row without a verified card (database CHECK)", async () => {
    const t = await workspace("Check constraint");
    await expect(
      withTenant(db.app, t, (tx) =>
        saveSubscription(tx, {
          id: "sub_nocard1", customerId: "cus_nocard1", status: "active", seats: { starter: 1, pro: 0 },
          trialEnd: null, currentPeriodEnd: null, cancelAtPeriodEnd: false,
        }, null),
      ),
    ).rejects.toThrow(/check constraint/);
  });
});
