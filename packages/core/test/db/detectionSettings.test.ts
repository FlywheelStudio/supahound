import { randomUUID } from "node:crypto";
import { beforeAll, describe, expect, it } from "vitest";
import * as settings from "../../src/db/detectionSettings.js";
import * as posture from "../../src/db/posture.js";
import * as repo from "../../src/db/repo.js";
import { withTenant } from "../../src/db/tenant.js";
import { createWorkspace, withTenantForUser } from "../../src/db/user.js";
import { verifiedUserId, type ProjectId, type TenantId, type UserId } from "../../src/tenancy/scope.js";
import { pgInfo, useDb } from "./harness.js";

// Per-project detection settings (issue #160, decision 045): intentionally public tables and the
// RPC burst threshold. RLS and the role rules per write, the audit trail, and the posture counts.

const user = () => verifiedUserId(randomUUID());

describe("publicTableName", () => {
  it("keeps only names the anon-read detector can match and posture can store", () => {
    expect(settings.publicTableName("prices")).toBe("prices");
    expect(settings.publicTableName("_lookup_2")).toBe("_lookup_2");
    for (const bad of ["Prices", "with space", "x'); DROP TABLE y; --", "", "a".repeat(64), "1abc", "a\u0000b", "café", null, 7]) {
      expect(settings.publicTableName(bad), String(bad)).toBeNull();
    }
    expect(settings.publicTableName("a".repeat(63))).toBe("a".repeat(63));
  });
});

