import type { Pool } from "pg";
import { withTenant } from "../db/tenant.js";
import type { ConnectionId, TenantId } from "../tenancy/scope.js";
import type { TokenVault } from "../vault/vault.js";
import { needsRefresh, parseCredentials, refreshCredentials, type OAuthClient } from "./oauth.js";

// Returns a usable access token for a connection, refreshing it when it is near expiry.
//
// Refresh holds the connection's row lock (SELECT ... FOR UPDATE) across the token request. This
// is the one place a transaction spans an external call, on purpose: Supabase may rotate refresh
// tokens, so two pollers refreshing at once would burn the grant. The second waiter re-reads the
// row after the first commits and finds a fresh token. The token request times out at 10 s.
export async function accessTokenFor(
  pool: Pool,
  vault: TokenVault,
  tenant: TenantId,
  connection: ConnectionId,
  client: OAuthClient | null,
  now: Date,
): Promise<string> {
  return withTenant(pool, tenant, async (tx) => {
    const rows = await tx.query<{ sealed_token: Buffer }>(
      "SELECT sealed_token FROM guardbase.connections WHERE tenant_id = $1 AND id = $2 FOR UPDATE",
      [tenant, connection],
    );
    const row = rows[0];
    if (!row) throw new Error("Connection not found for this tenant");
    const binding = { tenantId: tenant, connectionId: connection };
    const creds = parseCredentials(vault.open(row.sealed_token, binding));
    if (!client || !needsRefresh(creds, now)) return creds.accessToken;

    const next = await refreshCredentials(client, creds, now);
    const sealed = vault.seal(JSON.stringify(next), binding);
    await tx.query(
      "UPDATE guardbase.connections SET sealed_token = $3, key_version = $4, updated_at = $5 WHERE tenant_id = $1 AND id = $2",
      [tenant, connection, sealed, vault.keyVersionOf(sealed), now],
    );
    return next.accessToken;
  });
}
