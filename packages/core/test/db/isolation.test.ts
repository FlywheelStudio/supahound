import { randomUUID } from "node:crypto";
import { beforeAll, describe, expect, it } from "vitest";
import * as repo from "../../src/db/repo.js";
import { TenantTx, withTenant } from "../../src/db/tenant.js";
import { tenantId, type ConnectionId, type ProjectId, type TenantId } from "../../src/tenancy/scope.js";
import { VaultError } from "../../src/vault/vault.js";
import { pgInfo, useDb } from "./harness.js";

// Both tenants watch the SAME Supabase project, the case most likely to leak.
const SHARED_REF = "abcdefghijklmnopqrst";

const TABLES = [
  "tenants", "connections", "projects", "service_role_networks", "poll_runs", "incidents", "findings", "audit_log",
  "memberships", "oauth_states",
  "scan_domains", "scan_authorizations", "scans", "scan_findings", "scan_jobs",
] as const;

interface Seeded {
  tenant: TenantId;
  connection: ConnectionId;
  project: ProjectId;
  run: string;
  incident: string;
}

describe.skipIf(pgInfo === null)("tenant isolation in Postgres", () => {
  const db = useDb();
  const seeded: Record<"a" | "b", Seeded> = {} as never;

  async function seed(name: string, token: string): Promise<Seeded> {
    const tenant = tenantId(randomUUID());
    return withTenant(db.app, tenant, async (tx) => {
      await repo.createTenant(tx, name);
      const connection = await repo.createConnection(tx, db.vault, { label: `${name} org`, token });
      const project = await repo.createProject(tx, { connectionId: connection, supabaseRef: SHARED_REF, name: `${name} app` });
      const run = await repo.startPollRun(tx, project, { start: new Date(Date.now() - 60_000), end: new Date() });
      const incident = await repo.upsertIncident(tx, project, {
        id: null, status: "open", actor: `user:${name}`, severity: "critical", detectors: ["cross_tenant"],
        signals: ["other_owner"], findingCount: 1, hits: 1, openedAt: new Date(), lastSeenAt: new Date(),
      });
      await repo.insertFindings(tx, project, run, [{
        detector: "cross_tenant", severity: "critical", actor: `user:${name}`, signals: ["other_owner"],
        firstSeen: new Date().toISOString(), lastSeen: new Date().toISOString(), hits: 1,
        evidence: { table: "notes" }, incidentId: incident,
      }]);
      await repo.saveNetworks(tx, project, [16509]);
      await repo.appendAudit(tx, { projectId: project, action: "logs_query", detail: { rows: 1 } });
      await tx.query("INSERT INTO supahound.memberships (tenant_id, user_id, role) VALUES ($1, $2, 'owner')", [tenant, randomUUID()]);
      await repo.createOAuthState(tx, {
        userId: randomUUID(), stateHash: randomUUID().replace(/-/g, "").padEnd(64, "0"),
        codeVerifier: "v".repeat(64), expiresAt: new Date(Date.now() + 600_000),
      });
      // Scan funnel rows: a verified domain and a completed scan, one of each per tenant.
      const slug = name.toLowerCase();
      const [domain] = await tx.query<{ id: string }>(
        `INSERT INTO supahound.scan_domains (tenant_id, apex, verification_token, token_expires_at, verified_at, verifying_ip)
         VALUES ($1, $2, $3, now() + interval '1 day', now(), '203.0.113.7') RETURNING id`,
        [tenant, `acme-${slug}.com`, "a".repeat(32)],
      );
      const domainRowId = domain!.id;
      await tx.query(
        `INSERT INTO supahound.scan_authorizations (tenant_id, domain_id, tos_version, email, ip)
         VALUES ($1, $2, 'v1', $3, '203.0.113.7')`,
        [tenant, domainRowId, `founder@acme-${slug}.com`],
      );
      const [scan] = await tx.query<{ id: string }>(
        `INSERT INTO supahound.scans (tenant_id, domain_id, mode, status, score, started_at, finished_at)
         VALUES ($1, $2, 'introductory', 'done', 72, now(), now()) RETURNING id`,
        [tenant, domainRowId],
      );
      const scanRowId = scan!.id;
      await tx.query(
        `INSERT INTO supahound.scan_findings (tenant_id, scan_id, severity, type, endpoint, evidence, fix, supahound_monitor)
         VALUES ($1, $2, 'high', 'rls_missing', '/rest/v1/notes', '{"tables":1}', 'Enable RLS', 'anon_table_read')`,
        [tenant, scanRowId],
      );
      await tx.query("INSERT INTO supahound.scan_jobs (tenant_id, scan_id, state) VALUES ($1, $2, 'queued')", [tenant, scanRowId]);
      return { tenant, connection, project, run, incident };
    });
  }

  beforeAll(async () => {
    seeded.a = await seed("Agency", "token-of-agency");
    seeded.b = await seed("Client", "token-of-client");
  });

  it("runs the app and scheduler as roles that cannot bypass RLS and own nothing", async () => {
    const roles = await db.admin.query(
      "SELECT rolname, rolsuper, rolbypassrls FROM pg_roles WHERE rolname IN ('app_user', 'scheduler_user', 'supahound_app', 'supahound_scheduler')",
    );
    expect(roles.rows).toHaveLength(4);
    for (const r of roles.rows) expect([r.rolsuper, r.rolbypassrls]).toEqual([false, false]);
    const owned = await db.admin.query(
      "SELECT count(*)::int AS n FROM pg_tables WHERE schemaname = 'supahound' AND tableowner IN ('app_user', 'scheduler_user', 'supahound_app', 'supahound_scheduler')",
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
    const due = await repo.dueProjects(db.scheduler, 60, 100);
    expect(due.map((s) => s.tenantId).sort()).toEqual([seeded.a.tenant, seeded.b.tenant].sort());
    await expect(db.scheduler.query("SELECT supabase_ref FROM supahound.projects")).rejects.toThrow(/permission denied/);
    await expect(db.scheduler.query("SELECT * FROM supahound.projects")).rejects.toThrow(/permission denied/);
    for (const table of TABLES.filter((t) => t !== "projects")) {
      await expect(db.scheduler.query(`SELECT 1 FROM supahound.${table}`), table).rejects.toThrow(/permission denied/);
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
