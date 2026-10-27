import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";
import type { TestProject } from "vitest/node";

// Starts a throwaway Postgres cluster (Unix socket only, no TCP) for the database tests, applies
// the migrations to a template database, and creates two login roles that are NOT superusers and
// own nothing, so RLS applies to them exactly as it will in production.

export interface PgInfo {
  host: string;
  port: number;
  template: string;
}

declare module "vitest" {
  export interface ProvidedContext {
    pg: PgInfo | null;
  }
}

function pgBin(): string | null {
  const candidates = [
    process.env.GUARDBASE_PG_BIN,
    "/opt/homebrew/opt/postgresql@17/bin",
    "/usr/lib/postgresql/17/bin",
    "/opt/homebrew/opt/postgresql@16/bin",
  ];
  for (const dir of candidates) if (dir && existsSync(join(dir, "initdb"))) return dir;
  return null;
}

export default async function setup(project: TestProject): Promise<() => Promise<void>> {
  const bin = pgBin();
  if (!bin) {
    if (process.env.GUARDBASE_SKIP_DB_TESTS === "1") {
      project.provide("pg", null);
      return async () => undefined;
    }
    throw new Error("No Postgres 16+ found for the database tests. Set GUARDBASE_PG_BIN, or GUARDBASE_SKIP_DB_TESTS=1 to skip them.");
  }

  const dir = mkdtempSync(join(tmpdir(), "guardbase-pg-"));
  const data = join(dir, "data");
  const port = 54000 + Math.floor(Math.random() * 1000);
  execFileSync(join(bin, "initdb"), ["-D", data, "-U", "postgres", "--auth=trust", "-E", "UTF8", "--no-instructions"], { stdio: "ignore" });
  execFileSync(join(bin, "pg_ctl"), ["-D", data, "-l", join(dir, "log"), "-w", "-o", `-p ${port} -k ${dir} -c listen_addresses=''`, "start"], { stdio: "ignore" });

  const admin = new pg.Client({ host: dir, port, user: "postgres", database: "postgres" });
  await admin.connect();
  try {
    await admin.query("CREATE DATABASE guardbase_template");
    const tpl = new pg.Client({ host: dir, port, user: "postgres", database: "guardbase_template" });
    await tpl.connect();
    try {
      const migration = readFileSync(fileURLToPath(new URL("../../../../supabase/migrations/20261027000000_tenancy.sql", import.meta.url)), "utf8");
      await tpl.query(migration);
    } finally {
      await tpl.end();
    }
    await admin.query("CREATE ROLE app_user LOGIN NOSUPERUSER NOBYPASSRLS IN ROLE guardbase_app");
    await admin.query("CREATE ROLE scheduler_user LOGIN NOSUPERUSER NOBYPASSRLS IN ROLE guardbase_scheduler");
  } finally {
    await admin.end();
  }

  project.provide("pg", { host: dir, port, template: "guardbase_template" });
  return async () => {
    execFileSync(join(bin, "pg_ctl"), ["-D", data, "-m", "immediate", "stop"], { stdio: "ignore" });
    rmSync(dir, { recursive: true, force: true });
  };
}