describe.skipIf(pgInfo === null)("detection settings in Postgres", () => {
  const db = useDb();
  const u = { owner: user(), admin: user(), projAdmin: user(), editor: user(), viewer: user(), stranger: user(), other: user() };
  let A: TenantId;
  let B: TenantId;
  let p1: ProjectId;
  let p2: ProjectId;
  let pB: ProjectId;

  const as = <T>(who: UserId, t: TenantId, fn: Parameters<typeof withTenantForUser<T>>[3]) => withTenantForUser(db.app, who, t, fn);
  const sys = <T>(t: TenantId, fn: Parameters<typeof withTenant<T>>[2]) => withTenant(db.app, t, fn);

  async function addProject(t: TenantId, name: string, ref: string): Promise<ProjectId> {
    return sys(t, async (tx) => {
      const conn = await repo.createConnection(tx, db.vault, { label: name, token: `token-${randomUUID()}` });
      return repo.createProject(tx, { connectionId: conn, supabaseRef: ref, name });
    });
  }

  const audits = (t: TenantId) => db.admin.query<{ project_id: string; detail: Record<string, unknown> }>(
    "SELECT project_id, detail FROM supahound.audit_log WHERE tenant_id = $1 AND action = 'detection_setting' ORDER BY created_at, id",
    [t],
  ).then((r) => r.rows);
  const marks = (t: TenantId) => db.admin.query<{ project_id: string; table_name: string; marked_by: string | null }>(
    "SELECT project_id, table_name, marked_by FROM supahound.public_tables WHERE tenant_id = $1 ORDER BY table_name",
    [t],
  ).then((r) => r.rows);

  beforeAll(async () => {
    A = await createWorkspace(db.app, u.owner, "Agency", "owner@agency.test");
    B = await createWorkspace(db.app, u.other, "Other", "owner@other.test");
    p1 = await addProject(A, "Shop", "aaaaaaaaaaaaaaaaaaaa");
    p2 = await addProject(A, "Blog", "bbbbbbbbbbbbbbbbbbbb");
    pB = await addProject(B, "Other app", "cccccccccccccccccccc");
    await sys(A, async (tx) => {
      for (const [who, role] of [[u.admin, "admin"], [u.projAdmin, "member"], [u.editor, "member"], [u.viewer, "member"], [u.stranger, "member"]] as const) {
        await tx.query("INSERT INTO supahound.memberships (tenant_id, user_id, role) VALUES ($1, $2, $3)", [A, who, role]);
      }
      for (const [who, role] of [[u.projAdmin, "admin"], [u.editor, "editor"], [u.viewer, "viewer"]] as const) {
        await tx.query("INSERT INTO supahound.project_members (tenant_id, project_id, user_id, role) VALUES ($1, $2, $3, $4)", [A, p1, who, role]);
      }
    });
  });

  describe("intentionally public tables", () => {
    it("lets the project's owners and admins mark and unmark, and audits each change", async () => {
      expect(await as(u.owner, A, (tx) => settings.markPublicTable(tx, p1, "prices", u.owner))).toBe("marked");
      expect(await as(u.projAdmin, A, (tx) => settings.markPublicTable(tx, p1, "countries", u.projAdmin))).toBe("marked");
      expect(await as(u.admin, A, (tx) => settings.markPublicTable(tx, p1, "prices", u.admin))).toBe("already");
      expect((await marks(A)).map((m) => [m.table_name, m.marked_by])).toEqual([["countries", u.projAdmin], ["prices", u.owner]]);
      expect(await as(u.editor, A, (tx) => settings.listPublicTables(tx, p1))).toMatchObject([{ table: "countries" }, { table: "prices" }]);

      expect(await as(u.projAdmin, A, (tx) => settings.unmarkPublicTable(tx, p1, "countries", u.projAdmin))).toBe(true);
      expect(await as(u.projAdmin, A, (tx) => settings.unmarkPublicTable(tx, p1, "countries", u.projAdmin))).toBe(false);
      expect((await marks(A)).map((m) => m.table_name)).toEqual(["prices"]);
      expect((await audits(A)).map((r) => [r.project_id, r.detail])).toEqual([
        [p1, { setting: "public_table", change: "mark", table: "prices", by: u.owner }],
        [p1, { setting: "public_table", change: "mark", table: "countries", by: u.projAdmin }],
        [p1, { setting: "public_table", change: "unmark", table: "countries", by: u.projAdmin }],
      ]);
    });

    it("refuses editors and viewers in RLS, for marks and unmarks", async () => {
      for (const who of [u.editor, u.viewer]) {
        await expect(as(who, A, (tx) => settings.markPublicTable(tx, p1, "secrets", who)), who).rejects.toThrow(/row-level security/);
        expect(await as(who, A, (tx) => settings.unmarkPublicTable(tx, p1, "prices", who)), who).toBe(false);
      }
      expect((await marks(A)).map((m) => m.table_name)).toEqual(["prices"]);
    });

    it("refuses a project admin on a project where they are not admin, and hides it from strangers", async () => {
      // projAdmin has no role on p2: the RLS insert check refuses it.
      await expect(as(u.projAdmin, A, (tx) => settings.markPublicTable(tx, p2, "prices", u.projAdmin))).rejects.toThrow(/row-level security/);
      expect(await as(u.stranger, A, (tx) => settings.listPublicTables(tx, p1))).toEqual([]);
      expect(await as(u.stranger, A, (tx) => settings.unmarkPublicTable(tx, p1, "prices", u.stranger))).toBe(false);
    });

    it("stores only plain lower-case identifiers, in the app and in the database", async () => {
      expect(await as(u.owner, A, (tx) => settings.markPublicTable(tx, p1, "Robert'); DROP TABLE x; --", u.owner))).toBe("invalid");
      await expect(sys(A, (tx) => tx.query(
        "INSERT INTO supahound.public_tables (tenant_id, project_id, table_name) VALUES ($1, $2, 'Bad Name')", [A, p1],
      ))).rejects.toThrow(/check constraint/);
    });

    it("never marks another tenant's project, and never shows another tenant's marks", async () => {
      await expect(sys(A, (tx) => tx.query(
        "INSERT INTO supahound.public_tables (tenant_id, project_id, table_name) VALUES ($1, $2, 'prices')", [A, pB],
      ))).rejects.toThrow(/foreign key/);
      await expect(sys(A, (tx) => tx.query(
        "INSERT INTO supahound.public_tables (tenant_id, project_id, table_name) VALUES ($1, $2, 'prices')", [B, pB],
      ))).rejects.toThrow(/row-level security/);
      expect(await as(u.other, B, (tx) => settings.markPublicTable(tx, pB, "prices", u.other))).toBe("marked");
      expect(await as(u.owner, A, (tx) => settings.listPublicTables(tx, pB))).toEqual([]);
      expect([...(await sys(A, (tx) => settings.publicTablesByProject(tx))).keys()]).toEqual([p1]);
    });

    it("accepts the marked table's read finding in the posture counts", async () => {
      await sys(A, async (tx) => {
        const scanId = (await posture.claimPostureScan(tx, p1, new Date(), { refreshSeconds: 1, retrySeconds: 1 }))!;
        await posture.savePostureScan(tx, p1, scanId, {
          catalog: {
            status: "ok", findings: [
              { source: "catalog", check: "permissive_policy", severity: "medium", schema: "public", object: "prices", objectType: "table",
                evidence: { policy: "read all", openCommands: ["SELECT"], readExposure: "anon", exposure: "anon" } },
              { source: "catalog", check: "rls_disabled", severity: "critical", schema: "public", object: "orders", objectType: "table",
                evidence: { exposure: "anon", anonPrivileges: ["SELECT", "INSERT"], authenticatedPrivileges: [] } },
            ],
          },
          advisor: null,
        }, new Date());
      });
      const summary = (await as(u.owner, A, (tx) => posture.postureSummaries(tx))).get(p1);
      expect(summary?.counts).toEqual({ critical: 1, high: 0, medium: 0, low: 0 });
      await as(u.owner, A, (tx) => settings.unmarkPublicTable(tx, p1, "prices", u.owner));
      const after = (await as(u.owner, A, (tx) => posture.postureSummaries(tx))).get(p1);
      expect(after?.counts).toEqual({ critical: 1, high: 0, medium: 1, low: 0 });
      await as(u.owner, A, (tx) => settings.markPublicTable(tx, p1, "prices", u.owner));
    });

    it("removes a project's marks with the project", async () => {
      const gone = await addProject(A, "Temp", "dddddddddddddddddddd");
      await sys(A, (tx) => settings.markPublicTable(tx, gone, "prices", null));
      await sys(A, (tx) => tx.query("DELETE FROM supahound.projects WHERE tenant_id = $1 AND id = $2", [A, gone]));
      expect((await marks(A)).filter((m) => m.project_id === gone)).toEqual([]);
    });
  });

  describe("RPC burst threshold", () => {
    const threshold = async (p: ProjectId) =>
      (await db.admin.query<{ n: number }>("SELECT rpc_burst_hits AS n FROM supahound.projects WHERE id = $1", [p])).rows[0]!.n;

    it("defaults to 100 and reaches the poller and the project list", async () => {
      expect(await threshold(p2)).toBe(100);
      expect((await sys(A, (tx) => repo.getProject(tx, p2)))?.rpcBurstHits).toBe(100);
      expect((await as(u.owner, A, (tx) => repo.listProjects(tx))).map((p) => p.rpcBurstHits)).toEqual([100, 100]);
    });

    it("lets owners, admins and editors set it within 10 to 10,000, and audits each change", async () => {
      expect(await as(u.editor, A, (tx) => settings.setRpcBurstHits(tx, p1, 250, u.editor))).toBe(true);
      expect(await as(u.projAdmin, A, (tx) => settings.setRpcBurstHits(tx, p1, 10, u.projAdmin))).toBe(true);
      expect(await as(u.owner, A, (tx) => settings.setRpcBurstHits(tx, p1, 10_000, u.owner))).toBe(true);
      // Unchanged: no audit row.
      expect(await as(u.owner, A, (tx) => settings.setRpcBurstHits(tx, p1, 10_000, u.owner))).toBe(true);
      expect(await threshold(p1)).toBe(10_000);
      expect((await sys(A, (tx) => repo.getProject(tx, p1)))?.rpcBurstHits).toBe(10_000);
      const rows = (await audits(A)).filter((r) => r.detail.setting === "rpc_burst_hits");
      expect(rows.map((r) => r.detail)).toEqual([
        { setting: "rpc_burst_hits", from: 100, to: 250, by: u.editor },
        { setting: "rpc_burst_hits", from: 250, to: 10, by: u.projAdmin },
        { setting: "rpc_burst_hits", from: 10, to: 10_000, by: u.owner },
      ]);
    });

    it("refuses viewers and strangers, and values out of range in the app and in the database", async () => {
      expect(await as(u.viewer, A, (tx) => settings.setRpcBurstHits(tx, p1, 50, u.viewer))).toBe(false);
      expect(await as(u.stranger, A, (tx) => settings.setRpcBurstHits(tx, p1, 50, u.stranger))).toBe(false);
      expect(await as(u.owner, A, (tx) => settings.setRpcBurstHits(tx, pB, 50, u.owner))).toBe(false);
      for (const bad of [9, 10_001, 12.5]) expect(await as(u.owner, A, (tx) => settings.setRpcBurstHits(tx, p1, bad, u.owner))).toBe(false);
      for (const bad of [9, 10_001]) {
        await expect(sys(A, (tx) => tx.query("UPDATE supahound.projects SET rpc_burst_hits = $2 WHERE id = $1", [p1, bad])))
          .rejects.toThrow(/projects_rpc_burst_hits_range/);
      }
      expect(await threshold(p1)).toBe(10_000);
      expect(await threshold(pB)).toBe(100);
    });
  });
});
