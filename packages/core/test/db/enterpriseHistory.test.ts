import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { ENTERPRISE_HISTORY, STANDARD_HISTORY } from "../../src/billing/history.js";
import { runDataJob } from "../../src/datacontrols/flow.js";
import { historyWindow, isPaying } from "../../src/db/billing.js";
import * as repo from "../../src/db/repo.js";
import { listSecurityEvents } from "../../src/db/securityEvents.js";
import { withTenant } from "../../src/db/tenant.js";
import { createWorkspace, withTenantForUser } from "../../src/db/user.js";
import { verifiedUserId, type ProjectId, type TenantId, type UserId } from "../../src/tenancy/scope.js";
import { pgInfo, useDb, type Db } from "./harness.js";

// Enterprise history (issue #170, decision 048) against real Postgres with forced RLS: the window
// each plan gets (standard, Enterprise, staff-exempt), what the history pages' queries return in
// it, what the daily data job deletes (nothing while paying; outside the plan's window otherwise),
// and a downgrade (hidden at once, deleted once the workspace no longer pays).

const DAY = 86_400_000;
const NOW = new Date("2027-01-15T12:00:00Z");
const ago = (days: number) => new Date(NOW.getTime() - days * DAY);

interface Ws {
  tenant: TenantId;
  owner: UserId;
  member: UserId;
  project: ProjectId;
}

let refN = 0;
const nextRef = () => `enthist${String(++refN).padStart(4, "0")}${randomUUID().replace(/-/g, "")}`.slice(0, 20);

async function workspace(db: Db, name: string): Promise<Ws> {
  const owner = verifiedUserId(randomUUID());
  const member = verifiedUserId(randomUUID());
  const tenant = await createWorkspace(db.app, owner, name, `${name.toLowerCase().replace(/\W/g, "")}@example.com`);
  const project = await withTenant(db.app, tenant, async (tx) => {
    await tx.query("INSERT INTO supahound.memberships (tenant_id, user_id, role) VALUES ($1, $2, 'member')", [tenant, member]);
    const connection = await repo.createConnection(tx, db.vault, { label: "Org", token: "token" });
    const project = await repo.createProject(tx, { connectionId: connection, supabaseRef: nextRef(), name: `${name} app` });
    await tx.query("INSERT INTO supahound.project_members (tenant_id, project_id, user_id, role) VALUES ($1, $2, $3, 'viewer')", [tenant, project, member]);
    return project;
  });
  return { tenant, owner, member, project };
}

type Plan = "standard" | "enterprise" | "exempt";
async function setPlan(db: Db, w: Ws, plan: Plan, status: "active" | "canceled" = "active"): Promise<void> {
  await db.admin.query(
    `INSERT INTO supahound.billing_accounts (tenant_id, status, enterprise_at, exempt_owner, exempt_at) VALUES ($1, $2, $3, $4, $5)
     ON CONFLICT (tenant_id) DO UPDATE SET status = $2, enterprise_at = $3, exempt_owner = $4, exempt_at = $5`,
    [w.tenant, status, plan === "enterprise" ? ago(400) : null, plan === "exempt" ? w.owner : null, plan === "exempt" ? ago(400) : null],
  );
}

// One resolved incident with its finding and poll run, and one security event, all `days` old.
// A newer run keeps the old one from being the project's latest.
async function historyAt(db: Db, w: Ws, days: number): Promise<string> {
  const at = ago(days);
  const incident = await withTenant(db.app, w.tenant, async (tx) => {
    const id = await repo.upsertIncident(tx, w.project, {
      id: null, status: "resolved", actor: `user:${randomUUID()}`, severity: "high", detectors: ["cross_tenant"], signals: ["other_owner"],
      findingCount: 1, hits: 3, openedAt: at, lastSeenAt: at,
    });
    const run = await repo.startPollRun(tx, w.project, { start: new Date(at.getTime() - 60_000), end: at });
    await repo.finishPollRun(tx, run, { status: "ok", templates: 1, findings: 1 });
    await repo.insertFindings(tx, w.project, run, [{
      detector: "cross_tenant", severity: "high", actor: "user:x", signals: ["other_owner"], hits: 1,
      firstSeen: at.toISOString(), lastSeen: at.toISOString(), evidence: { table: "notes" }, incidentId: id,
    }]);
    await tx.query("UPDATE supahound.poll_runs SET started_at = $2 WHERE id = $1", [run, at]);
    await tx.query("UPDATE supahound.findings SET created_at = $2 WHERE poll_run_id = $1", [run, at]);
    await tx.query("INSERT INTO supahound.security_events (tenant_id, action, result, created_at) VALUES ($1, 'sign_in', 'success', $2)", [w.tenant, at]);
    return id;
  });
  return incident;
}

