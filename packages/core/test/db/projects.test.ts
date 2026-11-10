import { randomUUID } from "node:crypto";
import { beforeAll, describe, expect, it } from "vitest";
import * as repo from "../../src/db/repo.js";
import { withTenant } from "../../src/db/tenant.js";
import { createWorkspace, withTenantForUser } from "../../src/db/user.js";
import { accessTokenInTx } from "../../src/supabase/credentials.js";
import { verifiedUserId, type ConnectionId, type TenantId } from "../../src/tenancy/scope.js";
import { pgInfo, useDb } from "./harness.js";

const REF = "sharedrefsharedref01";
const NOW = new Date("2026-11-09T12:00:00Z");

describe.skipIf(pgInfo === null)("Project picker storage (issue #9)", () => {
  const db = useDb();
  const alice = verifiedUserId(randomUUID());
  const bob = verifiedUserId(randomUUID());
  let a: TenantId;
  let b: TenantId;
  let connA: ConnectionId;
  let connB: ConnectionId;

  beforeAll(async () => {
    a = await createWorkspace(db.app, alice, "Alice Co");
    b = await createWorkspace(db.app, bob, "Bob Co");
    connA = await withTenantForUser(db.app, alice, a, (tx) => repo.createConnection(tx, db.vault, { label: "Supabase", token: "tok-a" }));
    connB = await withTenantForUser(db.app, bob, b, (tx) => repo.createConnection(tx, db.vault, { label: "Supabase", token: "tok-b" }));
  });

  it("watches picked projects once, even when submitted twice", async () => {
    const pick = [{ ref: REF, name: "Shop" }, { ref: "secondrefsecondref02", name: "Blog" }];
    const first = await withTenantForUser(db.app, alice, a, (tx) => repo.watchProjects(tx, connA, pick));
    expect(first.sort()).toEqual([REF, "secondrefsecondref02"].sort());
    const again = await withTenantForUser(db.app, alice, a, (tx) => repo.watchProjects(tx, connA, pick));
    expect(again).toEqual([]);
    const listed = await withTenantForUser(db.app, alice, a, (tx) => repo.listProjects(tx));
    expect(listed.map((p) => [p.name, p.lastRunStatus])).toEqual([["Blog", null], ["Shop", null]]);
  });

  it("lets another tenant watch the same Supabase ref independently", async () => {
    expect(await withTenantForUser(db.app, bob, b, (tx) => repo.watchProjects(tx, connB, [{ ref: REF, name: "Shop (Bob)" }]))).toEqual([REF]);
    const bobs = await withTenantForUser(db.app, bob, b, (tx) => repo.listProjects(tx));
    expect(bobs.map((p) => p.name)).toEqual(["Shop (Bob)"]);
  });

  it("refuses another tenant's connection as the project's connection", async () => {
    await expect(withTenantForUser(db.app, alice, a, (tx) => repo.watchProjects(tx, connB, [{ ref: "thirdrefthirdref0003", name: "X" }])))
      .rejects.toThrow(/foreign key/);
  });

  it("lists only this tenant's connections", async () => {
    const conns = await withTenantForUser(db.app, alice, a, (tx) => repo.listConnections(tx));
    expect(conns.map((c) => c.id)).toEqual([connA]);
  });

  it("removes a project and its history, keeps its audit rows, and leaves the other tenant alone", async () => {
    const shop = (await withTenantForUser(db.app, alice, a, (tx) => repo.listProjects(tx))).find((p) => p.supabaseRef === REF)!;
    await withTenant(db.app, a, async (tx) => {
      const run = await repo.startPollRun(tx, shop.id, { start: new Date(NOW.getTime() - 60_000), end: NOW });
      await repo.finishPollRun(tx, run, { status: "ok", templates: 1, findings: 0 });
      await repo.appendAudit(tx, { projectId: shop.id, action: "logs_query", detail: { rows: 1 } });
    });

    // Bob cannot remove Alice's project: it is not in his tenant.
    expect(await withTenantForUser(db.app, bob, b, (tx) => repo.removeProject(tx, shop.id))).toBe(false);

    expect(await withTenantForUser(db.app, alice, a, (tx) => repo.removeProject(tx, shop.id))).toBe(true);
    expect(await withTenantForUser(db.app, alice, a, (tx) => repo.removeProject(tx, shop.id))).toBe(false);

    const left = await db.admin.query(
      `SELECT (SELECT count(*)::int FROM supahound.poll_runs WHERE project_id = $1) AS runs,
              (SELECT count(*)::int FROM supahound.audit_log WHERE tenant_id = $2 AND project_id IS NULL AND action = 'logs_query') AS orphaned_audit,
              (SELECT count(*)::int FROM supahound.projects WHERE tenant_id = $3 AND supabase_ref = $4) AS bobs`,
      [shop.id, a, b, REF],
    );
    expect(left.rows[0]).toEqual({ runs: 0, orphaned_audit: 1, bobs: 1 });
  });

  it("reads a connection token inside the caller's membership transaction", async () => {
    const token = await withTenantForUser(db.app, alice, a, (tx) => accessTokenInTx(tx, db.vault, connA, null, NOW));
    expect(token).toBe("tok-a");
    await expect(withTenantForUser(db.app, alice, a, (tx) => accessTokenInTx(tx, db.vault, connB, null, NOW))).rejects.toThrow(/not found/);
  });
});
