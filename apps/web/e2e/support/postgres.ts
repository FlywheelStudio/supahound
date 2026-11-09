import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";

// A throwaway Postgres 17 cluster for the E2E run. Unlike the core test cluster it listens on
// TCP, because the Worker reaches it through the local Hyperdrive binding. Every migration in
// supabase/migrations/ is applied, and the app logs in as a role that is NOT a superuser and
// owns nothing, so forced RLS applies exactly as in production. The cluster trusts local TCP, so
// the password in the URLs is a placeholder that wrangler's Hyperdrive config requires.

export interface TestPostgres {
  /** Connection string for the app role (what Hyperdrive hands the Worker). */
  appUrl: string;
  /** Connection string for the superuser, for test assertions only. */
  adminUrl: string;
  stop: () => void;
}

function pgBin(): string {
  const candidates = [process.env.SUPAHOUND_PG_BIN, "/opt/homebrew/opt/postgresql@17/bin", "/usr/lib/postgresql/17/bin"];
  for (const dir of candidates) if (dir && existsSync(join(dir, "initdb"))) return dir;
  throw new Error("No Postgres 17 found for the E2E tests. Set SUPAHOUND_PG_BIN.");
}

export async function startPostgres(port: number): Promise<TestPostgres> {
  const bin = pgBin();
  const dir = mkdtempSync(join(tmpdir(), "supahound-e2e-pg-"));
  const data = join(dir, "data");
  execFileSync(join(bin, "initdb"), ["-D", data, "-U", "postgres", "--auth=trust", "-E", "UTF8", "--no-instructions"], { stdio: "ignore" });
  execFileSync(join(bin, "pg_ctl"), ["-D", data, "-l", join(dir, "log"), "-w", "-o", `-p ${port} -k ${dir} -c listen_addresses=127.0.0.1`, "start"], { stdio: "ignore" });

  const base = `postgres://postgres:e2e@127.0.0.1:${port}`;
  const admin = new pg.Client({ connectionString: `${base}/postgres` });
  await admin.connect();
  try {
    await admin.query("CREATE DATABASE supahound");
  } finally {
    await admin.end();
  }
  const db = new pg.Client({ connectionString: `${base}/supahound` });
  await db.connect();
  try {
    const migrations = fileURLToPath(new URL("../../../../supabase/migrations/", import.meta.url));
    for (const file of readdirSync(migrations).filter((f) => f.endsWith(".sql")).sort()) {
      await db.query(readFileSync(join(migrations, file), "utf8"));
    }
    await db.query("CREATE ROLE app_user LOGIN NOSUPERUSER NOBYPASSRLS IN ROLE supahound_app");
  } finally {
    await db.end();
  }

  return {
    appUrl: `postgres://app_user:e2e@127.0.0.1:${port}/supahound`,
    adminUrl: `${base}/supahound`,
    stop: () => {
      try {
        execFileSync(join(bin, "pg_ctl"), ["-D", data, "-m", "immediate", "stop"], { stdio: "ignore" });
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    },
  };
}
