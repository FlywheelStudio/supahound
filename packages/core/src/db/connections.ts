import { randomUUID } from "node:crypto";
import { connectionId, type ConnectionId, type UserId } from "../tenancy/scope.js";
import type { TokenVault } from "../vault/vault.js";
import type { TenantTx } from "./tenant.js";

// A Supabase connection's life after a disconnect (issue #43, decision 037). A disconnect, in
// Supahound or a grant revoked at Supabase, empties the sealed token at once (zero bytes) and
// pauses the connection's projects, so polling stops. The history stays until delete_after (30
// days), and while the workspace pays it waits longer (the data job defers it). Reconnecting the
// same Supabase organization before then keeps the history.

export const DISCONNECT_KEEP_DAYS = 30;
export type DisconnectReason = "user" | "revoked";

export interface Disconnected {
  connection: ConnectionId;
  label: string;
  // The projects that stopped being watched, by name, for the email.
  projects: string[];
  // Everyone with a role on those projects and a known address (decision 036).
  recipients: string[];
  deleteAfter: Date;
}

// Owners and admins of the workspace, and anyone with a role on a project of this connection,
// each once (the alert recipients of decision 036, across the connection's projects).
export async function connectionRecipients(tx: TenantTx, connection: ConnectionId): Promise<string[]> {
  const rows = await tx.query<{ email: string }>(
    `SELECT DISTINCT lower(m.email) AS email FROM supahound.memberships m
     WHERE m.tenant_id = $1 AND m.email IS NOT NULL
       AND (m.role IN ('owner', 'admin')
            OR EXISTS (SELECT 1 FROM supahound.project_members pm
                       JOIN supahound.projects p ON p.tenant_id = pm.tenant_id AND p.id = pm.project_id
                       WHERE pm.tenant_id = m.tenant_id AND pm.user_id = m.user_id AND p.connection_id = $2))
     ORDER BY 1`,
    [tx.tenantId, connection],
  );
  return rows.map((r) => r.email);
}

// Marks a live connection disconnected. Only the first call returns the details: a second call
// (another poller that saw the same revocation, a double click) gets null and sends nothing.
export async function markDisconnected(
  tx: TenantTx,
  connection: ConnectionId,
  now: Date,
  reason: DisconnectReason,
  by: UserId | null,
): Promise<Disconnected | null> {
  const [row] = await tx.query<{ label: string; delete_after: Date }>(
    `UPDATE supahound.connections
     SET sealed_token = ''::bytea, disconnected_at = $3, disconnected_by = $4, disconnect_reason = $5,
         delete_after = $3::timestamptz + make_interval(days => ${DISCONNECT_KEEP_DAYS}), updated_at = $3
     WHERE tenant_id = $1 AND id = $2 AND disconnected_at IS NULL
     RETURNING label, delete_after`,
    [tx.tenantId, connection, now, by, reason],
  );
  if (!row) return null;
  const projects = await tx.query<{ name: string }>(
    "UPDATE supahound.projects SET paused = true WHERE tenant_id = $1 AND connection_id = $2 RETURNING name",
    [tx.tenantId, connection],
  );
  return {
    connection, label: row.label, projects: projects.map((p) => p.name).sort(),
    recipients: await connectionRecipients(tx, connection), deleteAfter: row.delete_after,
  };
}

// Stores the token from an OAuth callback. When the new grant lists a project that a disconnected
// connection of this workspace still holds (same Supabase project ref, so the same organization),
// the token goes into that connection and its history is kept; its projects resume. Several such
// connections merge into the most recent one. Otherwise a new connection is created.
export async function storeConnection(
  tx: TenantTx,
  vault: TokenVault,
  token: string,
  listedRefs: readonly string[] | null,
  now: Date,
): Promise<{ connection: ConnectionId; reattached: boolean }> {
  const matches = listedRefs && listedRefs.length > 0
    ? await tx.query<{ id: string }>(
      `SELECT c.id FROM supahound.connections c
       WHERE c.tenant_id = $1 AND c.disconnected_at IS NOT NULL
         AND EXISTS (SELECT 1 FROM supahound.projects p
                     WHERE p.tenant_id = c.tenant_id AND p.connection_id = c.id AND p.supabase_ref = ANY($2::text[]))
       ORDER BY c.disconnected_at DESC, c.id`,
      [tx.tenantId, listedRefs],
    )
    : [];
  if (matches.length === 0) {
    const id = connectionId(randomUUID());
    const sealed = vault.seal(token, { tenantId: tx.tenantId, connectionId: id });
    await tx.query(
      "INSERT INTO supahound.connections (id, tenant_id, label, sealed_token, key_version) VALUES ($1, $2, 'Supabase', $3, $4)",
      [id, tx.tenantId, sealed, vault.keyVersionOf(sealed)],
    );
    return { connection: id, reattached: false };
  }
  const target = connectionId(matches[0]!.id);
  for (const other of matches.slice(1)) {
    await tx.query("UPDATE supahound.projects SET connection_id = $2 WHERE tenant_id = $1 AND connection_id = $3", [tx.tenantId, target, other.id]);
    await tx.query("DELETE FROM supahound.connections WHERE tenant_id = $1 AND id = $2", [tx.tenantId, other.id]);
  }
  const sealed = vault.seal(token, { tenantId: tx.tenantId, connectionId: target });
  await tx.query(
    `UPDATE supahound.connections
     SET sealed_token = $3, key_version = $4, disconnected_at = NULL, disconnected_by = NULL, disconnect_reason = NULL,
         delete_after = NULL, updated_at = $5
     WHERE tenant_id = $1 AND id = $2`,
    [tx.tenantId, target, sealed, vault.keyVersionOf(sealed), now],
  );
  await tx.query("UPDATE supahound.projects SET paused = false WHERE tenant_id = $1 AND connection_id = $2", [tx.tenantId, target]);
  return { connection: target, reattached: true };
}

// The data job, for a workspace that pays: no disconnected history is deleted; each waits until
// 30 days after today, so it goes 30 days after the last paid day.
export async function deferConnectionDeletes(tx: TenantTx, now: Date): Promise<void> {
  await tx.query(
    `UPDATE supahound.connections
     SET delete_after = greatest(delete_after, $2::timestamptz + make_interval(days => ${DISCONNECT_KEEP_DAYS}))
     WHERE tenant_id = $1 AND disconnected_at IS NOT NULL`,
    [tx.tenantId, now],
  );
}

// The data job, for a workspace that does not pay: disconnected connections past delete_after go,
// with their projects and history (cascade). Audit rows stay (decision 022).
export async function deleteExpiredConnections(tx: TenantTx, now: Date): Promise<number> {
  const rows = await tx.query(
    `DELETE FROM supahound.connections
     WHERE tenant_id = $1 AND disconnected_at IS NOT NULL AND delete_after <= $2
     RETURNING id`,
    [tx.tenantId, now],
  );
  return rows.length;
}
