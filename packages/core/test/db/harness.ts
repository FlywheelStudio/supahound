import { randomBytes, randomUUID } from "node:crypto";
import pg from "pg";
import { afterAll, beforeAll, inject } from "vitest";
import { TokenVault } from "../../src/vault/vault.js";

// Per-file database cloned from the migrated template, plus pools for each role.
export interface Db {
  app: pg.Pool;
  scheduler: pg.Pool;
  admin: pg.Pool;
  vault: TokenVault;
}

export const pgInfo = inject("pg");

export function useDb(): Db {
  const db = {} as Db;
  const name = `t_${randomUUID().replace(/-/g, "")}`;

  beforeAll(async () => {
    const info = pgInfo!;
    const root = new pg.Client({ host: info.host, port: info.port, user: "postgres", database: "postgres" });
    await root.connect();
    await root.query(`CREATE DATABASE ${name} TEMPLATE ${info.template}`);
    await root.end();
    const conn = { host: info.host, port: info.port, database: name };
    db.app = new pg.Pool({ ...conn, user: "app_user", max: 4 });
    db.scheduler = new pg.Pool({ ...conn, user: "scheduler_user", max: 2 });
    db.admin = new pg.Pool({ ...conn, user: "postgres", max: 2 });
    db.vault = new TokenVault(new Map([[1, randomBytes(32)]]));
  });

  afterAll(async () => {
    await Promise.all([db.app?.end(), db.scheduler?.end(), db.admin?.end()]);
  });

  return db;
}
