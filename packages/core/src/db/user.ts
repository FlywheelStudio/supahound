import { randomUUID } from "node:crypto";
import type { Pool, PoolClient } from "pg";
import { tenantId, type TenantId, type UserId } from "../tenancy/scope.js";
import { isStorableEmail } from "./repo.js";
import { begin, TenantTx } from "./tenant.js";

// Entry points for signed-in users (decision 009). The user ID must come from a verified
// Supabase JWT. Tenant data is reachable only through withTenantForUser, which confirms
// membership inside the same transaction before the callback runs.

export type Role = "owner" | "admin" | "member";

export class NotAMemberError extends Error {
  constructor() {
    super("Not a member of this workspace");
    this.name = "NotAMemberError";
  }
}

export interface Workspace {
  tenantId: TenantId;
  name: string;
  role: Role;
}

async function transaction<T>(pool: Pool, settings: Record<string, string>, fn: (client: PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    await begin(client, settings);
    const result = await fn(client);
    await client.query("COMMIT");
    return result;
  } catch (err) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw err;
  } finally {
    client.release();
  }
}

// The workspaces this user belongs to. Only the user GUC is set, so RLS exposes the user's own
// memberships and those tenants' names, nothing more.
export async function listWorkspaces(pool: Pool, user: UserId): Promise<Workspace[]> {
  return transaction(pool, { "app.user_id": user }, async (client) => {
    const res = await client.query<{ tenant_id: string; name: string; role: Role }>(
      `SELECT m.tenant_id, t.name, m.role
       FROM supahound.memberships m JOIN supahound.tenants t ON t.id = m.tenant_id
       WHERE m.user_id = $1 ORDER BY t.name`,
      [user],
    );
    return res.rows.map((r) => ({ tenantId: tenantId(r.tenant_id), name: r.name, role: r.role }));
  });
}

// Creates a tenant with the user as its owner.
// email: the owner's address from verified JWT claims, for incident alerts (decision 030).
export async function createWorkspace(pool: Pool, user: UserId, name: string, email?: string | null): Promise<TenantId> {
  const id = tenantId(randomUUID());
  await transaction(pool, { "app.tenant_id": id, "app.user_id": user }, async (client) => {
    await client.query("INSERT INTO supahound.tenants (id, name) VALUES ($1, $2)", [id, name]);
    await client.query(
      "INSERT INTO supahound.memberships (tenant_id, user_id, role, email) VALUES ($1, $2, 'owner', $3)",
      [id, user, isStorableEmail(email) ? email : null],
    );
  });
  return id;
}

// Runs fn inside the tenant only if the user is a member; otherwise throws before fn runs.
export async function withTenantForUser<T>(
  pool: Pool,
  user: UserId,
  tenant: TenantId,
  fn: (tx: TenantTx, role: Role) => Promise<T>,
): Promise<T> {
  return transaction(pool, { "app.tenant_id": tenant, "app.user_id": user }, async (client) => {
    const res = await client.query<{ role: Role }>(
      "SELECT role FROM supahound.memberships WHERE tenant_id = $1 AND user_id = $2",
      [tenant, user],
    );
    const role = res.rows[0]?.role;
    if (!role) throw new NotAMemberError();
    const tx = new TenantTx(client, tenant);
    try {
      return await fn(tx, role);
    } finally {
      tx.close();
    }
  });
}
