import { randomUUID } from "node:crypto";
import { beforeAll, describe, expect, it } from "vitest";
import { startCheckout, type FlowDeps, type StripeGateway } from "../../src/billing/flow.js";
import { saveSubscription, withPaidTenantForUser, type SubscriptionSnapshot } from "../../src/db/billing.js";
import { getClosure, keptRecord, recordClosure, WorkspaceClosedError } from "../../src/db/closure.js";
import * as repo from "../../src/db/repo.js";
import { applyRetention } from "../../src/db/retention.js";
import { withTenant } from "../../src/db/tenant.js";
import { createWorkspace, NotAMemberError, withTenantForUser } from "../../src/db/user.js";
import { closeWorkspace, disconnectConnection, reopenClosedWorkspace, runDataJob } from "../../src/datacontrols/flow.js";
import { tenantId, verifiedUserId, type ConnectionId, type ProjectId, type TenantId, type UserId } from "../../src/tenancy/scope.js";
import { pgInfo, useDb, type Db } from "./harness.js";
import { seedFullTenant } from "./seedTenant.js";

// Data controls (issue #43, decision 037) against real Postgres with forced RLS: incident
// retention, closing and purging a workspace, disconnecting Supabase. Every destructive step is
// checked against a second tenant that must stay exactly as it was.

const DAY = 86_400_000;
const NOW = new Date("2026-12-31T12:00:00Z");
const ago = (days: number, extraMs = 0) => new Date(NOW.getTime() - days * DAY - extraMs);

// Every tenant table in the schema, with its tenant column, read from the catalog: a table added
// later is counted too.
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

const refOf = (n: number) => `retentionref${String(n).padStart(8, "0")}`;

interface Workspace {
  tenant: TenantId;
  owner: UserId;
  admin: UserId;
  member: UserId;
  connection: ConnectionId;
  project: ProjectId;
}

async function workspace(db: Db, name: string, token: unknown = "static-token"): Promise<Workspace> {
  const owner = verifiedUserId(randomUUID());
  const admin = verifiedUserId(randomUUID());
  const member = verifiedUserId(randomUUID());
  const tenant = await createWorkspace(db.app, owner, name, `${name.toLowerCase().replace(/\W/g, "")}@example.com`);
  await db.admin.query(
    "INSERT INTO supahound.memberships (tenant_id, user_id, role, email) VALUES ($1, $2, 'admin', 'admin@example.com'), ($1, $3, 'member', 'member@example.com')",
    [tenant, admin, member],
  );
  const { connection, project } = await withTenant(db.app, tenant, async (tx) => {
    const connection = await repo.createConnection(tx, db.vault, { label: "Supabase", token: typeof token === "string" ? token : JSON.stringify(token) });
    const project = await repo.createProject(tx, { connectionId: connection, supabaseRef: refOf(Math.floor(Math.random() * 1e8)), name: `${name} app` });
    return { connection, project };
  });
  return { tenant, owner, admin, member, connection, project };
}

async function incident(db: Db, w: Workspace, status: "open" | "resolved", lastSeen: Date, actor = randomUUID()): Promise<string> {
  return withTenant(db.app, w.tenant, (tx) => repo.upsertIncident(tx, w.project, {
    id: null, status, actor: `user:${actor}`, severity: "high", detectors: ["cross_tenant"], signals: ["other_owner"],
    findingCount: 1, hits: 3, openedAt: lastSeen, lastSeenAt: lastSeen,
  }));
}

// A finished poll run that started `at`, with an optional finding created then.
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

const exists = async (db: Db, table: string, id: string) =>
  (await db.admin.query(`SELECT 1 FROM supahound.${table} WHERE id = $1`, [id])).rows.length === 1;

class CancelOnlyStripe implements Pick<StripeGateway, "cancelSubscription"> {
  canceled: string[] = [];
  customers = new Map<string, string>();
  fail = false;
  async cancelSubscription(id: string): Promise<SubscriptionSnapshot> {
    if (this.fail) throw new Error("stripe down");
    this.canceled.push(id);
    return { id, customerId: this.customers.get(id)!, status: "canceled", seats: { starter: 1, pro: 0 }, trialEnd: null, currentPeriodEnd: null, cancelAtPeriodEnd: false };
  }
}

