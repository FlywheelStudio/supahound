import { randomUUID } from "node:crypto";
import { beforeAll, describe, expect, it } from "vitest";
import { completeVerification, handleBillingEvent, reconcileProjects, startCheckout, type FlowDeps, type StripeGateway } from "../../src/billing/flow.js";
import { closeWorkspace, runDataJob } from "../../src/datacontrols/flow.js";
import { getBilling, isPaying, listProjectSubscriptions } from "../../src/db/billing.js";
import * as removal from "../../src/db/removal.js";
import * as repo from "../../src/db/repo.js";
import { withTenant } from "../../src/db/tenant.js";
import { createWorkspace, withTenantForUser } from "../../src/db/user.js";
import { connectionId, verifiedUserId, type ProjectId, type TenantId, type UserId } from "../../src/tenancy/scope.js";
import { FakeStripe, GOOD } from "./fakeStripe.js";
import { pgInfo, useDb } from "./harness.js";

// Project removal with a grace period (decision 042), against real Postgres with forced RLS and a
// fake Stripe: the dates, the undo, the data job, the picker, and the Stripe webhook.

const DAY = 86_400_000;
const user = () => verifiedUserId(randomUUID());
const freshRef = () => `r${randomUUID().replace(/-/g, "").slice(0, 19)}`;