async function latestRun(db: Db, w: Ws): Promise<void> {
  await withTenant(db.app, w.tenant, async (tx) => {
    const run = await repo.startPollRun(tx, w.project, { start: ago(0.01), end: NOW });
    await repo.finishPollRun(tx, run, { status: "ok", templates: 1, findings: 0 });
  });
}

const counts = async (db: Db, t: TenantId) => (await db.admin.query<{ i: number; f: number; r: number; e: number }>(
  `SELECT (SELECT count(*)::int FROM supahound.incidents WHERE tenant_id = $1) AS i,
          (SELECT count(*)::int FROM supahound.findings WHERE tenant_id = $1) AS f,
          (SELECT count(*)::int FROM supahound.poll_runs WHERE tenant_id = $1) AS r,
          (SELECT count(*)::int FROM supahound.security_events WHERE tenant_id = $1 AND action = 'sign_in') AS e`, [t])).rows[0]!;

// What the pages see, as a signed-in user, with the window read from the plan in the same
// transaction (as the incident list, the incident detail and the security log do).
async function visible(db: Db, w: Ws, incident: string): Promise<{ list: string[]; detail: boolean; events: number; days: number }> {
  const member = await withTenantForUser(db.app, w.member, w.tenant, async (tx) => {
    const win = await historyWindow(tx);
    const page = await repo.listIncidentHistory(tx, w.project, { now: NOW, days: win.incidentDays, limit: 100 });
    const detail = await repo.getIncident(tx, w.project, incident, { now: NOW, days: win.incidentDays });
    return { list: page.incidents.map((i) => i.id), detail: detail !== null, days: win.incidentDays };
  });
  const events = await withTenantForUser(db.app, w.owner, w.tenant, async (tx) => {
    const win = await historyWindow(tx);
    return (await listSecurityEvents(tx, { now: NOW, days: win.securityEventDays, limit: 100 })).events.filter((e) => e.action === "sign_in").length;
  });
  return { ...member, events };
}