async function subscribe(db: Db, w: Workspace, sub: string, customer: string, stripe?: CancelOnlyStripe): Promise<void> {
  stripe?.customers.set(sub, customer);
  await withTenant(db.app, w.tenant, async (tx) => {
    await saveSubscription(tx, {
      id: sub, customerId: customer, status: "trialing", seats: { starter: 1, pro: 0 },
      trialEnd: new Date(NOW.getTime() + 7 * DAY), currentPeriodEnd: null, cancelAtPeriodEnd: false,
    }, ago(1));
    await tx.query("UPDATE supahound.billing_accounts SET terms_version = 'terms-1', terms_accepted_at = $2 WHERE tenant_id = $1", [w.tenant, ago(1)]);
  });
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
    const result = await withTenant(db.app, a.tenant, (tx) => applyRetention(tx, NOW));
    expect(result.resolved).toBe(1);
    expect(await exists(db, "incidents", stale)).toBe(false);
    const kept = await db.admin.query("SELECT status FROM supahound.incidents WHERE id = $1", [fresh]);
    expect(kept.rows).toEqual([{ status: "open" }]);
  });

  it("deletes a resolved incident last seen more than 30 days ago, to the second", async () => {
    const edge = await incident(db, a, "resolved", ago(30));
    const past = await incident(db, a, "resolved", ago(30, 1000));
    await withTenant(db.app, a.tenant, (tx) => applyRetention(tx, NOW));
    expect(await exists(db, "incidents", edge)).toBe(true);
    expect(await exists(db, "incidents", past)).toBe(false);
  });

  it("deletes findings older than 30 days, also those of an incident still in the window", async () => {
    const live = await incident(db, a, "open", ago(1));
    await run(db, a, ago(31), { finding: live });
    await run(db, a, ago(2), { finding: live });
    await withTenant(db.app, a.tenant, (tx) => applyRetention(tx, NOW));
    const f = await db.admin.query<{ created_at: Date }>("SELECT created_at FROM supahound.findings WHERE tenant_id = $1", [a.tenant]);
    expect(f.rows.map((r) => r.created_at)).toEqual([ago(2)]);
    expect(await exists(db, "incidents", live)).toBe(true);
  });

  it("deletes old poll runs but keeps the latest run, the latest good run and runs still holding findings", async () => {
    const w = await workspace(db, "Runs");
    const oldOk = await run(db, w, ago(60));
    const lastOk = await run(db, w, ago(45));
    const lastRun = await run(db, w, ago(40), { status: "unable_to_assess" });
    const stillRunning = await run(db, w, ago(50), { status: "running" });
    const result = await withTenant(db.app, w.tenant, (tx) => applyRetention(tx, NOW));
    expect(result.pollRuns).toBe(1);
    expect(await exists(db, "poll_runs", oldOk)).toBe(false);
    expect([await exists(db, "poll_runs", lastOk), await exists(db, "poll_runs", lastRun), await exists(db, "poll_runs", stillRunning)])
      .toEqual([true, true, true]);
    // The next poll still starts where the last good window ended.
    expect(await withTenant(db.app, w.tenant, (tx) => repo.lastAssessedUntil(tx, w.project))).toEqual(ago(45));
  });

  it("deletes expired OAuth states and keeps live ones", async () => {
    const hash = (c: string) => c.repeat(64);
    await withTenant(db.app, a.tenant, async (tx) => {
      await repo.createOAuthState(tx, { userId: a.owner, stateHash: hash("a"), codeVerifier: "v".repeat(64), expiresAt: ago(0, 1000) });
      await repo.createOAuthState(tx, { userId: a.owner, stateHash: hash("b"), codeVerifier: "v".repeat(64), expiresAt: new Date(NOW.getTime() + 60_000) });
    });
    await withTenant(db.app, a.tenant, (tx) => applyRetention(tx, NOW));
    const left = await db.admin.query<{ state_hash: string }>("SELECT state_hash FROM supahound.oauth_states WHERE tenant_id = $1", [a.tenant]);
    expect(left.rows.map((r) => r.state_hash)).toEqual([hash("b")]);
  });

  it("never touches another tenant's rows", async () => {
    await incident(db, b, "resolved", ago(90));
    await incident(db, b, "open", ago(90));
    await run(db, b, ago(90), { finding: null });
    await run(db, b, ago(80));
    await run(db, b, ago(70));
    const before = await rowCounts(db, b.tenant);
    expect(before.incidents).toBe(2);
    expect(await runDataJob(db.app, a.tenant, NOW)).toMatchObject({ kind: "retention" });
    expect(await rowCounts(db, b.tenant)).toEqual(before);
    // Run as B, with a tenant ID that is not B's in the SQL: RLS still keeps it to B.
    await withTenant(db.app, b.tenant, (tx) =>
      tx.query("UPDATE supahound.incidents SET status = 'resolved' WHERE tenant_id = $1", [a.tenant]));
    expect((await db.admin.query("SELECT count(*)::int AS n FROM supahound.incidents WHERE tenant_id = $1 AND status = 'open'", [a.tenant])).rows[0].n)
      .toBeGreaterThan(0);
  });

  it("lists every tenant with a project for the daily job, paid or not", async () => {
    const tenants = await repo.dataJobTenants(db.scheduler, NOW, 7);
    expect(tenants).toEqual(expect.arrayContaining([a.tenant, b.tenant]));
  });
});

