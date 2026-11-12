import { randomUUID } from "node:crypto";
import { beforeAll, describe, expect, it } from "vitest";
import { startCheckout, type FlowDeps, type StripeGateway } from "../../src/billing/flow.js";
import { billedTiers, getBilling, isPaying, projectTiers, saveSubscription, withPaidTenantForUser, type SubscriptionSnapshot } from "../../src/db/billing.js";
import { getClosure, purgeHistory, recordClosure, WorkspaceClosedError } from "../../src/db/closure.js";
import { storeConnection } from "../../src/db/connections.js";
import * as repo from "../../src/db/repo.js";
import { applyRetention } from "../../src/db/retention.js";
import { withTenant } from "../../src/db/tenant.js";
import { createWorkspace, NotAMemberError, withTenantForUser } from "../../src/db/user.js";
import { closeWorkspace, disconnectConnection, markRevoked, reopenClosedWorkspace, runDataJob } from "../../src/datacontrols/flow.js";
import { templateExplanation } from "../../src/explainer/template.js";
import { pollProject, type OutgoingEmail } from "../../src/poller/pollProject.js";
import { projectScope, verifiedUserId, type ConnectionId, type ProjectId, type TenantId, type UserId } from "../../src/tenancy/scope.js";
import { pgInfo, useDb, type Db } from "./harness.js";
import { seedFullTenant } from "./seedTenant.js";

// Data controls (issue #43, decision 037) against real Postgres with forced RLS: retention, close,
// purge, disconnect, revocation. Every deletion path is checked twice: it deletes for a workspace
// that does not pay, and deletes nothing for one that does (active, past_due, staff-exempt). Every
// destructive step is checked against a second tenant that must stay exactly as it was.

const DAY = 86_400_000;
const NOW = new Date("2026-12-31T12:00:00Z");
const ago = (days: number, extraMs = 0) => new Date(NOW.getTime() - days * DAY - extraMs);
const later = (from: Date, days: number) => new Date(from.getTime() + days * DAY);

// Every tenant table in the schema, with its tenant column, read from the catalog.
async function tenantTables(db: Db): Promise<{ table: string; column: string }[]> {
  const res = await db.admin.query<{ relname: string; col: string }>(`
    SELECT c.relname, CASE WHEN c.relname = 'tenants' THEN 'id' ELSE 'tenant_id' END AS col
    FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'supahound' AND c.relkind = 'r'
      AND (c.relname = 'tenants' OR EXISTS (SELECT 1 FROM pg_attribute a WHERE a.attrelid = c.oid AND a.attname = 'tenant_id' AND NOT a.attisdropped))
    ORDER BY 1`);
  return res.rows.map((r) => ({ table: r.relname, column: r.col }));
}

async function rowCounts(db: Db, tenant: TenantId): Promise<Record<string, number>> {
  const out: Record<string, number> = {};
  for (const { table, column } of await tenantTables(db)) {
    const r = await db.admin.query<{ n: number }>(`SELECT count(*)::int AS n FROM supahound.${table} WHERE ${column} = $1`, [tenant]);
    out[table] = r.rows[0]!.n;
  }
  return out;
}

let refN = 0;
const nextRef = () => `dcref${String(++refN).padStart(6, "0")}${Math.random().toString(36).slice(2, 11).padEnd(9, "x")}`.slice(0, 20);

interface Workspace {
  tenant: TenantId;
  owner: UserId;
  admin: UserId;
  member: UserId;
  connection: ConnectionId;
  project: ProjectId;
  ref: string;
}

const CREDS = { accessToken: "access-1", refreshToken: "refresh-1", expiresAt: null };

async function workspace(db: Db, name: string, token: unknown = CREDS): Promise<Workspace> {
  const owner = verifiedUserId(randomUUID());
  const admin = verifiedUserId(randomUUID());
  const member = verifiedUserId(randomUUID());
  const slug = name.toLowerCase().replace(/\W/g, "");
  const tenant = await createWorkspace(db.app, owner, name, `${slug}-owner@example.com`);
  await db.admin.query(
    "INSERT INTO supahound.memberships (tenant_id, user_id, role, email) VALUES ($1, $2, 'admin', $4), ($1, $3, 'member', $5)",
    [tenant, admin, member, `${slug}-admin@example.com`, `${slug}-member@example.com`],
  );
  const ref = nextRef();
  const { connection, project } = await withTenant(db.app, tenant, async (tx) => {
    const connection = await repo.createConnection(tx, db.vault, { label: "Supabase", token: typeof token === "string" ? token : JSON.stringify(token) });
    const project = await repo.createProject(tx, { connectionId: connection, supabaseRef: ref, name: `${name} app` });
    return { connection, project };
  });
  await db.admin.query("INSERT INTO supahound.project_members (tenant_id, project_id, user_id, role) VALUES ($1, $2, $3, 'viewer')", [tenant, project, member]);
  return { tenant, owner, admin, member, connection, project, ref };
}

