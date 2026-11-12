import { randomUUID } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { projectRole } from "../../src/db/people.js";
import { withTenantForUser } from "../../src/db/user.js";
import { projectId, tenantId, verifiedUserId } from "../../src/tenancy/scope.js";
import { pgInfo } from "./harness.js";

// The project-people migration on a database that already has data (decision 033): workspace
// owners and admins keep every project, workspace members become viewers on every project, and
// running the migration twice changes nothing. The shared template is migrated while empty, so
// this suite builds its own database: every earlier migration, then seed rows, then this one.

const MIGRATION = "20261112000000_project_people.sql";
const dir = fileURLToPath(new URL("../../../../supabase/migrations/", import.meta.url));
const files = readdirSync(dir).filter((f) => f.endsWith(".sql")).sort();

describe.skipIf(pgInfo === null)("project people migration backfill", () => {
  const name = `b_${randomUUID().replace(/-/g, "")}`;
  let admin: pg.Client;
  let app: pg.Pool;
  const t1 = randomUUID();
  const t2 = randomUUID();
  const owner = randomUUID();
  const adm = randomUUID();
  const m1 = randomUUID();
  const m2 = randomUUID();
  const m3 = randomUUID();
  const [x, y, z, w] = [randomUUID(), randomUUID(), randomUUID(), randomUUID()];

  const apply = (file: string) => admin.query(readFileSync(join(dir, file), "utf8"));
  const rows = async () =>
    (await admin.query<{ tenant_id: string; project_id: string; user_id: string; role: string }>(
      "SELECT tenant_id, project_id, user_id, role FROM supahound.project_members ORDER BY tenant_id, project_id, user_id",
    )).rows;

  async function project(t: string, id: string, ref: string) {
    const conn = randomUUID();
    await admin.query("INSERT INTO supahound.connections (id, tenant_id, label, sealed_token, key_version) VALUES ($1, $2, 'c', '\\x00', 1)", [conn, t]);
    await admin.query("INSERT INTO supahound.projects (id, tenant_id, connection_id, supabase_ref, name) VALUES ($1, $2, $3, $4, $4)", [id, t, conn, ref]);
  }

  beforeAll(async () => {
    const info = pgInfo!;
    const root = new pg.Client({ host: info.host, port: info.port, user: "postgres", database: "postgres" });
    await root.connect();
    await root.query(`CREATE DATABASE ${name}`);
    await root.end();
    admin = new pg.Client({ host: info.host, port: info.port, user: "postgres", database: name });
    await admin.connect();
    expect(files).toContain(MIGRATION);
    for (const f of files.filter((f) => f < MIGRATION)) await apply(f);

    await admin.query("INSERT INTO supahound.tenants (id, name) VALUES ($1, 'One'), ($2, 'Two')", [t1, t2]);
    await admin.query(
      `INSERT INTO supahound.memberships (tenant_id, user_id, role) VALUES
         ($1, $3, 'owner'), ($1, $4, 'admin'), ($1, $5, 'member'), ($1, $6, 'member'), ($2, $7, 'member'), ($2, $3, 'owner')`,
      [t1, t2, owner, adm, m1, m2, m3],
    );
    await project(t1, x, "xxxxxxxxxxxxxxxxxxxx");
    await project(t1, y, "yyyyyyyyyyyyyyyyyyyy");
    await project(t2, z, "zzzzzzzzzzzzzzzzzzzz");

    await apply(MIGRATION);
    app = new pg.Pool({ host: info.host, port: info.port, user: "app_user", database: name, max: 2 });
  });

  afterAll(async () => {
    await app?.end();
    await admin?.end();
  });

  it("makes every workspace member a viewer on every project of their workspace, and writes no rows for owners and admins", async () => {
    const want = ([
      [t1, x, m1], [t1, x, m2], [t1, y, m1], [t1, y, m2], [t2, z, m3],
    ] as [string, string, string][]).map(([t, p, u]) => ({ tenant_id: t, project_id: p, user_id: u, role: "viewer" }));
    const sortKey = (r: { tenant_id: string; project_id: string; user_id: string }) => `${r.tenant_id}${r.project_id}${r.user_id}`;
    expect(await rows()).toEqual(want.sort((a, b) => sortKey(a).localeCompare(sortKey(b))));
  });

  it("gives every person the role decision 033 promised on every project", async () => {
    const role = (u: string, t: string, p: string) =>
      withTenantForUser(app, verifiedUserId(u), tenantId(t), (tx) => projectRole(tx, projectId(p)));
    for (const p of [x, y]) {
      expect(await role(owner, t1, p)).toBe("owner");
      expect(await role(adm, t1, p)).toBe("admin");
      expect(await role(m1, t1, p)).toBe("viewer");
      expect(await role(m2, t1, p)).toBe("viewer");
    }
    expect(await role(m3, t2, z)).toBe("viewer");
    expect(await role(owner, t2, z)).toBe("owner");
    // No cross-tenant role: tenant one's member has none on tenant two's project, even named.
    expect(await role(owner, t1, z)).toBeNull();
  });

  it("runs twice without error or change, and a re-run covers a project added in between", async () => {
    const before = await rows();
    await apply(MIGRATION);
    expect(await rows()).toEqual(before);
    // The deploy gap: old code adds a project after the migration. Re-running the migration (or
    // its backfill statement) gives the existing members their viewer role on it too.
    await project(t1, w, "wwwwwwwwwwwwwwwwwwww");
    await apply(MIGRATION);
    const added = (await rows()).filter((r) => r.project_id === w).map((r) => r.user_id).sort();
    expect(added).toEqual([m1, m2].sort());
  });
});
