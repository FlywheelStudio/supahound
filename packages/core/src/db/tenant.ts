import type { Pool, PoolClient, QueryResultRow } from "pg";
import type { TenantId } from "../tenancy/scope.js";

// The only way the app touches tenant data: one transaction, pinned to one tenant through the
// app.tenant_id setting that every RLS policy reads. set_config(..., true) is transaction-local,
// so a pooled connection carries nothing into the next checkout.
//
// Keep these transactions short: never call Supabase or a model from inside one.

export class TenantTx {
  private open = true;

  constructor(
    private readonly client: PoolClient,
    readonly tenantId: TenantId,
  ) {}

  async query<R extends QueryResultRow = QueryResultRow>(sql: string, params: unknown[] = []): Promise<R[]> {
    if (!this.open) throw new Error("Tenant transaction is closed");
    const res = await this.client.query<R>(sql, params);
    return res.rows;
  }

  close(): void {
    this.open = false;
  }
}

export async function withTenant<T>(pool: Pool, tenant: TenantId, fn: (tx: TenantTx) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  const tx = new TenantTx(client, tenant);
  try {
    await client.query("BEGIN");
    await client.query("SELECT set_config('app.tenant_id', $1, true)", [tenant]);
    const result = await fn(tx);
    await client.query("COMMIT");
    return result;
  } catch (err) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw err;
  } finally {
    tx.close();
    client.release();
  }
}