describe.skipIf(pgInfo === null)("project removal with a grace period", () => {
  const db = useDb();
  let stripe: FakeStripe;
  let deps: FlowDeps;

  beforeAll(() => {
    stripe = new FakeStripe();
    deps = { pool: db.app, stripe, appUrl: "https://app.supahound.test", now: () => new Date() };
  });

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
  const endTrial = (t: TenantId) => db.admin.query("UPDATE supahound.billing_accounts SET trial_end = now() - interval '1 day' WHERE tenant_id = $1", [t]);
  const subOf = (t: TenantId, p: ProjectId) => stripe.projectSubs(t).filter((s) => s.projectId === p).at(-1)!;
  const remove = (owner: UserId, t: TenantId, p: ProjectId, now = new Date()) =>
    withTenantForUser(db.app, owner, t, (tx) => removal.scheduleRemoval(tx, p, now));
  const keep = (owner: UserId, t: TenantId, p: ProjectId) => withTenantForUser(db.app, owner, t, (tx) => removal.cancelRemoval(tx, p));
  const schedule = (t: TenantId, p: ProjectId) => withTenant(db.app, t, (tx) => removal.getRemoval(tx, p));
  const event = (t: TenantId, subscriptionId: string, type = "customer.subscription.updated") =>
    handleBillingEvent(deps, { id: `evt_${randomUUID().replace(/-/g, "").slice(0, 16)}`, type, tenant: t, checkoutSessionId: null, subscriptionId });
  // Moves a scheduled removal into the past: its active period ended `hoursAgo` hours ago.
  const periodEnded = (t: TenantId, p: ProjectId, hoursAgo = 1) => db.admin.query(
    `UPDATE supahound.projects SET removal_requested_at = now() - interval '40 days',
       active_until = now() - make_interval(hours => $3), delete_after = now() - make_interval(hours => $3) + interval '7 days'
     WHERE tenant_id = $1 AND id = $2`,
    [t, p, hoursAgo],
  );

  describe("the dates", () => {
    it("keeps a paid project active until its period end and deletes it 7 days later", async () => {
      const { tenant, owner } = await cardWorkspace("Paid removal");
      await endTrial(tenant);
      const p = await addProject(tenant, "Paid");
      await reconcileProjects(deps, tenant);
      const sub = subOf(tenant, p);
      const s = (await remove(owner, tenant, p))!;
      expect(s.activeUntil).toEqual(sub.currentPeriodEnd);
      expect(s.deleteAfter.getTime() - s.activeUntil.getTime()).toBe(7 * DAY);
      // Reconcile cancels the subscription at its period end and never resumes it.
      await reconcileProjects(deps, tenant);
      expect(stripe.subscriptions.get(sub.id)!.cancelAtPeriodEnd).toBe(true);
      const writes = stripe.writes.length;
      await reconcileProjects(deps, tenant);
      expect(stripe.writes.length).toBe(writes);
      // The row keeps its project link while the project exists; the standing ignores it.
      expect((await withTenant(db.app, tenant, listProjectSubscriptions)).map((r) => [r.projectId, r.cancelAtPeriodEnd])).toEqual([[p, true]]);
      expect((await withTenant(db.app, tenant, getBilling)).status).toBe("none");
      expect(await withTenant(db.app, tenant, isPaying)).toBe(true);
    });

    it("keeps a project removed during the trial active until the trial end", async () => {
      const { tenant, owner } = await cardWorkspace("Trial removal");
      const trialEnd = (await withTenant(db.app, tenant, getBilling)).trialEnd!;
      const p = await addProject(tenant, "Trial");
      await reconcileProjects(deps, tenant);
      expect(subOf(tenant, p).status).toBe("trialing");
      const s = (await remove(owner, tenant, p))!;
      expect(s.activeUntil).toEqual(trialEnd);
      expect(s.deleteAfter).toEqual(new Date(trialEnd.getTime() + 7 * DAY));
    });

    it("stops a project of a staff-exempt workspace at once and deletes it 7 days later", async () => {
      const owner = user();
      const tenant = await createWorkspace(db.app, owner, "Exempt removal");
      await db.admin.query("INSERT INTO supahound.billing_accounts (tenant_id, billing_model, exempt_owner, exempt_at) VALUES ($1, 'project', $2, now())", [tenant, owner]);
      const p = await addProject(tenant, "Staff");
      const now = new Date();
      const s = (await remove(owner, tenant, p, now))!;
      expect([s.activeUntil, s.deleteAfter]).toEqual([now, new Date(now.getTime() + 7 * DAY)]);
      expect(stripe.projectSubs(tenant)).toEqual([]);
    });

    it("stops a project with no subscription row at once", async () => {
      const { tenant, owner } = await cardWorkspace("No row");
      const p = await addProject(tenant, "Unsynced");
      const now = new Date();
      expect((await remove(owner, tenant, p, now))!.activeUntil).toEqual(now);
    });
  });

  describe("polling", () => {
    it("polls a removed project until active_until, then stops", async () => {
      const { tenant, owner } = await cardWorkspace("Polling");
      const p = await addProject(tenant, "Still watched");
      await reconcileProjects(deps, tenant);
      await remove(owner, tenant, p);
      const due = async () => (await repo.dueProjects(db.scheduler, 60, 5000, "stripe")).map((x) => x.projectId);
      expect(await due()).toContain(p);
      await periodEnded(tenant, p);
      expect(await due()).not.toContain(p);
      expect(await withTenant(db.app, tenant, (tx) => repo.claimProject(tx, p, new Date(), 60))).toBe(false);
      // Still listed, so an Owner can keep it.
      expect((await withTenant(db.app, tenant, repo.listProjects)).find((x) => x.id === p)!.removal).not.toBeNull();
    });
  });

  describe("keep (undo)", () => {
    it("resumes the same subscription within the period: nothing new is charged", async () => {
      const { tenant, owner } = await cardWorkspace("Keep in period");
      await endTrial(tenant);
      const p = await addProject(tenant, "Kept");
      await reconcileProjects(deps, tenant);
      const subId = subOf(tenant, p).id;
      await remove(owner, tenant, p);
      await reconcileProjects(deps, tenant);
      const creates = stripe.creates.length;
      expect(await keep(owner, tenant, p)).toBe(true);
      expect(await schedule(tenant, p)).toBeNull();
      await reconcileProjects(deps, tenant);
      expect(stripe.subscriptions.get(subId)!.cancelAtPeriodEnd).toBe(false);
      expect(stripe.creates.length).toBe(creates);
      expect((await withTenant(db.app, tenant, getBilling)).status).toBe("active");
    });

    it("creates a new subscription, billed at once, after the period ended and before deletion", async () => {
      const { tenant, owner } = await cardWorkspace("Keep after period");
      await endTrial(tenant);
      const p = await addProject(tenant, "Late keep");
      await reconcileProjects(deps, tenant);
      const old = subOf(tenant, p).id;
      await remove(owner, tenant, p);
      await reconcileProjects(deps, tenant);
      // The period ends: Stripe ends the subscription.
      stripe.set(old, { status: "canceled" });
      await event(tenant, old, "customer.subscription.deleted");
      await periodEnded(tenant, p);
      expect((await withTenant(db.app, tenant, getBilling)).status).toBe("none");
      expect(await keep(owner, tenant, p)).toBe(true);
      await reconcileProjects(deps, tenant);
      const fresh = subOf(tenant, p);
      expect(fresh.id).not.toBe(old);
      expect([fresh.status, fresh.trialEnd]).toEqual(["active", null]);
      expect(stripe.creates.at(-1)!.key).toBe(`project-sub-${tenant}-${p}-1`);
      expect((await withTenant(db.app, tenant, getBilling)).status).toBe("active");
      expect((await repo.dueProjects(db.scheduler, 60, 5000, "stripe")).map((x) => x.projectId)).toContain(p);
    });

    it("keeps a removed project when the same Supabase project is picked again, with its history", async () => {
      const { tenant, owner } = await cardWorkspace("Re-pick");
      const ref = freshRef();
      const p = await addProject(tenant, "Picked", ref);
      await withTenant(db.app, tenant, (tx) => repo.appendAudit(tx, { projectId: p, action: "logs_query", detail: { rows: 1 } }));
      await remove(owner, tenant, p);
      const conn = connectionId((await db.admin.query<{ c: string }>("SELECT connection_id AS c FROM supahound.projects WHERE id = $1", [p])).rows[0]!.c);
      expect(await withTenantForUser(db.app, owner, tenant, (tx) => repo.watchProjects(tx, conn, [{ ref, name: "Picked" }]))).toEqual([ref]);
      expect(await schedule(tenant, p)).toBeNull();
      // Picking a watched project with no removal still adds nothing.
      expect(await withTenantForUser(db.app, owner, tenant, (tx) => repo.watchProjects(tx, conn, [{ ref, name: "Picked" }]))).toEqual([]);
      const ids = (await withTenant(db.app, tenant, repo.listProjects)).map((x) => x.id);
      expect(ids).toEqual([p]);
    });
  });

  describe("the data job", () => {
    it("never deletes before delete_after, then deletes even while the workspace pays, keeping audit and payment rows", async () => {
      const { tenant, owner } = await cardWorkspace("Data job");
      await endTrial(tenant);
      const stays = await addProject(tenant, "Stays");
      const goes = await addProject(tenant, "Goes");
      await reconcileProjects(deps, tenant);
      await withTenant(db.app, tenant, async (tx) => {
        const run = await repo.startPollRun(tx, goes, { start: new Date(Date.now() - 60_000), end: new Date() });
        await repo.finishPollRun(tx, run, { status: "ok", templates: 1, findings: 0 });
        await repo.appendAudit(tx, { projectId: goes, action: "logs_query", detail: { rows: 1 } });
      });
      const goesSub = subOf(tenant, goes).id;
      const s = (await remove(owner, tenant, goes))!;
      await reconcileProjects(deps, tenant);

      for (const at of [new Date(), s.activeUntil, new Date(s.deleteAfter.getTime() - 1)]) {
        expect(await runDataJob(db.app, tenant, at)).toMatchObject({ projectsDeleted: 0 });
      }
      expect(await withTenant(db.app, tenant, isPaying)).toBe(true);
      expect(await runDataJob(db.app, tenant, s.deleteAfter)).toMatchObject({ paying: true, projectsDeleted: 1 });

      const left = await db.admin.query(
        `SELECT (SELECT count(*)::int FROM supahound.projects WHERE tenant_id = $1) AS projects,
                (SELECT count(*)::int FROM supahound.poll_runs WHERE project_id = $2) AS runs,
                (SELECT count(*)::int FROM supahound.audit_log WHERE tenant_id = $1 AND project_id IS NULL AND action = 'logs_query') AS audit,
                (SELECT project_id FROM supahound.project_subscriptions WHERE subscription_id = $3) AS sub_project`,
        [tenant, goes, goesSub],
      );
      expect(left.rows[0]).toEqual({ projects: 1, runs: 0, audit: 1, sub_project: null });
      expect((await withTenant(db.app, tenant, repo.listProjects)).map((x) => x.id)).toEqual([stays]);
    });

    it("lets an undo that commits first win over the job", async () => {
      const { tenant, owner } = await cardWorkspace("Undo wins");
      const p = await addProject(tenant, "Saved");
      const s = (await remove(owner, tenant, p))!;
      await keep(owner, tenant, p);
      expect(await runDataJob(db.app, tenant, new Date(s.deleteAfter.getTime() + DAY))).toMatchObject({ projectsDeleted: 0 });
      expect((await withTenant(db.app, tenant, repo.listProjects)).map((x) => x.id)).toEqual([p]);
    });
  });

  describe("the Stripe webhook", () => {
    async function paidProject(name: string) {
      const w = await cardWorkspace(name);
      await endTrial(w.tenant);
      const p = await addProject(w.tenant, name);
      await reconcileProjects(deps, w.tenant);
      return { ...w, p, subId: subOf(w.tenant, p).id };
    }

    it("schedules a removal on a Billing Portal cancel, and clears it on a resume", async () => {
      const { tenant, p, subId } = await paidProject("Portal");
      stripe.set(subId, { cancelAtPeriodEnd: true });
      expect(await event(tenant, subId)).toBe("processed");
      const s = (await schedule(tenant, p))!;
      expect([s.source, s.activeUntil]).toEqual(["billing", stripe.subscriptions.get(subId)!.currentPeriodEnd]);
      // Reconcile leaves the cancel alone (the project is no longer billed).
      const writes = stripe.writes.length;
      await reconcileProjects(deps, tenant);
      expect(stripe.writes.length).toBe(writes);
      // An event with no change does nothing.
      await event(tenant, subId, "invoice.paid");
      expect(await schedule(tenant, p)).not.toBeNull();
      stripe.set(subId, { cancelAtPeriodEnd: false });
      await event(tenant, subId);
      expect(await schedule(tenant, p)).toBeNull();
    });

    it("keeps a removal made in Supahound when its own cancel echoes back", async () => {
      const { tenant, owner, p, subId } = await paidProject("Echo");
      const mine = (await remove(owner, tenant, p))!;
      await reconcileProjects(deps, tenant);
      await event(tenant, subId);
      expect(await schedule(tenant, p)).toEqual(mine);
    });

    it("does not undo a keep when the resume failed and an unrelated event arrives", async () => {
      const { tenant, owner, p, subId } = await paidProject("Failed resume");
      await remove(owner, tenant, p);
      await reconcileProjects(deps, tenant);
      await keep(owner, tenant, p);
      stripe.failNext.add("cancel");
      await expect(reconcileProjects(deps, tenant)).rejects.toThrow(/Stripe changes failed/);
      await event(tenant, subId, "invoice.upcoming");
      expect(await schedule(tenant, p)).toBeNull();
      await reconcileProjects(deps, tenant);
      expect(stripe.subscriptions.get(subId)!.cancelAtPeriodEnd).toBe(false);
    });

    it("never schedules a disconnected (paused) project", async () => {
      const { tenant, p, subId } = await paidProject("Paused");
      await db.admin.query("UPDATE supahound.projects SET paused = true WHERE tenant_id = $1 AND id = $2", [tenant, p]);
      stripe.set(subId, { cancelAtPeriodEnd: true });
      await event(tenant, subId);
      expect(await schedule(tenant, p)).toBeNull();
    });

    it("never schedules removals when the workspace closes, even if the webhook beats the close", async () => {
      const { tenant, owner, p, subId } = await paidProject("Closing");
      // The webhook arrives while closeWorkspace waits for Stripe, before the closure is recorded.
      const racing: Pick<StripeGateway, "setCancelAtPeriodEnd"> = {
        setCancelAtPeriodEnd: async (id, cancel, o) => {
          const r = await stripe.setCancelAtPeriodEnd(id, cancel, o);
          await event(tenant, id);
          return r;
        },
      };
      expect(await closeWorkspace({ pool: db.app, stripe: racing, now: () => new Date() }, { user: owner, tenant, typedName: "Closing" })).toBe("closed");
      expect(stripe.subscriptions.get(subId)!.cancelAtPeriodEnd).toBe(true);
      expect(await schedule(tenant, p)).toBeNull();
      // A later event after the close changes nothing either.
      await event(tenant, subId, "invoice.upcoming");
      expect(await schedule(tenant, p)).toBeNull();
    });
  });
});