describe.skipIf(pgInfo === null)("closing a workspace (decision 037)", () => {
  const db = useDb();
  let stripe: CancelOnlyStripe;
  const deps = () => ({ pool: db.app, stripe, now: () => NOW });

  beforeAll(() => {
    stripe = new CancelOnlyStripe();
  });

  it("only the workspace owner closes, and only with the exact name", async () => {
    const w = await workspace(db, "Close Me");
    await subscribe(db, w, "sub_close1", "cus_close1", stripe);
    for (const user of [w.admin, w.member]) {
      expect(await closeWorkspace(deps(), { user, tenant: w.tenant, typedName: "Close Me" })).toBe("role");
    }
    expect(await closeWorkspace(deps(), { user: w.owner, tenant: w.tenant, typedName: "close me" })).toBe("mismatch");
    expect(stripe.canceled).toEqual([]);
    expect(await withTenant(db.app, w.tenant, (tx) => getClosure(tx))).toBeNull();
  });

  it("refuses a closure written directly by an admin (RLS)", async () => {
    const w = await workspace(db, "Admin Close");
    await expect(withTenantForUser(db.app, w.admin, w.tenant, (tx) => recordClosure(tx, w.admin, NOW))).rejects.toThrow(/row-level security/);
  });

  it("closes: cancels Stripe once, pauses every project, cancels invites, and stops the scheduler at once", async () => {
    const w = await workspace(db, "Closing Co");
    await subscribe(db, w, "sub_closing1", "cus_closing1", stripe);
    await db.admin.query(
      `INSERT INTO supahound.project_invites (tenant_id, project_id, email, role, token_hash, invited_by, expires_at)
       VALUES ($1, $2, 'guest@example.com', 'viewer', $3, $4, now() + interval '7 days')`,
      [w.tenant, w.project, "c".repeat(64), w.owner],
    );
    expect((await repo.dueProjects(db.scheduler, 60, 1000, "off")).some((s) => s.tenantId === w.tenant)).toBe(true);

    expect(await closeWorkspace(deps(), { user: w.owner, tenant: w.tenant, typedName: " Closing Co " })).toBe("closed");
    expect(stripe.canceled).toEqual(["sub_closing1"]);
    expect(await closeWorkspace(deps(), { user: w.owner, tenant: w.tenant, typedName: "Closing Co" })).toBe("already_closed");
    expect(stripe.canceled).toEqual(["sub_closing1"]);

    const closure = await withTenant(db.app, w.tenant, (tx) => getClosure(tx));
    expect(closure).toMatchObject({ closedAt: NOW, closedBy: w.owner, purgeAfter: new Date(NOW.getTime() + 30 * DAY), purgedAt: null });
    const state = await db.admin.query(
      `SELECT (SELECT bool_and(paused) FROM supahound.projects WHERE tenant_id = $1) AS paused,
              (SELECT count(*)::int FROM supahound.project_invites WHERE tenant_id = $1 AND canceled_at IS NULL) AS open_invites,
              (SELECT status FROM supahound.billing_accounts WHERE tenant_id = $1) AS status`,
      [w.tenant],
    );
    expect(state.rows[0]).toEqual({ paused: true, open_invites: 0, status: "canceled" });
    for (const billing of ["off", "stripe"] as const) {
      expect((await repo.dueProjects(db.scheduler, 0, 1000, billing)).some((s) => s.tenantId === w.tenant)).toBe(false);
    }
  });

  it("sends every gated page of a closed workspace to the closed page, in both billing modes", async () => {
    const w = await workspace(db, "Gated");
    expect(await closeWorkspace({ ...deps(), stripe: null }, { user: w.owner, tenant: w.tenant, typedName: "Gated" })).toBe("closed");
    for (const mode of ["off", "stripe"] as const) {
      await expect(withPaidTenantForUser(db.app, mode, w.member, w.tenant, async () => "ran")).rejects.toBeInstanceOf(WorkspaceClosedError);
    }
    // A replayed "Add card" form on a closed workspace starts no checkout.
    const never = new Proxy({}, { get: () => () => { throw new Error("no Stripe call expected"); } }) as StripeGateway;
    const flow: FlowDeps = { pool: db.app, stripe: never, appUrl: "https://app.test", now: () => NOW };
    expect(await startCheckout(flow, { user: w.owner, email: null, tenant: w.tenant, acceptedTerms: true })).toBe(`/w/${w.tenant}/closed`);
  });

  it("closes nothing when Stripe fails, so the owner can try again", async () => {
    const w = await workspace(db, "Stripe Down");
    await subscribe(db, w, "sub_down1", "cus_down1", stripe);
    stripe.fail = true;
    try {
      await expect(closeWorkspace(deps(), { user: w.owner, tenant: w.tenant, typedName: "Stripe Down" })).rejects.toThrow(/stripe down/);
    } finally {
      stripe.fail = false;
    }
    expect(await withTenant(db.app, w.tenant, (tx) => getClosure(tx))).toBeNull();
    expect(await closeWorkspace(deps(), { user: w.owner, tenant: w.tenant, typedName: "Stripe Down" })).toBe("closed");
  });

  it("lets only the owner reopen before the purge, and resumes polling", async () => {
    const w = await workspace(db, "Reopen");
    await closeWorkspace({ ...deps(), stripe: null }, { user: w.owner, tenant: w.tenant, typedName: "Reopen" });
    expect(await reopenClosedWorkspace(db.app, { user: w.admin, tenant: w.tenant, now: NOW })).toBe("role");
    // An admin deleting the closure directly is refused by RLS (no row matches).
    await withTenantForUser(db.app, w.admin, w.tenant, (tx) => tx.query("DELETE FROM supahound.account_closures WHERE tenant_id = $1", [w.tenant]));
    expect(await withTenant(db.app, w.tenant, (tx) => getClosure(tx))).not.toBeNull();

    expect(await reopenClosedWorkspace(db.app, { user: w.owner, tenant: w.tenant, now: new Date(NOW.getTime() + 30 * DAY) })).toBe("too_late");
    expect(await reopenClosedWorkspace(db.app, { user: w.owner, tenant: w.tenant, now: new Date(NOW.getTime() + 29 * DAY) })).toBe("reopened");
    expect(await reopenClosedWorkspace(db.app, { user: w.owner, tenant: w.tenant, now: NOW })).toBe("not_closed");
    const paused = await db.admin.query("SELECT bool_or(paused) AS any FROM supahound.projects WHERE tenant_id = $1", [w.tenant]);
    expect(paused.rows[0].any).toBe(false);
    expect(await withPaidTenantForUser(db.app, "off", w.owner, w.tenant, async () => "open")).toBe("open");
  });

  it("refuses a tenant delete from a signed-in owner (only the purge job deletes tenants)", async () => {
    const w = await workspace(db, "No Self Delete");
    await withTenantForUser(db.app, w.owner, w.tenant, (tx) => tx.query("DELETE FROM supahound.tenants WHERE id = $1", [w.tenant]));
    expect((await db.admin.query("SELECT 1 FROM supahound.tenants WHERE id = $1", [w.tenant])).rows).toHaveLength(1);
  });
});

