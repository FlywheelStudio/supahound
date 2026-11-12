import { randomUUID } from "node:crypto";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { convertSubscriptions } from "../../src/billing/convert.js";
import {
  applyUsageTiers, completeVerification, handleBillingEvent, reconcileProjects, startCheckout, syncBilling, syncSeats, type FlowDeps,
} from "../../src/billing/flow.js";
import { runConvertSubscriptions } from "../../src/cli.js";
import { closeWorkspace, reopenClosedWorkspace, runDataJob } from "../../src/datacontrols/flow.js";
import {
  getBilling, isPaying, listProjectSubscriptions, PaymentRequiredError, projectBillingDrift, saveDailyUsage, saveProjectSubscription,
  saveSubscription, setStripeCustomer, withPaidTenantForUser,
} from "../../src/db/billing.js";
import * as repo from "../../src/db/repo.js";
import { withTenant } from "../../src/db/tenant.js";
import { createWorkspace, withTenantForUser } from "../../src/db/user.js";
import { verifiedUserId, type ProjectId, type TenantId, type UserId } from "../../src/tenancy/scope.js";
import { FakeStripe, GOOD } from "./fakeStripe.js";
import { pgInfo, useDb } from "./harness.js";

// One Stripe subscription per project (issue #99, decisions 032 and 041), against real Postgres
// with forced RLS and a fake Stripe that records every write.

const DAY = 86_400_000;
const user = () => verifiedUserId(randomUUID());
const freshRef = () => `r${randomUUID().replace(/-/g, "").slice(0, 19)}`;