async function incident(db: Db, w: Workspace, status: "open" | "resolved", lastSeen: Date): Promise<string> {
  return withTenant(db.app, w.tenant, (tx) => repo.upsertIncident(tx, w.project, {
    id: null, status, actor: `user:${randomUUID()}`, severity: "high", detectors: ["cross_tenant"], signals: ["other_owner"],
    findingCount: 1, hits: 3, openedAt: lastSeen, lastSeenAt: lastSeen,
  }));
}

async function run(db: Db, w: Workspace, at: Date, opts: { status?: "ok" | "unable_to_assess" | "running"; finding?: string | null } = {}): Promise<string> {
  const id = await withTenant(db.app, w.tenant, async (tx) => {
    const id = await repo.startPollRun(tx, w.project, { start: new Date(at.getTime() - 60_000), end: at });
    if (opts.status !== "running") await repo.finishPollRun(tx, id, { status: opts.status ?? "ok", templates: 1, findings: 0 });
    if (opts.finding !== undefined) {
      await repo.insertFindings(tx, w.project, id, [{
        detector: "cross_tenant", severity: "high", actor: "user:x", signals: ["other_owner"], hits: 1,
        firstSeen: at.toISOString(), lastSeen: at.toISOString(), evidence: { table: "notes" }, incidentId: opts.finding,
      }]);
    }
    return id;
  });
  await db.admin.query("UPDATE supahound.poll_runs SET started_at = $2 WHERE id = $1", [id, at]);
  await db.admin.query("UPDATE supahound.findings SET created_at = $2 WHERE poll_run_id = $1", [id, at]);
  return id;
}

// Old history in every table retention reaches: an old resolved incident, its finding and run,
// and a newer run so the old one is not the latest.
async function oldHistory(db: Db, w: Workspace): Promise<void> {
  const old = await incident(db, w, "resolved", ago(60));
  await run(db, w, ago(60), { finding: old });
  await run(db, w, ago(50));
  await run(db, w, ago(1));
}

const historyCount = async (db: Db, t: TenantId) => (await db.admin.query<{ i: number; f: number; r: number }>(
  `SELECT (SELECT count(*)::int FROM supahound.incidents WHERE tenant_id = $1) AS i,
          (SELECT count(*)::int FROM supahound.findings WHERE tenant_id = $1) AS f,
          (SELECT count(*)::int FROM supahound.poll_runs WHERE tenant_id = $1) AS r`, [t])).rows[0]!;

const exists = async (db: Db, table: string, id: string) =>
  (await db.admin.query(`SELECT 1 FROM supahound.${table} WHERE id = $1`, [id])).rows.length === 1;

// The three ways a workspace pays (decision 037), set straight in the database.
type PayingKind = "active" | "past_due" | "exempt";
async function makePaying(db: Db, w: Workspace, kind: PayingKind): Promise<void> {
  await db.admin.query("INSERT INTO supahound.billing_accounts (tenant_id) VALUES ($1) ON CONFLICT DO NOTHING", [w.tenant]);
  if (kind === "exempt") {
    await db.admin.query("UPDATE supahound.billing_accounts SET exempt_owner = $2, exempt_at = now() WHERE tenant_id = $1", [w.tenant, w.owner]);
  } else {
    await db.admin.query("UPDATE supahound.billing_accounts SET status = $2 WHERE tenant_id = $1", [w.tenant, kind]);
  }
}
const stopPaying = (db: Db, w: Workspace) =>
  db.admin.query("UPDATE supahound.billing_accounts SET status = 'canceled', exempt_owner = NULL, exempt_at = NULL WHERE tenant_id = $1", [w.tenant]);

class FakeStripe implements Pick<StripeGateway, "setCancelAtPeriodEnd"> {
  calls: { id: string; cancel: boolean }[] = [];
  subs = new Map<string, SubscriptionSnapshot>();
  fail = false;
  async setCancelAtPeriodEnd(id: string, cancel: boolean): Promise<SubscriptionSnapshot> {
    if (this.fail) throw new Error("stripe down");
    this.calls.push({ id, cancel });
    const s = this.subs.get(id)!;
    s.cancelAtPeriodEnd = cancel;
    return { ...s };
  }
}

async function subscribe(db: Db, w: Workspace, stripe: FakeStripe, periodEnd: Date, status: "active" | "trialing" = "active"): Promise<string> {
  const id = `sub_${w.tenant.replace(/-/g, "").slice(0, 16)}`;
  const s: SubscriptionSnapshot = {
    id, customerId: `cus_${w.tenant.replace(/-/g, "").slice(0, 16)}`, status, seats: { starter: 1, pro: 0 },
    trialEnd: status === "trialing" ? periodEnd : null, currentPeriodEnd: periodEnd, cancelAtPeriodEnd: false,
  };
  stripe.subs.set(id, s);
  await withTenant(db.app, w.tenant, (tx) => saveSubscription(tx, s, ago(1)));
  return id;
}

