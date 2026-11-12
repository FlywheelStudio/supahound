import { randomUUID } from "node:crypto";
import { beforeAll, describe, expect, it } from "vitest";
import * as repo from "../../src/db/repo.js";
import { TenantTx, withTenant } from "../../src/db/tenant.js";
import { VaultError } from "../../src/vault/vault.js";
import { pgInfo, useDb } from "./harness.js";
import { SHARED_REF, seedFullTenant, type Seeded } from "./seedTenant.js";

const TABLES = [
  "tenants", "connections", "projects", "service_role_networks", "poll_runs", "incidents", "findings", "audit_log",
  "memberships", "oauth_states",
  "scan_domains", "scan_authorizations", "scans", "scan_findings", "scan_jobs",
  "billing_accounts", "stripe_events", "project_usage",
  "project_members", "project_invites",
  "account_closures",
] as const;

describe.skipIf(pgInfo === null)("tenant isolation in Postgres", () => {
  const db = useDb();
  const seeded: Record<"a" | "b", Seeded> = {} as never;

  const seed = (name: string, token: string) => seedFullTenant(db, name, token);

  beforeAll(async () => {
    seeded.a = await seed("Agency", "token-of-agency");
    seeded.b = await seed("Client", "token-of-client");
    // Data controls (decision 037): a closure row per tenant, so every table holds rows.
    for (const s of [seeded.a, seeded.b]) {
      await withTenant(db.app, s.tenant, (tx) => tx.query(
        `INSERT INTO supahound.account_closures (tenant_id, closed_at, closed_by, purge_after)
         VALUES ($1, now(), $2, now() + interval '30 days')`, [s.tenant, randomUUID()]));
    }
  });

  it("runs the app and scheduler as roles that cannot bypass RLS and own nothing", async () => {
    const roles = await db.admin.query(
      `SELECT rolname, rolsuper, rolbypassrls FROM pg_roles WHERE rolname IN
         ('app_user', 'scheduler_user', 'notifier_user', 'supahound_app', 'supahound_scheduler', 'supahound_notifier')`,
    );
    expect(roles.rows).toHaveLength(6);
    for (const r of roles.rows) expect([r.rolsuper, r.rolbypassrls]).toEqual([false, false]);
    const owned = await db.admin.query(
      "SELECT count(*)::int AS n FROM pg_tables WHERE schemaname = 'supahound' AND tableowner IN ('app_user', 'scheduler_user', 'notifier_user', 'supahound_app', 'supahound_scheduler', 'supahound_notifier')",
    );
    expect(owned.rows[0].n).toBe(0);
  });

  it("forces RLS with a policy on every table in the schema, including ones added later", async () => {
    const res = await db.admin.query(`
      SELECT c.relname, c.relrowsecurity, c.relforcerowsecurity,
             (SELECT count(*) FROM pg_policy p WHERE p.polrelid = c.oid)::int AS policies
      FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = 'supahound' AND c.relkind = 'r'`);
    expect(res.rows.map((r) => r.relname).sort()).toEqual([...TABLES].sort());
    for (const r of res.rows) {
      expect([r.relname, r.relrowsecurity, r.relforcerowsecurity, r.policies > 0]).toEqual([r.relname, true, true, true]);
    }
  });

  it("puts the project_access policy on every table with project data, including ones added later (decision 036)", async () => {
    // project_members and project_invites have their own per-role policies; a policy on
    // project_members that read it would recurse.
    const OWN_RULES = ["project_invites", "project_members"];
    const res = await db.admin.query(`
      SELECT c.relname,
             EXISTS (SELECT 1 FROM pg_policy p WHERE p.polrelid = c.oid AND p.polname = 'project_access' AND NOT p.polpermissive) AS covered
      FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = 'supahound' AND c.relkind = 'r'
        AND (c.relname = 'projects' OR EXISTS (SELECT 1 FROM pg_attribute a WHERE a.attrelid = c.oid AND a.attname = 'project_id' AND NOT a.attisdropped))`);
    const tables = res.rows.map((r) => r.relname).sort();
    expect(tables).toEqual(expect.arrayContaining(["projects", "incidents", "findings", ...OWN_RULES]));
    for (const r of res.rows.filter((x) => !OWN_RULES.includes(x.relname))) expect([r.relname, r.covered]).toEqual([r.relname, true]);
  });

  it("shows each tenant only its own rows in every table", async () => {
    for (const me of ["a", "b"] as const) {
      const other = seeded[me === "a" ? "b" : "a"];
      await withTenant(db.app, seeded[me].tenant, async (tx) => {
        for (const table of TABLES) {
          const rows = await tx.query<{ t: string }>(
            `SELECT ${table === "tenants" ? "id" : "tenant_id"}::text AS t FROM supahound.${table}`,
          );
          expect(rows.length, table).toBeGreaterThan(0);
          expect(rows.every((r) => r.t === seeded[me].tenant), table).toBe(true);
          expect(rows.some((r) => r.t === other.tenant), table).toBe(false);
        }
      });
    }
  });

  it("returns zero rows, not an error, with no tenant set — even on a connection that had one", async () => {
    const client = await db.app.connect();
    try {
      for (const table of TABLES) {
        const res = await client.query(`SELECT count(*)::int AS n FROM supahound.${table}`);
        expect(res.rows[0].n, table).toBe(0);
      }
      await client.query("BEGIN");
      await client.query("SELECT set_config('app.tenant_id', $1, true)", [seeded.a.tenant]);
      await client.query("COMMIT");
      // The setting is now '' on this session; the policy must still match nothing.
      for (const table of TABLES) {
        const res = await client.query(`SELECT count(*)::int AS n FROM supahound.${table}`);
        expect(res.rows[0].n, table).toBe(0);
      }
    } finally {
      client.release();
    }
  });

  it("rejects writes that carry another tenant's ID", async () => {
    await expect(
      withTenant(db.app, seeded.a.tenant, (tx) =>
        tx.query("INSERT INTO supahound.audit_log (tenant_id, action, detail) VALUES ($1, 'logs_query', '{}')", [seeded.b.tenant]),
      ),
    ).rejects.toThrow(/row-level security/);
  });

  it("cannot update or delete another tenant's rows, even naming them by ID", async () => {
    await withTenant(db.app, seeded.a.tenant, async (tx) => {
      const upd = await tx.query("UPDATE supahound.projects SET name = 'pwned' WHERE id = $1 RETURNING id", [seeded.b.project]);
      const del = await tx.query("DELETE FROM supahound.incidents WHERE id = $1 RETURNING id", [seeded.b.incident]);
      expect([upd.length, del.length]).toEqual([0, 0]);
    });
    const still = await db.admin.query("SELECT name FROM supahound.projects WHERE id = $1", [seeded.b.project]);
    expect(still.rows[0].name).toBe("Client app");
  });

  it("cannot attach a row to another tenant's project, run or incident", async () => {
    const tryInsert = (project: string, run: string, incident: string | null) =>
      withTenant(db.app, seeded.a.tenant, (tx) =>
        tx.query(
          `INSERT INTO supahound.findings (tenant_id, project_id, poll_run_id, incident_id, detector, severity, actor, signals, evidence, hits, first_seen, last_seen)
           VALUES ($1, $2, $3, $4, 'cross_tenant', 'high', 'user:x', '{}', '{}', 1, now(), now())`,
          [seeded.a.tenant, project, run, incident],
        ),
      );
    await expect(tryInsert(seeded.b.project, seeded.a.run, null)).rejects.toThrow(/foreign key/);
    await expect(tryInsert(seeded.a.project, seeded.b.run, null)).rejects.toThrow(/foreign key/);
    await expect(tryInsert(seeded.a.project, seeded.a.run, seeded.b.incident)).rejects.toThrow(/foreign key/);
  });

  it("allows the same Supabase project under two tenants, once per tenant", async () => {
    const refs = await db.admin.query("SELECT count(*)::int AS n FROM supahound.projects WHERE supabase_ref = $1", [SHARED_REF]);
    expect(refs.rows[0].n).toBe(2);
    await expect(
      withTenant(db.app, seeded.a.tenant, (tx) =>
        repo.createProject(tx, { connectionId: seeded.a.connection, supabaseRef: SHARED_REF, name: "dup" }),
      ),
    ).rejects.toThrow(/duplicate key/);
  });

  it("keeps the audit log append-only for the app", async () => {
    for (const sql of ["UPDATE supahound.audit_log SET detail = '{}'", "DELETE FROM supahound.audit_log"]) {
      await expect(withTenant(db.app, seeded.a.tenant, (tx) => tx.query(sql))).rejects.toThrow(/permission denied/);
    }
  });

  it("lets the scheduler see project IDs for every tenant and nothing else", async () => {
    // Both seeded tenants are closed (beforeAll), and the scheduler skips closed workspaces
    // (decision 037). Open them for this check, then close one again.
    const closures = (await db.admin.query("DELETE FROM supahound.account_closures RETURNING *")).rows;
    const due = await repo.dueProjects(db.scheduler, 60, 100, "off");
    expect(due.map((s) => s.tenantId).sort()).toEqual([seeded.a.tenant, seeded.b.tenant].sort());
    for (const c of closures) {
      await db.admin.query(
        "INSERT INTO supahound.account_closures (tenant_id, closed_at, closed_by, purge_after) VALUES ($1, $2, $3, $4)",
        [c.tenant_id, c.closed_at, c.closed_by, c.purge_after],
      );
    }
    expect(await repo.dueProjects(db.scheduler, 60, 100, "off")).toEqual([]);
    await expect(db.scheduler.query("SELECT supabase_ref FROM supahound.projects")).rejects.toThrow(/permission denied/);
    await expect(db.scheduler.query("SELECT * FROM supahound.projects")).rejects.toThrow(/permission denied/);
    for (const table of TABLES.filter((t) => t !== "projects" && t !== "billing_accounts" && t !== "account_closures")) {
      await expect(db.scheduler.query(`SELECT 1 FROM supahound.${table}`), table).rejects.toThrow(/permission denied/);
    }
    // Billing: the status per tenant, to skip tenants that have not paid, and no other column.
    const statuses = await db.scheduler.query("SELECT tenant_id, status FROM supahound.billing_accounts");
    expect(statuses.rows).toHaveLength(2);
    for (const col of ["stripe_customer_id", "subscription_id", "starter_seats", "*"]) {
      await expect(db.scheduler.query(`SELECT ${col} FROM supahound.billing_accounts`), col).rejects.toThrow(/permission denied/);
    }
    // Closures (decision 037): which tenants are closed and when they purge, and no kept record.
    const visible = await db.scheduler.query("SELECT tenant_id, purge_after, purged_at FROM supahound.account_closures");
    expect(visible.rows).toHaveLength(2);
    for (const col of ["closed_by", "stripe_customer_id", "scan_consents", "*"]) {
      await expect(db.scheduler.query(`SELECT ${col} FROM supahound.account_closures`), col).rejects.toThrow(/permission denied/);
    }
  });

  it("lets the notifier read owners' addresses in every tenant and nothing else (decision 037)", async () => {
    const owners = await db.notifier.query<{ tenant_id: string; role: string }>("SELECT tenant_id, role, email FROM supahound.memberships");
    expect(owners.rows.map((r) => r.tenant_id).sort()).toEqual([seeded.a.tenant, seeded.b.tenant].sort());
    expect(owners.rows.every((r) => r.role === "owner")).toBe(true);
    for (const col of ["user_id", "created_at", "*"]) {
      await expect(db.notifier.query(`SELECT ${col} FROM supahound.memberships`), col).rejects.toThrow(/permission denied/);
    }
    for (const table of TABLES.filter((t) => t !== "memberships")) {
      await expect(db.notifier.query(`SELECT 1 FROM supahound.${table}`), table).rejects.toThrow(/permission denied/);
    }
    for (const sql of ["UPDATE supahound.memberships SET email = 'x@y.z'", "DELETE FROM supahound.memberships"]) {
      await expect(db.notifier.query(sql), sql).rejects.toThrow(/permission denied/);
    }
  });

  it("keeps each tenant's token sealed to that tenant, even if the row is copied across", async () => {
    const tokenA = await withTenant(db.app, seeded.a.tenant, (tx) => repo.openConnectionToken(tx, db.vault, seeded.a.connection));
    expect(tokenA).toBe("token-of-agency");
    await expect(
      withTenant(db.app, seeded.a.tenant, (tx) => repo.openConnectionToken(tx, db.vault, seeded.b.connection)),
    ).rejects.toThrow(/not found for this tenant/);
    // Simulate a bug or an attacker with database access that copies A's sealed token into B's row.
    await db.admin.query(
      "UPDATE supahound.connections SET sealed_token = (SELECT sealed_token FROM supahound.connections WHERE id = $1) WHERE id = $2",
      [seeded.a.connection, seeded.b.connection],
    );
    await expect(
      withTenant(db.app, seeded.b.tenant, (tx) => repo.openConnectionToken(tx, db.vault, seeded.b.connection)),
    ).rejects.toThrow(VaultError);
  });

  it("rolls back a failed tenant transaction and closes its handle", async () => {
    let leaked: TenantTx | undefined;
    await expect(
      withTenant(db.app, seeded.a.tenant, async (tx) => {
        leaked = tx;
        await repo.appendAudit(tx, { projectId: null, action: "model_call", detail: { marker: "rolled-back" } });
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");
    const res = await db.admin.query("SELECT count(*)::int AS n FROM supahound.audit_log WHERE detail->>'marker' = 'rolled-back'");
    expect(res.rows[0].n).toBe(0);
    await expect(leaked!.query("SELECT 1")).rejects.toThrow(/closed/);
  });
});