describe.skipIf(pgInfo === null)("one subscription per project", () => {
  const db = useDb();
  let stripe: FakeStripe;
  let deps: FlowDeps;

  beforeAll(() => {
    stripe = new FakeStripe();
    deps = { pool: db.app, stripe, appUrl: "https://app.supahound.test", now: () => new Date() };
  });

  // A workspace whose owner added a card (per-project model, decision 041).
  async function cardWorkspace(name: string): Promise<{ tenant: TenantId; owner: UserId }> {
    const owner = user();
    const tenant = await createWorkspace(db.app, owner, name);
    const session = (await startCheckout(deps, { user: owner, email: null, tenant, acceptedTerms: true })).split("/").at(-1)!;
    stripe.pay(session, GOOD);
    expect((await completeVerification(deps, session, tenant)).result).toBe("subscribed");
    return { tenant, owner };
  }

  async function addProject(tenant: TenantId, name: string, ref = freshRef()): Promise<ProjectId> {
    return withTenant(db.app, tenant, async (tx) => {
      const conn = await repo.createConnection(tx, db.vault, { label: name, token: `tok-${randomUUID()}` });
      return repo.createProject(tx, { connectionId: conn, supabaseRef: ref, name });
    });
  }
  const refOf = async (t: TenantId, p: ProjectId) =>
    (await db.admin.query<{ r: string }>("SELECT supabase_ref AS r FROM supahound.projects WHERE tenant_id = $1 AND id = $2", [t, p])).rows[0]!.r;
  const endTrial = (t: TenantId) => db.admin.query("UPDATE supahound.billing_accounts SET trial_end = now() - interval '1 day' WHERE tenant_id = $1", [t]);
  const rows = (t: TenantId) => withTenant(db.app, t, listProjectSubscriptions);
  const billing = (t: TenantId) => withTenant(db.app, t, getBilling);

  describe("adding and removing projects", () => {
    it("bills a project added during the trial on its own subscription that ends the trial with the workspace", async () => {
      const { tenant } = await cardWorkspace("During trial");
      const trialEnd = (await billing(tenant)).trialEnd!;
      const p = await addProject(tenant, "Shop");
      expect(await withTenant(db.app, tenant, (tx) => projectBillingDrift(tx, new Date()))).toBe(true);
      await syncBilling(deps, tenant, true);
      const [s] = stripe.projectSubs(tenant);
      expect([s!.projectId, s!.tier, s!.status, s!.trialEnd, s!.anchor]).toEqual([p, "starter", "trialing", trialEnd, null]);
      expect(stripe.creates.at(-1)!.key).toBe(`project-sub-${tenant}-${p}-0`);
      expect((await rows(tenant)).map((r) => [r.projectId, r.status])).toEqual([[p, "trialing"]]);
      expect((await billing(tenant)).status).toBe("trialing");
      expect(await withTenant(db.app, tenant, (tx) => projectBillingDrift(tx, new Date()))).toBe(false);
      // The scheduler polls it and counts its usage (it reads the standing, as before).
      expect((await repo.dueProjects(db.scheduler, 60, 5000, "stripe")).map((x) => x.projectId)).toContain(p);
      expect(await repo.billedTenants(db.scheduler)).toContain(tenant);
    });

    it("bills a project added after the trial from the day it is added, and never restarts the trial", async () => {
      const { tenant } = await cardWorkspace("After trial");
      await endTrial(tenant);
      const p = await addProject(tenant, "Late");
      await reconcileProjects(deps, tenant);
      const [s] = stripe.projectSubs(tenant);
      expect([s!.projectId, s!.status, s!.trialEnd]).toEqual([p, "active", null]);
      expect(stripe.creates.at(-1)!.trialEnd).toBeNull();
      expect((await billing(tenant)).status).toBe("active");
    });

    it("cancels a removed project at its period end, keeps the row as payment history, and still counts it as paying", async () => {
      const { tenant } = await cardWorkspace("Remove");
      await endTrial(tenant);
      const p = await addProject(tenant, "Gone");
      await reconcileProjects(deps, tenant);
      const subId = stripe.projectSubs(tenant)[0]!.id;
      await withTenant(db.app, tenant, (tx) => repo.removeProject(tx, p));
      await reconcileProjects(deps, tenant);
      expect(stripe.subscriptions.get(subId)!.cancelAtPeriodEnd).toBe(true);
      expect((await rows(tenant)).map((r) => [r.subscriptionId, r.projectId, r.cancelAtPeriodEnd])).toEqual([[subId, null, true]]);
      // No watched project: the standing is "none"; the paid month still runs, so it pays.
      expect((await billing(tenant)).status).toBe("none");
      expect(await withTenant(db.app, tenant, isPaying)).toBe(true);
      expect(await withPaidTenantForUser(db.app, "stripe", (await owners(tenant))[0]!, tenant, async (_tx, _r, a) => a)).toBe("full");
      // The period ends: Stripe ends it, and the workspace no longer pays.
      stripe.set(subId, { status: "canceled" });
      await handleBillingEvent(deps, { id: `evt_${randomUUID().slice(0, 8)}`, type: "customer.subscription.deleted", tenant, checkoutSessionId: null, subscriptionId: subId });
      expect(await withTenant(db.app, tenant, isPaying)).toBe(false);
    });

    it("gives a project removed and added again its running subscription back: no second charge", async () => {
      const { tenant } = await cardWorkspace("Re-add");
      await endTrial(tenant);
      const ref = freshRef();
      const first = await addProject(tenant, "Again", ref);
      await reconcileProjects(deps, tenant);
      const subId = stripe.projectSubs(tenant)[0]!.id;
      await withTenant(db.app, tenant, (tx) => repo.removeProject(tx, first));
      await reconcileProjects(deps, tenant);
      const creates = stripe.creates.length;
      const second = await addProject(tenant, "Again", ref);
      await reconcileProjects(deps, tenant);
      expect(stripe.creates.length).toBe(creates);
      expect(stripe.subscriptions.get(subId)!.cancelAtPeriodEnd).toBe(false);
      expect((await rows(tenant)).map((r) => [r.subscriptionId, r.projectId])).toEqual([[subId, second]]);
    });

    it("cancels a paused (disconnected) project at its period end and resumes it on reconnect", async () => {
      const { tenant } = await cardWorkspace("Pause");
      const p = await addProject(tenant, "Paused");
      await reconcileProjects(deps, tenant);
      const subId = stripe.projectSubs(tenant)[0]!.id;
      await db.admin.query("UPDATE supahound.projects SET paused = true WHERE tenant_id = $1 AND id = $2", [tenant, p]);
      await reconcileProjects(deps, tenant);
      expect(stripe.subscriptions.get(subId)!.cancelAtPeriodEnd).toBe(true);
      await db.admin.query("UPDATE supahound.projects SET paused = false WHERE tenant_id = $1 AND id = $2", [tenant, p]);
      await reconcileProjects(deps, tenant);
      expect(stripe.subscriptions.get(subId)!.cancelAtPeriodEnd).toBe(false);
      expect(stripe.projectSubs(tenant)).toHaveLength(1);
    });

    it("moves a busy project to Pro at the next renewal with no proration, and never touches seats", async () => {
      const { tenant } = await cardWorkspace("Tier");
      const p = await addProject(tenant, "Busy");
      await reconcileProjects(deps, tenant);
      const subId = stripe.projectSubs(tenant)[0]!.id;
      await withTenant(db.app, tenant, async (tx) => {
        for (let d = 0; d < 30; d++) await saveDailyUsage(tx, p, new Date(Date.UTC(2026, 10, 10 - d)).toISOString().slice(0, 10), 40_000);
      });
      const seatCalls = stripe.seatUpdates.length;
      await applyUsageTiers(deps, tenant, "2026-11-10");
      expect(stripe.writes.filter((w) => w.kind === "tier" && w.id === subId).map((w) => w.detail)).toEqual(["pro"]);
      expect((await rows(tenant))[0]!.tier).toBe("pro");
      await syncSeats(deps, tenant, true);
      expect(stripe.seatUpdates.length).toBe(seatCalls);
    });

    it("recovers from a Stripe outage: the failure surfaces, drift shows, and the retry creates once", async () => {
      const { tenant } = await cardWorkspace("Outage");
      const p = await addProject(tenant, "Flaky");
      stripe.failNext.add("create");
      await expect(reconcileProjects(deps, tenant)).rejects.toThrow(/1 of 1 Stripe changes failed/);
      expect(await withTenant(db.app, tenant, (tx) => projectBillingDrift(tx, new Date()))).toBe(true);
      await reconcileProjects(deps, tenant);
      await reconcileProjects(deps, tenant);
      expect(stripe.projectSubs(tenant).map((s) => s.projectId)).toEqual([p]);
    });

    it("adopts a subscription Stripe made whose row was never written, instead of making a second one", async () => {
      const { tenant } = await cardWorkspace("Lost row");
      const p = await addProject(tenant, "Orphan");
      const b = await billing(tenant);
      // Stripe created it (say, the Worker died before the database write) under a different key.
      await stripe.createProjectSubscription({
        tenant, projectId: p, supabaseRef: await refOf(tenant, p), customerId: b.customerId!, tier: "starter", trialEnd: b.trialEnd,
        anchor: null, idempotencyKey: "lost-key",
      });
      const creates = stripe.creates.length;
      await reconcileProjects(deps, tenant);
      expect(stripe.creates.length).toBe(creates);
      expect((await rows(tenant)).map((r) => r.projectId)).toEqual([p]);
    });

    it("creates no subscription for a staff-exempt workspace (decision 029)", async () => {
      const owner = user();
      const tenant = await createWorkspace(db.app, owner, "Staff");
      await db.admin.query("INSERT INTO supahound.billing_accounts (tenant_id, billing_model, exempt_owner, exempt_at) VALUES ($1, 'project', $2, now())", [tenant, owner]);
      await addProject(tenant, "Staff app");
      await syncBilling(deps, tenant, true);
      expect(stripe.projectSubs(tenant)).toEqual([]);
      expect(await withTenant(db.app, tenant, isPaying)).toBe(true);
    });

    it("blocks the workspace when a watched project's subscription ends unpaid, and a new card bills it again with no trial", async () => {
      const { tenant, owner } = await cardWorkspace("Lapse");
      const p = await addProject(tenant, "Lapsed");
      await reconcileProjects(deps, tenant);
      const subId = stripe.projectSubs(tenant)[0]!.id;
      stripe.set(subId, { status: "past_due" });
      await handleBillingEvent(deps, { id: `evt_${randomUUID().slice(0, 8)}`, type: "invoice.payment_failed", tenant, checkoutSessionId: null, subscriptionId: subId });
      expect(await withPaidTenantForUser(db.app, "stripe", owner, tenant, async (_tx, _r, a) => a)).toBe("grace");
      stripe.set(subId, { status: "canceled" });
      await handleBillingEvent(deps, { id: `evt_${randomUUID().slice(0, 8)}`, type: "customer.subscription.deleted", tenant, checkoutSessionId: null, subscriptionId: subId });
      await expect(withPaidTenantForUser(db.app, "stripe", owner, tenant, async () => undefined)).rejects.toBeInstanceOf(PaymentRequiredError);
      // Reconcile does not re-bill a blocked workspace on its own: a card comes first.
      await reconcileProjects(deps, tenant);
      expect(stripe.projectSubs(tenant)).toHaveLength(1);
      await endTrial(tenant);
      const session = (await startCheckout(deps, { user: owner, email: null, tenant, acceptedTerms: true })).split("/").at(-1)!;
      stripe.pay(session, GOOD);
      await completeVerification(deps, session, tenant);
      const subs = stripe.projectSubs(tenant);
      expect(subs.map((s) => [s.projectId, s.status, s.trialEnd])).toEqual([[p, "canceled", subs[0]!.trialEnd], [p, "active", null]]);
      expect((await billing(tenant)).status).toBe("active");
    });
  });

  async function owners(t: TenantId): Promise<UserId[]> {
    return (await db.admin.query<{ u: string }>("SELECT user_id AS u FROM supahound.memberships WHERE tenant_id = $1 AND role = 'owner'", [t])).rows.map((r) => verifiedUserId(r.u));
  }

  describe("storage and RLS", () => {
    let A: TenantId;
    let B: TenantId;
    let pShop: ProjectId;
    const admin = user();
    const viewer = user();
    const outsider = user();

    beforeAll(async () => {
      A = (await cardWorkspace("RLS A")).tenant;
      B = (await cardWorkspace("RLS B")).tenant;
      pShop = await addProject(A, "Shop");
      await addProject(A, "Blog");
      await addProject(B, "Theirs");
      for (const t of [A, B]) await reconcileProjects(deps, t);
      // A removed project's subscription (no project link).
      const gone = await addProject(A, "Gone");
      await reconcileProjects(deps, A);
      await withTenant(db.app, A, (tx) => repo.removeProject(tx, gone));
      await reconcileProjects(deps, A);
      await db.admin.query("INSERT INTO supahound.memberships (tenant_id, user_id, role) VALUES ($1, $2, 'admin'), ($1, $3, 'member'), ($1, $4, 'member')", [A, admin, viewer, outsider]);
      await db.admin.query("INSERT INTO supahound.project_members (tenant_id, project_id, user_id, role) VALUES ($1, $2, $3, 'viewer')", [A, pShop, viewer]);
    });

    const seen = async (who: UserId, t: TenantId) =>
      withTenantForUser(db.app, who, t, async (tx) => (await listProjectSubscriptions(tx)).map((s) => s.projectId));

    it("shows workspace owners and admins every row, including removed projects'", async () => {
      for (const who of [...(await owners(A)), admin]) expect((await seen(who, A)).length).toBe(3);
      expect((await seen(admin, A)).filter((p) => p === null)).toHaveLength(1);
    });

    it("shows a project Viewer only that project's row, and a member with no project role nothing", async () => {
      expect(await seen(viewer, A)).toEqual([pShop]);
      expect(await seen(outsider, A)).toEqual([]);
    });

    it("never shows another tenant's rows, even through the tenant's own transaction", async () => {
      const mine = await withTenant(db.app, B, (tx) => tx.query<{ tenant_id: string }>("SELECT tenant_id FROM supahound.project_subscriptions"));
      expect(mine.map((r) => r.tenant_id)).toEqual([B]);
      const ids = (await rows(A)).map((r) => r.subscriptionId);
      const cross = await withTenant(db.app, B, (tx) => tx.query("SELECT 1 FROM supahound.project_subscriptions WHERE subscription_id = ANY($1)", [ids]));
      expect(cross).toHaveLength(0);
      // A write aimed at the other tenant's row changes nothing.
      const upd = await withTenant(db.app, B, (tx) => tx.query("UPDATE supahound.project_subscriptions SET status = 'canceled' WHERE subscription_id = ANY($1) RETURNING 1", [ids]));
      expect(upd).toHaveLength(0);
    });

    it("lets owners and admins write, refuses members, and lets nobody delete (payment history)", async () => {
      const [first] = await rows(A);
      const touch = (who: UserId) => withTenantForUser(db.app, who, A, (tx) =>
        tx.query("UPDATE supahound.project_subscriptions SET updated_at = now() WHERE tenant_id = $1 AND subscription_id = $2 RETURNING 1", [A, first!.subscriptionId]));
      expect(await touch(admin)).toHaveLength(1);
      expect(await touch(viewer)).toHaveLength(0);
      await expect(withTenantForUser(db.app, viewer, A, (tx) => saveProjectSubscription(tx, {
        subscriptionId: "sub_viewerinsert1", supabaseRef: freshRef(), tier: "starter", status: "active", trialEnd: null, currentPeriodEnd: null, cancelAtPeriodEnd: false,
      }, null))).rejects.toThrow(/row-level security/);
      await expect(withTenant(db.app, A, (tx) => tx.query("DELETE FROM supahound.project_subscriptions WHERE tenant_id = $1", [A]))).rejects.toThrow(/permission denied/);
    });

    it("refuses a second live subscription for one project (database index)", async () => {
      await expect(db.admin.query(
        `INSERT INTO supahound.project_subscriptions (tenant_id, project_id, supabase_ref, subscription_id, tier, status)
         VALUES ($1, $2, $3, 'sub_duplicate1', 'starter', 'active')`, [A, pShop, await refOf(A, pShop)],
      )).rejects.toThrow(/project_subscriptions_one_live/);
      // saveProjectSubscription stores such a subscription unlinked instead, and reconcile cancels it.
      await withTenant(db.app, A, (tx) => saveProjectSubscription(tx, {
        subscriptionId: "sub_duplicate2", supabaseRef: freshRef(), tier: "starter", status: "active", trialEnd: null, currentPeriodEnd: null, cancelAtPeriodEnd: false,
      }, pShop));
      expect((await rows(A)).find((r) => r.subscriptionId === "sub_duplicate2")!.projectId).toBeNull();
    });
  });

  describe("paying (decision 037) under both models, and the deletion paths", () => {
    async function oldIncident(t: TenantId, p: ProjectId) {
      await withTenant(db.app, t, async (tx) => {
        const old = new Date(Date.now() - 40 * DAY);
        await repo.upsertIncident(tx, p, {
          id: null, status: "resolved", actor: "user:old", severity: "high", detectors: ["cross_tenant"], signals: ["other_owner"],
          findingCount: 1, hits: 1, openedAt: old, lastSeenAt: old,
        });
      });
    }
    const incidents = async (t: TenantId) => (await db.admin.query("SELECT 1 FROM supahound.incidents WHERE tenant_id = $1", [t])).rows.length;

    it("per-project: an active project subscription keeps all data; trialing ones do not", async () => {
      const paid = await cardWorkspace("Paying project");
      await endTrial(paid.tenant);
      const p1 = await addProject(paid.tenant, "Paid");
      await reconcileProjects(deps, paid.tenant);
      await oldIncident(paid.tenant, p1);
      expect(await runDataJob(db.app, paid.tenant, new Date())).toMatchObject({ paying: true });
      expect(await incidents(paid.tenant)).toBe(1);

      const trial = await cardWorkspace("Trial project");
      const p2 = await addProject(trial.tenant, "Trialing");
      await reconcileProjects(deps, trial.tenant);
      await oldIncident(trial.tenant, p2);
      expect(await runDataJob(db.app, trial.tenant, new Date())).toMatchObject({ paying: false });
      expect(await incidents(trial.tenant)).toBe(0);
    });

    it("seat model: the workspace subscription still decides, as before (decision 037)", async () => {
      const owner = user();
      const t = await createWorkspace(db.app, owner, "Seat paying");
      const { id: customer } = await stripe.createCustomer({ tenant: t, email: null, idempotencyKey: `customer-${t}` });
      const seat = stripe.seedSeatSubscription({ tenant: t, customerId: customer, seats: { starter: 1, pro: 0 }, trial: false, periodEnd: new Date(Date.now() + 9 * DAY) });
      await withTenant(db.app, t, async (tx) => { await setStripeCustomer(tx, customer); await saveSubscription(tx, seat, new Date()); });
      const p = await addProject(t, "Seat app");
      await oldIncident(t, p);
      expect(await withTenant(db.app, t, isPaying)).toBe(true);
      expect(await runDataJob(db.app, t, new Date())).toMatchObject({ paying: true });
      expect(await incidents(t)).toBe(1);
    });
  });

  describe("webhooks for project subscriptions", () => {
    it("stores each event once, refreshes the standing, and ignores a tenant that does not own the subscription", async () => {
      const { tenant, owner } = await cardWorkspace("Hooks");
      await addProject(tenant, "Hooked");
      await reconcileProjects(deps, tenant);
      const subId = stripe.projectSubs(tenant)[0]!.id;
      stripe.set(subId, { status: "past_due" });
      const e = { id: "evt_projecthook1", type: "invoice.payment_failed", tenant, checkoutSessionId: null, subscriptionId: subId };
      expect(await handleBillingEvent(deps, e)).toBe("processed");
      expect(await handleBillingEvent(deps, e)).toBe("duplicate");
      expect([(await rows(tenant))[0]!.status, (await billing(tenant)).status]).toEqual(["past_due", "past_due"]);
      expect(await withPaidTenantForUser(db.app, "stripe", owner, tenant, async (_tx, _r, a) => a)).toBe("grace");

      const other = await cardWorkspace("Not the owner");
      expect(await handleBillingEvent(deps, { ...e, id: "evt_projecthook2", tenant: other.tenant })).toBe("ignored");
      expect(await rows(other.tenant)).toEqual([]);
    });
  });

  describe("closing and reopening (decision 037)", () => {
    it("cancels every project subscription at its period end, stays open until the last one, and reopen resumes the watched ones only", async () => {
      const { tenant, owner } = await cardWorkspace("Closing");
      await endTrial(tenant);
      const keep = await addProject(tenant, "Kept");
      const gone = await addProject(tenant, "Removed");
      await reconcileProjects(deps, tenant);
      const subs = stripe.projectSubs(tenant);
      // Later than any other period here (the fake's default is 30 days).
      const later = new Date(Date.now() + 40 * DAY);
      stripe.set(subs[0]!.id, { currentPeriodEnd: later });
      await withTenant(db.app, tenant, (tx) => repo.removeProject(tx, gone));
      await reconcileProjects(deps, tenant);
      const name = (await db.admin.query<{ n: string }>("SELECT name AS n FROM supahound.tenants WHERE id = $1", [tenant])).rows[0]!.n;
      expect(await closeWorkspace({ pool: db.app, stripe, now: () => new Date() }, { user: owner, tenant, typedName: name })).toBe("closed");
      expect(stripe.projectSubs(tenant).every((s) => s.cancelAtPeriodEnd)).toBe(true);
      const ends = (await db.admin.query<{ e: Date }>("SELECT access_ends_at AS e FROM supahound.account_closures WHERE tenant_id = $1", [tenant])).rows[0]!.e;
      expect(ends.getTime()).toBe(later.getTime());
      // Closing stops reconcile: it must not undo the cancel.
      await reconcileProjects(deps, tenant);
      expect(stripe.projectSubs(tenant).every((s) => s.cancelAtPeriodEnd)).toBe(true);

      expect(await reopenClosedWorkspace({ pool: db.app, stripe, now: () => new Date() }, { user: owner, tenant })).toBe("reopened");
      const after = Object.fromEntries(stripe.projectSubs(tenant).map((s) => [s.projectId, s.cancelAtPeriodEnd]));
      expect(after).toEqual({ [keep]: false, [gone]: true });
    });
  });

  describe("conversion of seat subscriptions (operator CLI)", () => {
    let out: string[];
    beforeEach(() => { out = []; });
    const cdeps = () => ({ app: db.app, scheduler: db.scheduler, stripe, now: () => new Date(), exemptDomains: ["staff.test"], out: (l: string) => out.push(l) });

    async function seatWorkspace(name: string, opts: { trial?: boolean; ownerEmail?: string; projects?: number } = {}) {
      const owner = user();
      const tenant = await createWorkspace(db.app, owner, name, opts.ownerEmail);
      const { id: customer } = await stripe.createCustomer({ tenant, email: null, idempotencyKey: `customer-${tenant}` });
      const periodEnd = new Date(Date.now() + (opts.trial ? 6 : 12) * DAY);
      const seat = stripe.seedSeatSubscription({ tenant, customerId: customer, seats: { starter: opts.projects ?? 2, pro: 0 }, trial: opts.trial ?? false, periodEnd, paymentMethod: "pm_seatcard" });
      await withTenant(db.app, tenant, async (tx) => { await setStripeCustomer(tx, customer); await saveSubscription(tx, seat, new Date()); });
      const projects: ProjectId[] = [];
      for (let i = 0; i < (opts.projects ?? 2); i++) projects.push(await addProject(tenant, `${name} ${i}`));
      return { tenant, owner, seat, customer, periodEnd, projects };
    }

    it("dry run: prints the plan and changes nothing in Stripe or the database", async () => {
      const w = await seatWorkspace("Dry run");
      const writes = stripe.writes.length;
      const before = await billing(w.tenant);
      const r = await convertSubscriptions(cdeps(), { apply: false, only: w.tenant });
      expect(r.plans[0]).toMatchObject({ action: "convert", mode: "anchor", anchor: w.periodEnd });
      expect(stripe.writes.length).toBe(writes);
      expect(await billing(w.tenant)).toEqual(before);
      expect(await rows(w.tenant)).toEqual([]);
      expect(out.join("\n")).toMatch(/create: project .* billing_cycle_anchor .* no proration/);
      expect(out.at(-1)).toMatch(/^Dry run: 1 workspaces would convert/);
    });

    it("apply: one subscription per project anchored at the seat period end, the seat one canceled at that end, no double charge", async () => {
      const w = await seatWorkspace("Apply");
      const r = await convertSubscriptions(cdeps(), { apply: true, only: w.tenant });
      expect([r.converted, r.failed]).toEqual([1, 0]);
      const subs = stripe.projectSubs(w.tenant);
      expect(subs.map((s) => [s.projectId, s.status, s.anchor?.getTime(), s.trialEnd])).toEqual(
        w.projects.map((p) => [p, "active", w.periodEnd.getTime(), null]));
      const seat = stripe.subscriptions.get(w.seat.id)!;
      expect([seat.cancelAtPeriodEnd, seat.converted, seat.currentPeriodEnd!.getTime()]).toEqual([true, true, w.periodEnd.getTime()]);
      expect(stripe.customers.find((c) => c.id === w.customer)!.defaultPaymentMethod).toBe("pm_seatcard");
      const b = await billing(w.tenant);
      expect([b.model, b.status, b.subscriptionId]).toEqual(["project", "active", w.seat.id]);
      expect(await withTenant(db.app, w.tenant, isPaying)).toBe(true);
      // Converted: adding a project never charges the seat subscription again.
      await addProject(w.tenant, "After conversion");
      const seatCalls = stripe.seatUpdates.length;
      await syncBilling(deps, w.tenant, true);
      expect(stripe.seatUpdates.length).toBe(seatCalls);
      expect(stripe.projectSubs(w.tenant)).toHaveLength(3);
      // A late event for the seat subscription does not overwrite the standing.
      await handleBillingEvent(deps, { id: "evt_seatlate1", type: "customer.subscription.updated", tenant: w.tenant, checkoutSessionId: null, subscriptionId: w.seat.id });
      expect((await billing(w.tenant)).status).toBe("active");
    });

    it("is idempotent: a second run converts nothing and writes nothing", async () => {
      const w = await seatWorkspace("Twice");
      await convertSubscriptions(cdeps(), { apply: true, only: w.tenant });
      const writes = stripe.writes.length;
      const r = await convertSubscriptions(cdeps(), { apply: true, only: w.tenant });
      expect(r.plans[0]).toMatchObject({ action: "skip", reason: "already converted" });
      expect(stripe.writes.length).toBe(writes);
    });

    it("resumes an interrupted run: creates only what is missing and cancels the seat subscription once", async () => {
      const w = await seatWorkspace("Interrupted", { projects: 3 });
      stripe.failNext.add("cancel");
      const first = await convertSubscriptions(cdeps(), { apply: true, only: w.tenant });
      expect(first.failed).toBe(1);
      expect(stripe.projectSubs(w.tenant)).toHaveLength(3);
      expect((await billing(w.tenant)).model).toBe("workspace");
      const creates = stripe.creates.length;
      const second = await convertSubscriptions(cdeps(), { apply: true, only: w.tenant });
      expect(second.converted).toBe(1);
      expect(stripe.creates.length).toBe(creates);
      expect(stripe.writes.filter((x) => x.kind === "cancel" && x.id === w.seat.id)).toHaveLength(1);
      expect((await billing(w.tenant)).model).toBe("project");
    });

    it("keeps a trialing workspace's trial: its projects trial until the same moment", async () => {
      const w = await seatWorkspace("Trialing seat", { trial: true });
      await convertSubscriptions(cdeps(), { apply: true, only: w.tenant });
      expect(stripe.projectSubs(w.tenant).map((s) => [s.status, s.trialEnd!.getTime(), s.anchor])).toEqual(
        w.projects.map(() => ["trialing", w.periodEnd.getTime(), null]));
      expect((await billing(w.tenant)).status).toBe("trialing");
    });

    it("skips exempt workspaces and staff workspaces whose exemption is not granted yet", async () => {
      const staff = await seatWorkspace("Staff granted", { ownerEmail: "boss@staff.test" });
      await db.admin.query("UPDATE supahound.billing_accounts SET exempt_owner = $2, exempt_at = now() WHERE tenant_id = $1", [staff.tenant, staff.owner]);
      const pending = await seatWorkspace("Staff pending", { ownerEmail: "lead@staff.test" });
      const writes = stripe.writes.length;
      const r = await convertSubscriptions(cdeps(), { apply: true });
      const byTenant = Object.fromEntries(r.plans.map((p) => [p.tenant, p]));
      expect(byTenant[staff.tenant]).toMatchObject({ action: "skip", reason: expect.stringMatching(/staff exemption/) });
      expect(byTenant[pending.tenant]).toMatchObject({ action: "skip", reason: expect.stringMatching(/not granted yet/) });
      expect(stripe.writes.slice(writes).filter((x) => [staff.seat.id, pending.seat.id].includes(x.id))).toEqual([]);
      expect(stripe.projectSubs(staff.tenant)).toEqual([]);
      expect(stripe.projectSubs(pending.tenant)).toEqual([]);
    });

    it("CLI: refuses --apply with a live key unless confirmed, and needs its settings", async () => {
      const lines: string[] = [];
      const env = {
        SUPAHOUND_APP_DATABASE_URL: "postgres://x", SUPAHOUND_SCHEDULER_DATABASE_URL: "postgres://y", STRIPE_SECRET_KEY: "sk_live_x",
        STRIPE_PRICE_STARTER: "price_s", STRIPE_PRICE_PRO: "price_p",
      };
      const pool = () => { throw new Error("must not connect"); };
      expect(await runConvertSubscriptions(["--apply"], { env, pool, stripe, now: () => new Date(), out: (l) => lines.push(l) })).toBe(2);
      expect(lines.at(-1)).toMatch(/live Stripe key/);
      expect(await runConvertSubscriptions([], { env: {}, pool, stripe, now: () => new Date(), out: (l) => lines.push(l) })).toBe(2);
      expect(lines.at(-1)).toMatch(/set SUPAHOUND_APP_DATABASE_URL/);
    });
  });
});