describe.skipIf(pgInfo === null)("incident retention (decision 037)", () => {
  const db = useDb();
  let a: Workspace;
  let b: Workspace;

  beforeAll(async () => {
    a = await workspace(db, "Retain A");
    b = await workspace(db, "Retain B");
  });

  it("resolves an open incident idle past 30 days and deletes it; keeps one inside the window", async () => {
    const stale = await incident(db, a, "open", ago(31));
    const fresh = await incident(db, a, "open", ago(29));
    const result = await withTenant(db.app, a.tenant, (tx) => applyRetention(tx, NOW, { deleteHistory: true }));
    expect(result.resolved).toBe(1);
    expect(await exists(db, "incidents", stale)).toBe(false);
    expect((await db.admin.query("SELECT status FROM supahound.incidents WHERE id = $1", [fresh])).rows).toEqual([{ status: "open" }]);
  });

  it("deletes a resolved incident last seen more than 30 days ago, to the second", async () => {
    const edge = await incident(db, a, "resolved", ago(30));
    const past = await incident(db, a, "resolved", ago(30, 1000));
    await withTenant(db.app, a.tenant, (tx) => applyRetention(tx, NOW, { deleteHistory: true }));
    expect(await exists(db, "incidents", edge)).toBe(true);
    expect(await exists(db, "incidents", past)).toBe(false);
  });

  it("deletes findings older than 30 days, also those of an incident still in the window", async () => {
    const live = await incident(db, a, "open", ago(1));
    await run(db, a, ago(31), { finding: live });
    await run(db, a, ago(2), { finding: live });
    await withTenant(db.app, a.tenant, (tx) => applyRetention(tx, NOW, { deleteHistory: true }));
    const f = await db.admin.query<{ created_at: Date }>("SELECT created_at FROM supahound.findings WHERE tenant_id = $1", [a.tenant]);
    expect(f.rows.map((r) => r.created_at)).toEqual([ago(2)]);
  });

  it("deletes old poll runs but keeps the latest run, the latest good run and runs still holding findings", async () => {
    const w = await workspace(db, "Runs");
    const oldOk = await run(db, w, ago(60));
    const lastOk = await run(db, w, ago(45));
    const lastRun = await run(db, w, ago(40), { status: "unable_to_assess" });
    const stillRunning = await run(db, w, ago(50), { status: "running" });
    const result = await withTenant(db.app, w.tenant, (tx) => applyRetention(tx, NOW, { deleteHistory: true }));
    expect(result.pollRuns).toBe(1);
    expect(await exists(db, "poll_runs", oldOk)).toBe(false);
    expect([await exists(db, "poll_runs", lastOk), await exists(db, "poll_runs", lastRun), await exists(db, "poll_runs", stillRunning)])
      .toEqual([true, true, true]);
    expect(await withTenant(db.app, w.tenant, (tx) => repo.lastAssessedUntil(tx, w.project))).toEqual(ago(45));
  });

  it("deletes expired OAuth states and keeps live ones", async () => {
    const hash = (c: string) => c.repeat(64);
    await withTenant(db.app, a.tenant, async (tx) => {
      await repo.createOAuthState(tx, { userId: a.owner, stateHash: hash("a"), codeVerifier: "v".repeat(64), expiresAt: ago(0, 1000) });
      await repo.createOAuthState(tx, { userId: a.owner, stateHash: hash("b"), codeVerifier: "v".repeat(64), expiresAt: later(NOW, 1) });
    });
    await withTenant(db.app, a.tenant, (tx) => applyRetention(tx, NOW, { deleteHistory: true }));
    const left = await db.admin.query<{ state_hash: string }>("SELECT state_hash FROM supahound.oauth_states WHERE tenant_id = $1", [a.tenant]);
    expect(left.rows.map((r) => r.state_hash)).toEqual([hash("b")]);
  });

  it.each(["active", "past_due", "exempt"] as const)("deletes no history of a workspace that pays (%s)", async (kind) => {
    const w = await workspace(db, `Paying ${kind}`);
    await makePaying(db, w, kind);
    await oldHistory(db, w);
    const before = await historyCount(db, w.tenant);
    const out = await runDataJob(db.app, w.tenant, NOW);
    expect(out).toMatchObject({ paying: true, retention: { incidents: 0, findings: 0, pollRuns: 0 } });
    expect(await historyCount(db, w.tenant)).toEqual(before);
  });

  it("deletes the same history for a trialing workspace (a trial that never paid does not count)", async () => {
    const w = await workspace(db, "Trialing");
    await db.admin.query("INSERT INTO supahound.billing_accounts (tenant_id, status) VALUES ($1, 'trialing')", [w.tenant]);
    await oldHistory(db, w);
    expect(await withTenant(db.app, w.tenant, isPaying)).toBe(false);
    expect(await runDataJob(db.app, w.tenant, NOW)).toMatchObject({ paying: false, retention: { incidents: 1, findings: 1, pollRuns: 2 } });
  });

  it("never touches another tenant's rows", async () => {
    await oldHistory(db, b);
    const before = await rowCounts(db, b.tenant);
    expect(await runDataJob(db.app, a.tenant, NOW)).toMatchObject({ paying: false });
    expect(await rowCounts(db, b.tenant)).toEqual(before);
  });

  it("lists every tenant with a project for the daily job, paid or not", async () => {
    expect(await repo.dataJobTenants(db.scheduler, NOW)).toEqual(expect.arrayContaining([a.tenant, b.tenant]));
  });
});

