import { randomUUID } from "node:crypto";
import { beforeAll, describe, expect, it } from "vitest";
import * as repo from "../../src/db/repo.js";
import { createWorkspace, listWorkspaces, NotAMemberError, withTenantForUser } from "../../src/db/user.js";
import { verifiedUserId, type TenantId, type UserId } from "../../src/tenancy/scope.js";
import { pgInfo, useDb } from "./harness.js";

describe.skipIf(pgInfo === null)("users and memberships", () => {
  const db = useDb();
  const alice = verifiedUserId(randomUUID());
  const bob = verifiedUserId(randomUUID());
  const mallory = verifiedUserId(randomUUID());
  let agency: TenantId;
  let client: TenantId;

  beforeAll(async () => {
    agency = await createWorkspace(db.app, alice, "Flywheel Studio");
    client = await createWorkspace(db.app, bob, "Client Co");
    // Alice also joins the client's workspace as a member.
    await withTenantForUser(db.app, bob, client, (tx) =>
      tx.query("INSERT INTO supahound.memberships (tenant_id, user_id, role) VALUES ($1, $2, 'member')", [client, alice]),
    );
    await withTenantForUser(db.app, bob, client, async (tx) => {
      const conn = await repo.createConnection(tx, db.vault, { label: "Client org", token: "client-token" });
      const project = await repo.createProject(tx, { connectionId: conn, supabaseRef: "abcdefghijklmnopqrst", name: "Client app" });
      // A workspace member sees a project only with a role on it (decision 036), as an invite gives.
      await tx.query("INSERT INTO supahound.project_members (tenant_id, project_id, user_id, role) VALUES ($1, $2, $3, 'viewer')", [client, project, alice]);
    });
  });

  it("lists each user's own workspaces with their role", async () => {
    expect((await listWorkspaces(db.app, alice)).map((w) => [w.name, w.role])).toEqual([
      ["Client Co", "member"],
      ["Flywheel Studio", "owner"],
    ]);
    expect((await listWorkspaces(db.app, bob)).map((w) => w.name)).toEqual(["Client Co"]);
    expect(await listWorkspaces(db.app, mallory)).toEqual([]);
  });

  it("lets a member into a workspace and keeps the role", async () => {
    const role = await withTenantForUser(db.app, alice, client, async (_tx, r) => r);
    expect(role).toBe("member");
    const projects = await withTenantForUser(db.app, alice, client, (tx) => tx.query("SELECT name FROM supahound.projects"));
    expect(projects).toEqual([{ name: "Client app" }]);
  });

  it("returns dashboard data for the member's workspace only", async () => {
    const [projects, connections] = await withTenantForUser(db.app, alice, client, async (tx) => [
      await repo.listProjects(tx),
      await repo.countConnections(tx),
    ] as const);
    expect(projects.map((p) => [p.name, p.openIncidents, p.lastRunStatus])).toEqual([["Client app", 0, null]]);
    expect(connections).toBe(1);
    const own = await withTenantForUser(db.app, alice, agency, (tx) => repo.listProjects(tx));
    expect(own).toEqual([]);
  });

  it("refuses a non-member before the callback runs", async () => {
    let ran = false;
    await expect(withTenantForUser(db.app, bob, agency, async () => { ran = true; })).rejects.toThrow(NotAMemberError);
    await expect(withTenantForUser(db.app, mallory, client, async () => { ran = true; })).rejects.toThrow(NotAMemberError);
    expect(ran).toBe(false);
  });

  it("shows a signed-in user nothing of a tenant's data without entering it", async () => {
    const client2 = await db.app.connect();
    try {
      await client2.query("BEGIN");
      await client2.query("SELECT set_config('app.user_id', $1, true)", [alice]);
      for (const table of ["projects", "connections", "incidents", "findings", "audit_log", "poll_runs"]) {
        const r = await client2.query(`SELECT count(*)::int AS n FROM supahound.${table}`);
        expect(r.rows[0].n, table).toBe(0);
      }
      // Tenant names and own memberships only.
      const tenants = await client2.query("SELECT name FROM supahound.tenants ORDER BY name");
      expect(tenants.rows.map((r) => r.name)).toEqual(["Client Co", "Flywheel Studio"]);
      const members = await client2.query("SELECT user_id FROM supahound.memberships");
      expect(members.rows.every((r) => r.user_id === alice)).toBe(true);
      await client2.query("COMMIT");
    } finally {
      client2.release();
    }
  });

  it("hides the names of workspaces the user does not belong to", async () => {
    for (const [user, expected] of [[bob, ["Client Co"]], [mallory, []]] as const) {
      const c = await db.app.connect();
      try {
        await c.query("BEGIN");
        await c.query("SELECT set_config('app.user_id', $1, true)", [user]);
        const r = await c.query("SELECT name FROM supahound.tenants ORDER BY name");
        expect(r.rows.map((x) => x.name)).toEqual(expected);
      } finally {
        await c.query("ROLLBACK");
        c.release();
      }
    }
  });

  it("does not let a user add themselves to another tenant", async () => {
    const c = await db.app.connect();
    try {
      await c.query("BEGIN");
      await c.query("SELECT set_config('app.user_id', $1, true)", [mallory]);
      await expect(
        c.query("INSERT INTO supahound.memberships (tenant_id, user_id, role) VALUES ($1, $2, 'owner')", [client, mallory]),
      ).rejects.toThrow(/row-level security/);
    } finally {
      await c.query("ROLLBACK");
      c.release();
    }
  });

  it("only accepts UUIDs as verified user IDs", () => {
    expect(() => verifiedUserId("' OR 1=1 --")).toThrow(/UUID/);
    const id: UserId = verifiedUserId(randomUUID().toUpperCase());
    expect(id).toBe(id.toLowerCase());
  });
});
