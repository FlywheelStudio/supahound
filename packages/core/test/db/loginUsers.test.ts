import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { pgBin } from "./globalSetup.js";
import { pgInfo } from "./harness.js";

// supabase/setup/login-users.sql (self-hosting, decision 025), run with the real psql binary.
// The login users must inherit the NOLOGIN roles and nothing more, so forced RLS still applies.

const SQL_FILE = fileURLToPath(new URL("../../../../supabase/setup/login-users.sql", import.meta.url));
const GOOD = "a".repeat(24);

describe.skipIf(pgInfo === null)("login-users.sql", () => {
  const name = `t_${randomUUID().replace(/-/g, "")}`;
  let admin: pg.Client;

  const run = (app: string, scheduler: string) =>
    spawnSync(join(pgBin()!, "psql"), [
      "-X", "-q", "-h", pgInfo!.host, "-p", String(pgInfo!.port), "-U", "postgres", "-d", name,
      "-v", `app_password=${app}`, "-v", `scheduler_password=${scheduler}`, "-f", SQL_FILE,
    ], { encoding: "utf8" });

  const as = async <T>(user: string, fn: (c: pg.Client) => Promise<T>) => {
    const c = new pg.Client({ host: pgInfo!.host, port: pgInfo!.port, database: name, user });
    await c.connect();
    try {
      return await fn(c);
    } finally {
      await c.end();
    }
  };

  beforeAll(async () => {
    admin = new pg.Client({ host: pgInfo!.host, port: pgInfo!.port, user: "postgres", database: "postgres" });
    await admin.connect();
    await admin.query(`CREATE DATABASE ${name} TEMPLATE ${pgInfo!.template}`);
  });

  afterAll(async () => {
    await admin.query(`DROP DATABASE IF EXISTS ${name}`);
    await admin.end();
  });

  it("refuses a short password and creates nothing", async () => {
    const r = run("short", GOOD);
    expect(r.status).not.toBe(0);
    expect(r.stderr).toContain("at least 24 characters");
    const { rows } = await admin.query("SELECT rolname FROM pg_roles WHERE rolname LIKE 'supahound\\_%\\_login'");
    expect(rows).toEqual([]);
  });

  it("creates two login users with no superuser, no BYPASSRLS, each in its one role", async () => {
    const r = run(GOOD, "b".repeat(24));
    expect(r.status, r.stderr).toBe(0);
    const { rows } = await admin.query(`
      SELECT r.rolname, r.rolcanlogin, r.rolsuper, r.rolbypassrls, r.rolcreaterole, r.rolcreatedb,
             array(SELECT g.rolname::text FROM pg_auth_members m JOIN pg_roles g ON g.oid = m.roleid
                   WHERE m.member = r.oid ORDER BY 1) AS member_of
      FROM pg_roles r WHERE r.rolname IN ('supahound_app_login', 'supahound_scheduler_login') ORDER BY 1`);
    expect(rows).toEqual([
      { rolname: "supahound_app_login", rolcanlogin: true, rolsuper: false, rolbypassrls: false, rolcreaterole: false, rolcreatedb: false, member_of: ["supahound_app"] },
      { rolname: "supahound_scheduler_login", rolcanlogin: true, rolsuper: false, rolbypassrls: false, rolcreaterole: false, rolcreatedb: false, member_of: ["supahound_scheduler"] },
    ]);
  });

  it("gives the app user the app role's rights under forced RLS", async () => {
    // No tenant set: RLS hides every row instead of the query failing on privileges.
    const n = await as("supahound_app_login", (c) => c.query("SELECT count(*)::int AS n FROM supahound.projects"));
    expect(n.rows[0].n).toBe(0);
  });

  it("gives the scheduler user only its column grants", async () => {
    await as("supahound_scheduler_login", async (c) => {
      await c.query("SELECT tenant_id, id, paused, last_polled_at FROM supahound.projects");
      await expect(c.query("SELECT name FROM supahound.projects")).rejects.toThrow(/permission denied/);
      await expect(c.query("SELECT * FROM supahound.audit_log")).rejects.toThrow(/permission denied/);
    });
  });

  it("runs again without error and keeps one membership each", async () => {
    expect(run(GOOD, GOOD).status).toBe(0);
    const { rows } = await admin.query(`
      SELECT count(*)::int AS n FROM pg_auth_members m JOIN pg_roles r ON r.oid = m.member
      WHERE r.rolname IN ('supahound_app_login', 'supahound_scheduler_login')`);
    expect(rows[0].n).toBe(2);
  });
});