describe.skipIf(pgInfo === null)("closing a workspace (decision 037)", () => {
  const db = useDb();
  let stripe: FakeStripe;
  const now = new Date();
  const deps = () => ({ pool: db.app, stripe, now: () => now });

  beforeAll(() => {
    stripe = new FakeStripe();
  });

  it("only the workspace owner closes, and only with the exact name", async () => {
    const w = await workspace(db, "Close Me");
    await subscribe(db, w, stripe, later(now, 10));
    for (const user of [w.admin, w.member]) {
      expect(await closeWorkspace(deps(), { user, tenant: w.tenant, typedName: "Close Me" })).toBe("role");
    }
    expect(await closeWorkspace(deps(), { user: w.owner, tenant: w.tenant, typedName: "close me" })).toBe("mismatch");
    expect(stripe.calls).toEqual([]);
    expect(await withTenant(db.app, w.tenant, getClosure)).toBeNull();
  });

  it("refuses a closure written directly by an admin (RLS)", async () => {
    const w = await workspace(db, "Admin Close");
    await expect(withTenantForUser(db.app, w.admin, w.tenant, (tx) => recordClosure(tx, w.admin, now, now))).rejects.toThrow(/row-level security/);
  });

  it("cancels Stripe at the end of the period; the workspace works and polls until then, then closes", async () => {
    const w = await workspace(db, "Closing Co");
    const periodEnd = later(now, 10);
    const sub = await subscribe(db, w, stripe, periodEnd);
    await db.admin.query(
      `INSERT INTO supahound.project_invites (tenant_id, project_id, email, role, token_hash, invited_by, expires_at)
       VALUES ($1, $2, 'guest@example.com', 'viewer', $3, $4, now() + interval '7 days')`,
      [w.tenant, w.project, "c".repeat(64), w.owner],
    );

    expect(await closeWorkspace(deps(), { user: w.owner, tenant: w.tenant, typedName: " Closing Co " })).toBe("closed");
    expect(stripe.calls).toEqual([{ id: sub, cancel: true }]);
    expect(await closeWorkspace(deps(), { user: w.owner, tenant: w.tenant, typedName: "Closing Co" })).toBe("already_closed");
    expect(stripe.calls).toHaveLength(1);

    const closure = await withTenant(db.app, w.tenant, getClosure);
    expect(closure).toMatchObject({ closedAt: now, closedBy: w.owner, accessEndsAt: periodEnd, purgeAfter: later(periodEnd, 30), purgedAt: null });
    const billing = await withTenant(db.app, w.tenant, getBilling);
    expect([billing.status, billing.cancelAtPeriodEnd]).toEqual(["active", true]);
    expect((await db.admin.query("SELECT count(*)::int AS n FROM supahound.project_invites WHERE tenant_id = $1 AND canceled_at IS NULL", [w.tenant])).rows[0].n).toBe(0);

    // Until the period ends: usable, polled.
    expect(await withPaidTenantForUser(db.app, "stripe", w.member, w.tenant, async () => "open")).toBe("open");
    expect((await repo.dueProjects(db.scheduler, 0, 1000, "stripe")).some((s) => s.tenantId === w.tenant)).toBe(true);
    // The period ends.
    await db.admin.query(
      "UPDATE supahound.account_closures SET closed_at = now() - interval '1 day', access_ends_at = now() - interval '1 second' WHERE tenant_id = $1",
      [w.tenant],
    );
    for (const mode of ["off", "stripe"] as const) {
      await expect(withPaidTenantForUser(db.app, mode, w.member, w.tenant, async () => "ran")).rejects.toBeInstanceOf(WorkspaceClosedError);
      expect((await repo.dueProjects(db.scheduler, 0, 1000, mode)).some((s) => s.tenantId === w.tenant)).toBe(false);
    }
    // A replayed "Add card" form starts no checkout.
    const never = new Proxy({}, { get: () => () => { throw new Error("no Stripe call expected"); } }) as StripeGateway;
    const flow: FlowDeps = { pool: db.app, stripe: never, appUrl: "https://app.test", now: () => now };
    expect(await startCheckout(flow, { user: w.owner, email: null, tenant: w.tenant, acceptedTerms: true })).toBe(`/w/${w.tenant}/closed`);
  });

  it("closes at once with billing off, and ends a staff exemption", async () => {
    const off = await workspace(db, "Billing Off");
    expect(await closeWorkspace({ ...deps(), stripe: null }, { user: off.owner, tenant: off.tenant, typedName: "Billing Off" })).toBe("closed");
    expect((await withTenant(db.app, off.tenant, getClosure))!.accessEndsAt).toEqual(now);
    const staff = await workspace(db, "Staff");
    await makePaying(db, staff, "exempt");
    expect(await withTenant(db.app, staff.tenant, isPaying)).toBe(true);
    expect(await closeWorkspace({ ...deps(), stripe: null }, { user: staff.owner, tenant: staff.tenant, typedName: "Staff" })).toBe("closed");
    expect(await withTenant(db.app, staff.tenant, isPaying)).toBe(false);
    expect((await withTenant(db.app, staff.tenant, getClosure))!.accessEndsAt).toEqual(now);
  });

  it("closes nothing when Stripe fails, so the owner can try again", async () => {
    const w = await workspace(db, "Stripe Down");
    await subscribe(db, w, stripe, later(now, 5));
    stripe.fail = true;
    try {
      await expect(closeWorkspace(deps(), { user: w.owner, tenant: w.tenant, typedName: "Stripe Down" })).rejects.toThrow(/stripe down/);
    } finally {
      stripe.fail = false;
    }
    expect(await withTenant(db.app, w.tenant, getClosure)).toBeNull();
    expect(await closeWorkspace(deps(), { user: w.owner, tenant: w.tenant, typedName: "Stripe Down" })).toBe("closed");
  });

  it("lets only the owner reopen before the purge, and resumes a pending Stripe cancel", async () => {
    const w = await workspace(db, "Reopen");
    const sub = await subscribe(db, w, stripe, later(now, 10));
    await closeWorkspace(deps(), { user: w.owner, tenant: w.tenant, typedName: "Reopen" });
    expect(await reopenClosedWorkspace(deps(), { user: w.admin, tenant: w.tenant })).toBe("role");
    await withTenantForUser(db.app, w.admin, w.tenant, (tx) => tx.query("DELETE FROM supahound.account_closures WHERE tenant_id = $1", [w.tenant]));
    expect(await withTenant(db.app, w.tenant, getClosure)).not.toBeNull();

    stripe.calls.length = 0;
    expect(await reopenClosedWorkspace(deps(), { user: w.owner, tenant: w.tenant })).toBe("reopened");
    expect(stripe.calls).toEqual([{ id: sub, cancel: false }]);
    expect((await withTenant(db.app, w.tenant, getBilling)).cancelAtPeriodEnd).toBe(false);
    expect(await reopenClosedWorkspace(deps(), { user: w.owner, tenant: w.tenant })).toBe("not_closed");

    await closeWorkspace(deps(), { user: w.owner, tenant: w.tenant, typedName: "Reopen" });
    await db.admin.query("UPDATE supahound.account_closures SET purged_at = now() WHERE tenant_id = $1", [w.tenant]);
    expect(await reopenClosedWorkspace(deps(), { user: w.owner, tenant: w.tenant })).toBe("too_late");
  });

  it("never deletes a tenant row or a closure after the purge, from any transaction", async () => {
    const w = await workspace(db, "Keep Me");
    await withTenant(db.app, w.tenant, (tx) => recordClosure(tx, w.owner, now, now));
    await db.admin.query("UPDATE supahound.account_closures SET purged_at = now() WHERE tenant_id = $1", [w.tenant]);
    const tryDelete = async (t: { query: (sql: string, p: unknown[]) => Promise<unknown> }) => {
      await t.query("DELETE FROM supahound.account_closures WHERE tenant_id = $1", [w.tenant]);
      await t.query("DELETE FROM supahound.tenants WHERE id = $1", [w.tenant]);
    };
    await withTenant(db.app, w.tenant, tryDelete);
    await withTenantForUser(db.app, w.owner, w.tenant, tryDelete);
    expect((await db.admin.query("SELECT 1 FROM supahound.tenants WHERE id = $1", [w.tenant])).rows).toHaveLength(1);
    expect((await db.admin.query("SELECT 1 FROM supahound.account_closures WHERE tenant_id = $1", [w.tenant])).rows).toHaveLength(1);
  });
});

