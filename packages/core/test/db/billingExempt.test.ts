import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { startCheckout, type StripeGateway } from "../../src/billing/flow.js";
import { getBilling, grantExemption, PaymentRequiredError, withPaidTenantForUser } from "../../src/db/billing.js";
import * as repo from "../../src/db/repo.js";
import { withTenant } from "../../src/db/tenant.js";
import { createWorkspace, withTenantForUser } from "../../src/db/user.js";
import type { TenantId, UserId } from "../../src/tenancy/scope.js";
import { verifiedUserId } from "../../src/tenancy/scope.js";
import { pgInfo, useDb } from "./harness.js";

// Staff workspaces without billing (decision 029), against real Postgres with forced RLS. The
// caller checks the email domain (policy.test.ts); these tests cover the sole-owner rule, the
// membership trigger and the scheduler.

describe.skipIf(pgInfo === null)("staff exemption from billing", () => {
  const db = useDb();
  const staff = verifiedUserId(randomUUID());
  const customer = verifiedUserId(randomUUID());

  const user = () => verifiedUserId(randomUUID());
  const grant = (t: TenantId, u: UserId) => withTenantForUser(db.app, u, t, (tx) => grantExemption(tx, u, new Date()));
  const billing = (t: TenantId) => withTenant(db.app, t, getBilling);
  const gate = (t: TenantId, u: UserId) => withPaidTenantForUser(db.app, "stripe", u, t, async (_tx, _role, access) => access);
  // Membership writes run as the app role inside the tenant, the way the web app makes them.
  const addMember = (t: TenantId, u: UserId, role: "owner" | "admin" | "member") =>
    withTenant(db.app, t, (tx) => tx.query("INSERT INTO supahound.memberships (tenant_id, user_id, role) VALUES ($1, $2, $3)", [t, u, role]));
  const setRole = (t: TenantId, u: UserId, role: "owner" | "admin" | "member") =>
    withTenant(db.app, t, (tx) => tx.query("UPDATE supahound.memberships SET role = $3 WHERE tenant_id = $1 AND user_id = $2", [t, u, role]));
  const removeMember = (t: TenantId, u: UserId) =>
    withTenant(db.app, t, (tx) => tx.query("DELETE FROM supahound.memberships WHERE tenant_id = $1 AND user_id = $2", [t, u]));

  it("opens a workspace whose sole owner was granted the exemption, with no card", async () => {
    const t = await createWorkspace(db.app, staff, "Staff");
    await expect(gate(t, staff)).rejects.toBeInstanceOf(PaymentRequiredError);
    expect(await grant(t, staff)).toBe(true);
    expect(await gate(t, staff)).toBe("full");
    const b = await billing(t);
    expect(b).toMatchObject({ exempt: true, status: "none", subscriptionId: null, customerId: null });
    expect(b.exemptAt).toBeInstanceOf(Date);
  });

  it("refuses the exemption to anyone who is not the sole owner", async () => {
    const t = await createWorkspace(db.app, customer, "Customer");
    const admin = user();
    const member = user();
    await addMember(t, admin, "admin");
    await addMember(t, member, "member");
    for (const u of [admin, member]) expect(await grant(t, u)).toBe(false);
    expect((await billing(t)).exempt).toBe(false);
    await expect(gate(t, customer)).rejects.toBeInstanceOf(PaymentRequiredError);
  });

  it("refuses the exemption when the workspace has two owners", async () => {
    const t = await createWorkspace(db.app, customer, "Two owners");
    const staffOwner = user();
    await addMember(t, staffOwner, "owner");
    expect(await grant(t, staffOwner)).toBe(false);
    await expect(gate(t, staffOwner)).rejects.toBeInstanceOf(PaymentRequiredError);
  });

  it.each([
    ["a second owner joins", async (t: TenantId) => addMember(t, user(), "owner")],
    ["another member becomes an owner", async (t: TenantId) => {
      const m = user();
      await addMember(t, m, "member");
      await setRole(t, m, "owner");
    }],
    ["ownership moves to someone else", async (t: TenantId) => {
      const next = user();
      await addMember(t, next, "admin");
      await setRole(t, next, "owner");
      await setRole(t, staff, "admin");
    }],
  ])("ends the exemption when %s", async (_name, change) => {
    const t = await createWorkspace(db.app, staff, "Handed over");
    expect(await grant(t, staff)).toBe(true);
    await change(t);
    // The gate's own check and the stored columns (cleared by the trigger) agree.
    await expect(gate(t, staff)).rejects.toBeInstanceOf(PaymentRequiredError);
    const [row] = (await db.admin.query("SELECT exempt_owner, exempt_at FROM supahound.billing_accounts WHERE tenant_id = $1", [t])).rows;
    expect(row).toEqual({ exempt_owner: null, exempt_at: null });
  });

  it("keeps the exemption when a non-owner joins or leaves", async () => {
    const t = await createWorkspace(db.app, staff, "Team");
    expect(await grant(t, staff)).toBe(true);
    const m = user();
    await addMember(t, m, "admin");
    await removeMember(t, m);
    expect(await gate(t, staff)).toBe("full");
    expect(await gate(t, staff)).toBe("full");
  });

  it("refuses a stale exemption at the gate even if the stored columns were not cleared", async () => {
    const t = await createWorkspace(db.app, staff, "Stale");
    expect(await grant(t, staff)).toBe(true);
    // Bypass the trigger, as a failure of it would: add a second owner as the superuser with triggers off.
    await db.admin.query("ALTER TABLE supahound.memberships DISABLE TRIGGER memberships_end_stale_billing_exemption");
    try {
      await db.admin.query("INSERT INTO supahound.memberships (tenant_id, user_id, role) VALUES ($1, $2, 'owner')", [t, user()]);
    } finally {
      await db.admin.query("ALTER TABLE supahound.memberships ENABLE TRIGGER memberships_end_stale_billing_exemption");
    }
    expect((await db.admin.query("SELECT exempt_at FROM supahound.billing_accounts WHERE tenant_id = $1", [t])).rows[0].exempt_at).not.toBeNull();
    await expect(gate(t, staff)).rejects.toBeInstanceOf(PaymentRequiredError);
  });

  it("never sends an exempt workspace to Stripe Checkout", async () => {
    const t = await createWorkspace(db.app, staff, "No checkout");
    expect(await grant(t, staff)).toBe(true);
    const calls: string[] = [];
    const stripe = new Proxy({}, { get: (_o, name) => () => { calls.push(String(name)); throw new Error("no Stripe call expected"); } }) as StripeGateway;
    const next = await startCheckout(
      { pool: db.app, stripe, appUrl: "https://app.supahound.test", now: () => new Date() },
      { user: staff, email: null, tenant: t, acceptedTerms: true },
    );
    expect(next).toBe(`/w/${t}`);
    expect(calls).toEqual([]);
  });

  it("lets the scheduler poll an exempt workspace, and stop when the exemption ends", async () => {
    const t = await createWorkspace(db.app, staff, "Polled staff");
    await withTenant(db.app, t, async (tx) => {
      const conn = await repo.createConnection(tx, db.vault, { label: "org", token: "tok" });
      await repo.createProject(tx, { connectionId: conn, supabaseRef: "exemptref0000000000a", name: "app" });
    });
    const due = async () => (await repo.dueProjects(db.scheduler, 60, 1000, "stripe")).map((s) => s.tenantId);
    expect(await due()).not.toContain(t);
    expect(await grant(t, staff)).toBe(true);
    expect(await due()).toContain(t);
    // The scheduler role still cannot read who is exempt, only when.
    await expect(db.scheduler.query("SELECT exempt_owner FROM supahound.billing_accounts")).rejects.toThrow(/permission denied/);
    await addMember(t, user(), "owner");
    expect(await due()).not.toContain(t);
  });
});