describe.skipIf(pgInfo === null)("purging a closed workspace (decision 037)", () => {
  const db = useDb();

  it("deletes every row of the closed tenant after 30 days, keeps the tax and legal record, and leaves the other tenant exactly as it was", async () => {
    const a = await seedFullTenant(db, "Leaving", "token-of-leaving");
    const b = await seedFullTenant(db, "Staying", "token-of-staying");
    // The seed writes rows at the real time, so this test runs on the real clock.
    const now = new Date();
    const before = (days: number) => new Date(now.getTime() - days * DAY);
    await withTenant(db.app, a.tenant, (tx) => recordClosure(tx, verifiedUserId(randomUUID()), before(31)));
    const aBefore = await rowCounts(db, a.tenant);
    const bBefore = await rowCounts(db, b.tenant);
    // The seed fills every table, so the purge is checked against real rows in each.
    for (const [table, n] of Object.entries(aBefore)) expect([table, n > 0]).toEqual([table, true]);

    // Not before the date: until then a closed workspace gets retention like any other.
    expect(await runDataJob(db.app, a.tenant, before(2))).toMatchObject({ kind: "retention", retention: { incidents: 0, findings: 0 } });
    expect(await rowCounts(db, a.tenant)).toEqual(aBefore);

    expect(await repo.dataJobTenants(db.scheduler, now, 7)).toContain(a.tenant);
    expect(await runDataJob(db.app, a.tenant, now)).toEqual({ kind: "purged" });

    const aAfter = await rowCounts(db, a.tenant);
    for (const [table, n] of Object.entries(aAfter)) expect([table, n]).toEqual([table, table === "account_closures" ? 1 : 0]);
    expect(await rowCounts(db, b.tenant)).toEqual(bBefore);
    // B still works: its token opens, its incident is there.
    expect(await withTenant(db.app, b.tenant, (tx) => repo.openConnectionToken(tx, db.vault, b.connection))).toBe("token-of-staying");

    const kept = await withTenant(db.app, a.tenant, (tx) => keptRecord(tx));
    expect(kept).toMatchObject({
      purgedAt: now, stripeCustomerId: "cus_leaving1", subscriptionId: "sub_leaving1", cardVerifiedAt: expect.any(Date),
    });
    expect(kept!.scanConsents).toEqual([
      expect.objectContaining({ domain: "acme-leaving.com", email: "founder@acme-leaving.com", ip: "203.0.113.7", tos_version: "v1" }),
    ]);
    // A second run is a no-op, and the job no longer lists the tenant until the records expire.
    expect(await runDataJob(db.app, a.tenant, now)).toEqual({ kind: "nothing" });
    expect(await repo.dataJobTenants(db.scheduler, now, 7)).not.toContain(a.tenant);
  });

  it("keeps the record for 7 years, then deletes it; RLS refuses an earlier delete", async () => {
    const t = tenantId(randomUUID());
    await db.admin.query(
      `INSERT INTO supahound.account_closures (tenant_id, closed_at, closed_by, purge_after, purged_at)
       VALUES ($1, $2, $3, $4, $4)`,
      [t, ago(365 * 8), randomUUID(), ago(365 * 8 - 30)],
    );
    const young = tenantId(randomUUID());
    await db.admin.query(
      `INSERT INTO supahound.account_closures (tenant_id, closed_at, closed_by, purge_after, purged_at)
       VALUES ($1, now() - interval '400 days', $2, now() - interval '370 days', now() - interval '370 days')`,
      [young, randomUUID()],
    );
    // A buggy job that skips its own date check still cannot delete a young record.
    await withTenant(db.app, young, (tx) => tx.query("DELETE FROM supahound.account_closures WHERE tenant_id = $1", [young]));
    expect((await db.admin.query("SELECT 1 FROM supahound.account_closures WHERE tenant_id = $1", [young])).rows).toHaveLength(1);

    expect(await repo.dataJobTenants(db.scheduler, NOW, 7)).toContain(t);
    expect(await runDataJob(db.app, t, NOW)).toEqual({ kind: "records_expired" });
    expect((await db.admin.query("SELECT 1 FROM supahound.account_closures WHERE tenant_id = $1", [t])).rows).toHaveLength(0);
  });
});