describe.skipIf(pgInfo === null)("purging a closed workspace (decision 037)", () => {
  const db = useDb();
  const KEPT = ["account_closures", "audit_log", "billing_accounts", "memberships", "scan_authorizations", "scan_domains", "stripe_events", "tenants"];

  it("deletes the logs and history, keeps the record and payment history, and leaves the other tenant exactly as it was", async () => {
    const a = await seedFullTenant(db, "Leaving", "token-of-leaving");
    const b = await seedFullTenant(db, "Staying", "token-of-staying");
    const now = new Date();
    const before = (days: number) => new Date(now.getTime() - days * DAY);
    await withTenant(db.app, a.tenant, (tx) => recordClosure(tx, verifiedUserId(randomUUID()), before(31), before(31)));
    const aBefore = await rowCounts(db, a.tenant);
    const bBefore = await rowCounts(db, b.tenant);
    for (const [table, n] of Object.entries(aBefore)) expect([table, n > 0]).toEqual([table, true]);

    // Not before the date, even when called directly.
    expect(await withTenant(db.app, a.tenant, (tx) => purgeHistory(tx, before(2)))).toBe(false);
    expect(await rowCounts(db, a.tenant)).toEqual(aBefore);

    expect(await repo.dataJobTenants(db.scheduler, now)).toContain(a.tenant);
    expect(await runDataJob(db.app, a.tenant, now)).toMatchObject({ paying: false, purged: true });

    const aAfter = await rowCounts(db, a.tenant);
    for (const [table, n] of Object.entries(aAfter)) {
      expect([table, n]).toEqual([table, KEPT.includes(table) ? aBefore[table] : 0]);
    }
    expect(await rowCounts(db, b.tenant)).toEqual(bBefore);
    expect(await withTenant(db.app, b.tenant, (tx) => repo.openConnectionToken(tx, db.vault, b.connection))).toBe("token-of-staying");
    // Audit rows stay and lose their project link (decision 022).
    expect((await db.admin.query("SELECT count(*)::int AS n FROM supahound.audit_log WHERE tenant_id = $1 AND project_id IS NOT NULL", [a.tenant])).rows[0].n).toBe(0);
    expect((await withTenant(db.app, a.tenant, getClosure))!.purgedAt).toEqual(now);
    // A second run is a no-op, and the job no longer lists the tenant.
    expect(await runDataJob(db.app, a.tenant, now)).toMatchObject({ purged: false, retention: null });
    expect(await repo.dataJobTenants(db.scheduler, now)).not.toContain(a.tenant);
  });

  it.each(["active", "past_due", "exempt"] as const)("does not purge while the workspace pays (%s); purges 30 days after it stops", async (kind) => {
    const w = await workspace(db, `Paying close ${kind}`);
    await incident(db, w, "open", ago(1));
    // A closure that is due; inserted directly, so the payment state is the one under test.
    await db.admin.query(
      "INSERT INTO supahound.account_closures (tenant_id, closed_at, closed_by, access_ends_at, purge_after) VALUES ($1, $2, $3, $2, $4)",
      [w.tenant, ago(90), w.owner, ago(60)],
    );
    await makePaying(db, w, kind);
    expect(await runDataJob(db.app, w.tenant, NOW)).toMatchObject({ paying: true, purged: false });
    expect((await withTenant(db.app, w.tenant, getClosure))!.purgeAfter).toEqual(later(NOW, 30));
    expect((await historyCount(db, w.tenant)).i).toBe(1);

    await stopPaying(db, w);
    expect(await runDataJob(db.app, w.tenant, later(NOW, 29))).toMatchObject({ paying: false, purged: false });
    expect(await runDataJob(db.app, w.tenant, later(NOW, 30))).toMatchObject({ paying: false, purged: true });
    expect(await historyCount(db, w.tenant)).toEqual({ i: 0, f: 0, r: 0 });
  });
});