describe.skipIf(pgInfo === null)("Enterprise history (decision 048)", () => {
  const db = useDb();

  it("reads the window from the plan: standard, Enterprise, staff-exempt, and a member sees the same as the system", async () => {
    const none = await workspace(db, "No Row");
    expect(await withTenant(db.app, none.tenant, historyWindow)).toEqual(STANDARD_HISTORY);
    const plans: [Plan, typeof STANDARD_HISTORY][] = [["standard", STANDARD_HISTORY], ["enterprise", ENTERPRISE_HISTORY], ["exempt", ENTERPRISE_HISTORY]];
    for (const [plan, want] of plans) {
      const w = await workspace(db, `Plan ${plan}`);
      await setPlan(db, w, plan);
      expect(await withTenant(db.app, w.tenant, historyWindow)).toEqual(want);
      expect(await withTenantForUser(db.app, w.member, w.tenant, historyWindow)).toEqual(want);
    }
    expect(STANDARD_HISTORY).toMatchObject({ incidentDays: 30, securityEventDays: 90 });
    expect(ENTERPRISE_HISTORY).toMatchObject({ incidentDays: 365, securityEventDays: 365 });
  });

  it("an exemption that ends (a second owner joins) ends the Enterprise window with it", async () => {
    const w = await workspace(db, "Exempt Ends");
    await setPlan(db, w, "exempt");
    expect((await withTenant(db.app, w.tenant, historyWindow)).plan).toBe("enterprise");
    await db.admin.query("INSERT INTO supahound.memberships (tenant_id, user_id, role) VALUES ($1, $2, 'owner')", [w.tenant, randomUUID()]);
    expect((await withTenant(db.app, w.tenant, historyWindow)).plan).toBe("standard");
  });

  it.each([
    // [plan, age in days, incident shown, security event shown]
    ["standard", 29, true, true],
    ["standard", 31, false, true],
    ["standard", 91, false, false],
    ["enterprise", 31, true, true],
    ["enterprise", 200, true, true],
    ["enterprise", 364, true, true],
    ["enterprise", 366, false, false],
    ["exempt", 200, true, true],
    ["exempt", 366, false, false],
  ] as const)("the history pages of a %s workspace show a %i-day-old incident: %s, security event: %s", async (plan, days, incidentShown, eventShown) => {
    const w = await workspace(db, `Show ${plan} ${days}`);
    await setPlan(db, w, plan);
    const id = await historyAt(db, w, days);
    const v = await visible(db, w, id);
    expect(v.list).toEqual(incidentShown ? [id] : []);
    expect(v.detail).toBe(incidentShown);
    expect(v.events).toBe(eventShown ? 1 : 0);
  });

  it("the data job deletes outside the plan's window when the workspace does not pay: 30/90 days standard, a year Enterprise", async () => {
    const std = await workspace(db, "Lapsed Standard");
    const ent = await workspace(db, "Lapsed Enterprise");
    for (const w of [std, ent]) {
      await setPlan(db, w, w === ent ? "enterprise" : "standard", "canceled");
      for (const d of [20, 60, 100, 400]) await historyAt(db, w, d);
      await latestRun(db, w);
      expect(await withTenant(db.app, w.tenant, isPaying)).toBe(false);
    }
    expect(await runDataJob(db.app, std.tenant, NOW)).toMatchObject({ paying: false, retention: { incidents: 3, findings: 3, pollRuns: 3 } });
    // Standard: incidents, findings and runs inside 30 days, security events inside 90.
    expect(await counts(db, std.tenant)).toEqual({ i: 1, f: 1, r: 2, e: 2 });
    expect(await runDataJob(db.app, ent.tenant, NOW)).toMatchObject({ paying: false, retention: { incidents: 1, findings: 1, pollRuns: 1 } });
    // Enterprise: everything inside a year stays.
    expect(await counts(db, ent.tenant)).toEqual({ i: 3, f: 3, r: 4, e: 3 });
  });

  it.each(["standard", "enterprise", "exempt"] as const)("the data job deletes nothing while a %s workspace pays, even past a year (decision 037)", async (plan) => {
    const w = await workspace(db, `Paying ${plan}`);
    await setPlan(db, w, plan);
    for (const d of [60, 400]) await historyAt(db, w, d);
    await latestRun(db, w);
    const before = await counts(db, w.tenant);
    expect(await runDataJob(db.app, w.tenant, NOW)).toMatchObject({ paying: true, retention: { incidents: 0, findings: 0, pollRuns: 0 } });
    expect(await counts(db, w.tenant)).toEqual(before);
  });

  it("a downgrade hides older history at once and deletes it only once the workspace no longer pays", async () => {
    const w = await workspace(db, "Downgrade");
    const other = await workspace(db, "Bystander");
    await setPlan(db, w, "enterprise");
    await setPlan(db, other, "enterprise", "canceled");
    const old = await historyAt(db, w, 200);
    const recent = await historyAt(db, w, 10);
    await latestRun(db, w);
    await historyAt(db, other, 200);
    const otherBefore = await counts(db, other.tenant);
    expect((await visible(db, w, old)).list).toEqual([recent, old]);

    // The operator clears the flag: the 200-day-old rows are hidden on the next read.
    await db.admin.query("UPDATE supahound.billing_accounts SET enterprise_at = NULL WHERE tenant_id = $1", [w.tenant]);
    const hidden = await visible(db, w, old);
    expect(hidden).toEqual({ list: [recent], detail: false, events: 1, days: 30 });

    // Still paying: the data job deletes nothing, so a re-upgrade brings them back.
    const before = await counts(db, w.tenant);
    expect(await runDataJob(db.app, w.tenant, NOW)).toMatchObject({ paying: true });
    expect(await counts(db, w.tenant)).toEqual(before);
    await setPlan(db, w, "enterprise");
    expect((await visible(db, w, old)).detail).toBe(true);
    await db.admin.query("UPDATE supahound.billing_accounts SET enterprise_at = NULL WHERE tenant_id = $1", [w.tenant]);

    // It stops paying: the next daily job deletes what the standard windows no longer cover.
    await db.admin.query("UPDATE supahound.billing_accounts SET status = 'canceled' WHERE tenant_id = $1", [w.tenant]);
    expect(await runDataJob(db.app, w.tenant, NOW)).toMatchObject({ paying: false, retention: { incidents: 1, findings: 1 } });
    expect(await counts(db, w.tenant)).toEqual({ i: 1, f: 1, r: 2, e: 1 });
    expect(await db.admin.query("SELECT 1 FROM supahound.incidents WHERE id = $1", [old]).then((r) => r.rows.length)).toBe(0);
    // Another workspace is untouched.
    expect(await counts(db, other.tenant)).toEqual(otherBefore);
  });

  it("the column is nullable with no default, so every existing workspace stays on the standard window", async () => {
    const col = await db.admin.query<{ is_nullable: string; column_default: string | null }>(
      "SELECT is_nullable, column_default FROM information_schema.columns WHERE table_schema = 'supahound' AND table_name = 'billing_accounts' AND column_name = 'enterprise_at'",
    );
    expect(col.rows).toEqual([{ is_nullable: "YES", column_default: null }]);
  });
});