describe.skipIf(pgInfo === null)("disconnecting Supabase (decision 037)", () => {
  const db = useDb();
  const revoked: string[] = [];
  const deps = (ok = true) => ({ pool: db.app, vault: db.vault, revoke: async (t: string) => { revoked.push(t); return ok; } });
  const creds = { accessToken: "access-1", refreshToken: "refresh-1", expiresAt: null };

  it("only owners and admins disconnect, only with the exact label", async () => {
    const w = await workspace(db, "Disc Roles", creds);
    const input = { tenant: w.tenant, connection: w.connection, typedLabel: "Supabase" };
    expect(await disconnectConnection(deps(), { ...input, user: w.member })).toMatchObject({ result: "role" });
    expect(await disconnectConnection(deps(), { ...input, user: w.owner, typedLabel: "supabase" })).toMatchObject({ result: "mismatch" });
    expect(revoked).toEqual([]);
    // A member deleting the connection directly is refused by RLS (no row matches).
    await withTenantForUser(db.app, w.member, w.tenant, (tx) => tx.query("DELETE FROM supahound.connections WHERE tenant_id = $1", [w.tenant]));
    expect(await exists(db, "connections", w.connection)).toBe(true);
    expect(await disconnectConnection(deps(), { ...input, user: w.admin })).toMatchObject({ result: "disconnected", revoked: true, projectsRemoved: 1 });
  });

  it("deletes the sealed token and the connection's projects, keeps audit rows, revokes at Supabase, and stops polling at once", async () => {
    const w = await workspace(db, "Disc Owner", creds);
    const other = await withTenant(db.app, w.tenant, async (tx) => {
      const c = await repo.createConnection(tx, db.vault, { label: "Second org", token: "other-token" });
      const p = await repo.createProject(tx, { connectionId: c, supabaseRef: refOf(42), name: "Other" });
      await repo.appendAudit(tx, { projectId: w.project, action: "logs_query", detail: { rows: 1 } });
      return p;
    });
    await incident(db, w, "open", ago(1));
    const due = async () => (await repo.dueProjects(db.scheduler, 0, 1000, "off")).filter((s) => s.tenantId === w.tenant).map((s) => s.projectId);
    expect((await due()).sort()).toEqual([w.project, other].sort());

    revoked.length = 0;
    const out = await disconnectConnection(deps(), { user: w.owner, tenant: w.tenant, connection: w.connection, typedLabel: "Supabase" });
    expect(out).toEqual({ result: "disconnected", revoked: true, projectsRemoved: 1 });
    expect(revoked).toEqual(["refresh-1"]);
    expect(await exists(db, "connections", w.connection)).toBe(false);
    expect(await due()).toEqual([other]);
    const left = await db.admin.query(
      `SELECT (SELECT count(*)::int FROM supahound.projects WHERE id = $1) AS project,
              (SELECT count(*)::int FROM supahound.incidents WHERE project_id = $1) AS incidents,
              (SELECT count(*)::int FROM supahound.audit_log WHERE tenant_id = $2 AND project_id IS NULL) AS audit`,
      [w.project, w.tenant],
    );
    expect(left.rows[0]).toEqual({ project: 0, incidents: 0, audit: 1 });
    expect(await disconnectConnection(deps(), { user: w.owner, tenant: w.tenant, connection: w.connection, typedLabel: "Supabase" }))
      .toMatchObject({ result: "missing" });
  });

  it("disconnects even when Supabase refuses the revoke, and says so", async () => {
    const w = await workspace(db, "Disc Fail", creds);
    expect(await disconnectConnection(deps(false), { user: w.owner, tenant: w.tenant, connection: w.connection, typedLabel: "Supabase" }))
      .toEqual({ result: "disconnected", revoked: false, projectsRemoved: 1 });
    expect(await exists(db, "connections", w.connection)).toBe(false);
  });

  it("cannot reach another tenant's connection, and leaves that tenant exactly as it was", async () => {
    const mine = await workspace(db, "Disc Mine", creds);
    const theirs = await workspace(db, "Disc Theirs", creds);
    const before = await rowCounts(db, theirs.tenant);
    expect(await disconnectConnection(deps(), { user: mine.owner, tenant: mine.tenant, connection: theirs.connection, typedLabel: "Supabase" }))
      .toMatchObject({ result: "missing" });
    await expect(disconnectConnection(deps(), { user: mine.owner, tenant: theirs.tenant, connection: theirs.connection, typedLabel: "Supabase" }))
      .rejects.toBeInstanceOf(NotAMemberError);
    expect(await rowCounts(db, theirs.tenant)).toEqual(before);
  });
});