describe.skipIf(pgInfo === null)("disconnecting Supabase (decision 037)", () => {
  const db = useDb();
  const revoked: string[] = [];
  const now = new Date();
  const deps = (ok = true) => ({ pool: db.app, vault: db.vault, revoke: async (t: string) => { revoked.push(t); return ok; }, now: () => now });
  const token = async (w: Workspace) => (await db.admin.query<{ n: number }>("SELECT length(sealed_token) AS n FROM supahound.connections WHERE id = $1", [w.connection])).rows[0]?.n;

  it("only owners and admins disconnect, only with the exact label", async () => {
    const w = await workspace(db, "Disc Roles");
    const input = { tenant: w.tenant, connection: w.connection, typedLabel: "Supabase" };
    expect(await disconnectConnection(deps(), { ...input, user: w.member })).toMatchObject({ result: "role" });
    expect(await disconnectConnection(deps(), { ...input, user: w.owner, typedLabel: "supabase" })).toMatchObject({ result: "mismatch" });
    expect(revoked).toEqual([]);
    // A member writing to the connection directly is refused by RLS (no row matches).
    await withTenantForUser(db.app, w.member, w.tenant, async (tx) => {
      await tx.query("UPDATE supahound.connections SET sealed_token = ''::bytea WHERE tenant_id = $1", [w.tenant]);
      await tx.query("DELETE FROM supahound.connections WHERE tenant_id = $1", [w.tenant]);
    });
    expect(await token(w)).toBeGreaterThan(0);
    expect(await disconnectConnection(deps(), { ...input, user: w.admin })).toMatchObject({ result: "disconnected", revoked: true, projectsPaused: 1 });
  });

  it("empties the token, stops polling at once, revokes at Supabase, keeps the history, and names who to tell", async () => {
    const w = await workspace(db, "Disc Owner");
    const inc = await incident(db, w, "open", ago(1));
    const due = async () => (await repo.dueProjects(db.scheduler, 0, 1000, "off")).some((s) => s.projectId === w.project);
    expect(await due()).toBe(true);
    revoked.length = 0;
    const out = await disconnectConnection(deps(), { user: w.owner, tenant: w.tenant, connection: w.connection, typedLabel: "Supabase" });
    expect(out).toMatchObject({ result: "disconnected", revoked: true, projectsPaused: 1 });
    expect(out.notice).toMatchObject({
      label: "Supabase", projects: ["Disc Owner app"], paying: false, workspaceName: "Disc Owner", deleteAfter: later(now, 30),
      recipients: ["discowner-admin@example.com", "discowner-member@example.com", "discowner-owner@example.com"],
    });
    expect(revoked).toEqual(["refresh-1"]);
    expect(await token(w)).toBe(0);
    expect(await due()).toBe(false);
    expect(await exists(db, "incidents", inc)).toBe(true);
    // A paused project is kept but not watched, so it is not billed.
    expect(billedTiers(await withTenant(db.app, w.tenant, projectTiers))).toEqual([]);
    // The token is gone from every read path.
    await expect(withTenant(db.app, w.tenant, (tx) => repo.openConnectionToken(tx, db.vault, w.connection))).rejects.toThrow();
    expect(await withTenant(db.app, w.tenant, repo.listConnections)).toEqual([]);
    expect(await withTenant(db.app, w.tenant, repo.countConnections)).toBe(0);
    expect(await disconnectConnection(deps(), { user: w.owner, tenant: w.tenant, connection: w.connection, typedLabel: "Supabase" }))
      .toMatchObject({ result: "missing" });
  });

  it("deletes a connection with no project at once: nothing to keep", async () => {
    const w = await workspace(db, "Disc Empty");
    await db.admin.query("DELETE FROM supahound.projects WHERE id = $1", [w.project]);
    expect(await disconnectConnection(deps(), { user: w.owner, tenant: w.tenant, connection: w.connection, typedLabel: "Supabase" }))
      .toMatchObject({ result: "disconnected", projectsPaused: 0 });
    expect(await exists(db, "connections", w.connection)).toBe(false);
  });

  it("deletes the history 30 days later for a workspace that does not pay, and not a day before", async () => {
    const w = await workspace(db, "Disc Expire");
    const inc = await incident(db, w, "open", ago(1));
    await disconnectConnection(deps(), { user: w.owner, tenant: w.tenant, connection: w.connection, typedLabel: "Supabase" });
    expect(await runDataJob(db.app, w.tenant, later(now, 29))).toMatchObject({ connectionsDeleted: 0 });
    expect(await exists(db, "incidents", inc)).toBe(true);
    expect(await runDataJob(db.app, w.tenant, later(now, 30))).toMatchObject({ paying: false, connectionsDeleted: 1 });
    expect([await exists(db, "connections", w.connection), await exists(db, "projects", w.project), await exists(db, "incidents", inc)])
      .toEqual([false, false, false]);
  });

  it.each(["active", "past_due", "exempt"] as const)("keeps the history while the workspace pays (%s), then deletes it 30 days after", async (kind) => {
    const w = await workspace(db, `Disc Paying ${kind}`);
    await makePaying(db, w, kind);
    const inc = await incident(db, w, "open", ago(1));
    const out = await disconnectConnection(deps(), { user: w.owner, tenant: w.tenant, connection: w.connection, typedLabel: "Supabase" });
    expect(out.notice?.paying).toBe(true);
    const day40 = later(now, 40);
    expect(await runDataJob(db.app, w.tenant, day40)).toMatchObject({ paying: true, connectionsDeleted: 0 });
    expect(await exists(db, "incidents", inc)).toBe(true);
    await stopPaying(db, w);
    expect(await runDataJob(db.app, w.tenant, later(day40, 29))).toMatchObject({ connectionsDeleted: 0 });
    expect(await runDataJob(db.app, w.tenant, later(day40, 30))).toMatchObject({ connectionsDeleted: 1 });
    expect(await exists(db, "incidents", inc)).toBe(false);
  });

  it("reconnecting the same Supabase organization keeps the history and resumes polling; another organization does not", async () => {
    const w = await workspace(db, "Disc Back");
    const inc = await incident(db, w, "open", ago(1));
    await disconnectConnection(deps(), { user: w.owner, tenant: w.tenant, connection: w.connection, typedLabel: "Supabase" });
    const other = await withTenant(db.app, w.tenant, (tx) => storeConnection(tx, db.vault, "other-org-token", ["someotherref00000001"], now));
    expect(other.reattached).toBe(false);
    const back = await withTenant(db.app, w.tenant, (tx) => storeConnection(tx, db.vault, JSON.stringify(CREDS), [w.ref, "anotherref0000000002"], now));
    expect(back).toEqual({ connection: w.connection, reattached: true });
    expect(await withTenant(db.app, w.tenant, (tx) => repo.openConnectionToken(tx, db.vault, w.connection))).toBe(JSON.stringify(CREDS));
    expect(await exists(db, "incidents", inc)).toBe(true);
    expect((await repo.dueProjects(db.scheduler, 0, 1000, "off")).some((s) => s.projectId === w.project)).toBe(true);
    const [c] = (await db.admin.query("SELECT disconnected_at, delete_after FROM supahound.connections WHERE id = $1", [w.connection])).rows;
    expect(c).toEqual({ disconnected_at: null, delete_after: null });
  });

  it("cannot reach another tenant's connection, and leaves that tenant exactly as it was", async () => {
    const mine = await workspace(db, "Disc Mine");
    const theirs = await workspace(db, "Disc Theirs");
    const before = await rowCounts(db, theirs.tenant);
    expect(await disconnectConnection(deps(), { user: mine.owner, tenant: mine.tenant, connection: theirs.connection, typedLabel: "Supabase" }))
      .toMatchObject({ result: "missing" });
    await expect(disconnectConnection(deps(), { user: mine.owner, tenant: theirs.tenant, connection: theirs.connection, typedLabel: "Supabase" }))
      .rejects.toBeInstanceOf(NotAMemberError);
    await runDataJob(db.app, mine.tenant, later(now, 60));
    expect(await rowCounts(db, theirs.tenant)).toEqual(before);
  });
});

