import { env } from "cloudflare:workers";
import pg from "pg";

// One small pool per request: Workers may not share I/O objects across requests. Reaches
// Postgres through Hyperdrive as a member of guardbase_app; tenant data only through
// withTenantForUser (packages/core/src/db/user.ts).
export async function withPool<T>(fn: (pool: pg.Pool) => Promise<T>): Promise<T> {
  const pool = new pg.Pool({ connectionString: env.HYPERDRIVE_APP.connectionString, max: 2 });
  try {
    return await fn(pool);
  } finally {
    await pool.end();
  }
}