describe.skipIf(pgInfo === null)("a grant revoked outside Supahound (decision 037)", () => {
  const db = useDb();
  const EXPIRED = { accessToken: "access-old", refreshToken: "refresh-old", expiresAt: "2000-01-01T00:00:00Z" };

  function tokenEndpoint(status: number, body: unknown) {
    return (async () => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } })) as unknown as typeof fetch;
  }

  async function poll(w: Workspace, fetchImpl: typeof fetch, sent: OutgoingEmail[]) {
    return pollProject(projectScope(w.tenant, w.project), {
      app: db.app, vault: db.vault, now: () => new Date(),
      oauth: { clientId: "client", clientSecret: "secret", redirectUri: "https://app.test/cb", fetch: fetchImpl },
      queryLogs: async () => [],
      queryPolicies: async () => [],
      explain: async (f) => ({ explanation: templateExplanation(f), source: "template", model: null, zdrConfirmed: null, attempts: [] }),
      alerts: { send: async (m) => { sent.push(m); }, from: { email: "alerts@supahound.test", name: "Supahound" }, appUrl: "https://app.test" },
    });
  }

  it("marks the connection on invalid_grant, stops polling, and emails each member once", async () => {
    const w = await workspace(db, "Revoked", EXPIRED);
    const sent: OutgoingEmail[] = [];
    expect(await poll(w, tokenEndpoint(400, { error: "invalid_grant" }), sent)).toEqual({ status: "unable_to_assess", errorCode: "grant_revoked" });
    expect(sent.map((m) => m.to).sort()).toEqual(["revoked-admin@example.com", "revoked-member@example.com", "revoked-owner@example.com"]);
    expect(sent[0]!.subject).toBe("Supahound lost access to Supabase for Revoked");
    expect(sent[0]!.text).toContain("Reconnect Supabase within 30 days");
    const [c] = (await db.admin.query("SELECT disconnect_reason, length(sealed_token) AS n FROM supahound.connections WHERE id = $1", [w.connection])).rows;
    expect(c).toEqual({ disconnect_reason: "revoked", n: 0 });
    // The next poll skips the paused project: no second email.
    await db.admin.query("UPDATE supahound.projects SET last_polled_at = NULL WHERE id = $1", [w.project]);
    expect(await poll(w, tokenEndpoint(400, { error: "invalid_grant" }), sent)).toEqual({ status: "skipped", reason: "paused" });
    expect(sent).toHaveLength(3);
    // A second worker that saw the same revocation marks nothing and so sends nothing.
    expect(await withTenant(db.app, w.tenant, (tx) => markRevoked(tx, w.connection, new Date()))).toBeNull();
    const audit = (await db.admin.query("SELECT detail FROM supahound.audit_log WHERE tenant_id = $1 AND action = 'alert_email'", [w.tenant])).rows;
    expect(audit).toEqual([{ detail: expect.objectContaining({ kind: "access_revoked", recipients: 3, sent: 3, failed: 0 }) }]);
  });

  it.each([
    ["a 503", 503, { error: "temporarily_unavailable" }],
    ["a 500 with invalid_grant", 500, { error: "invalid_grant" }],
    ["our own bad client secret", 401, { error: "invalid_client" }],
    ["a 401 without a body code", 401, {}],
    ["a malformed request", 400, { error: "invalid_request" }],
  ])("does not count %s as a revocation", async (_name, status, body) => {
    const w = await workspace(db, `Transient ${status} ${JSON.stringify(body).length}`, EXPIRED);
    const sent: OutgoingEmail[] = [];
    expect(await poll(w, tokenEndpoint(status, body), sent)).toMatchObject({ status: "unable_to_assess" });
    expect(sent).toEqual([]);
    const [c] = (await db.admin.query("SELECT disconnected_at, length(sealed_token) > 0 AS has_token FROM supahound.connections WHERE id = $1", [w.connection])).rows;
    expect(c).toEqual({ disconnected_at: null, has_token: true });
  });
});
