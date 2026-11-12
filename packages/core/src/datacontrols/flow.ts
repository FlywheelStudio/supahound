import type { Pool } from "pg";
import type { StripeGateway } from "../billing/flow.js";
import { getBilling, saveSubscription, type SubscriptionSnapshot } from "../db/billing.js";
import { expireKeptRecords, getClosure, KEEP_RECORDS_YEARS, purgeTenant, recordClosure, reopenWorkspace, type ReopenResult } from "../db/closure.js";
import { listConnections } from "../db/repo.js";
import { applyRetention, type RetentionResult } from "../db/retention.js";
import { withTenant } from "../db/tenant.js";
import { withTenantForUser } from "../db/user.js";
import { parseCredentials } from "../supabase/oauth.js";
import type { ConnectionId, TenantId, UserId } from "../tenancy/scope.js";
import type { TokenVault } from "../vault/vault.js";

// Data controls (issue #43, decision 037): close and reopen a workspace, disconnect a Supabase
// connection, and the daily data job. No external call (Stripe, Supabase) runs inside a tenant
// transaction: read and check, close, call, then write in a new transaction that checks again.

// The typed confirmation must match exactly, apart from surrounding spaces (decision 022's rule).
export const confirms = (typed: string, expected: string): boolean => typed.trim() === expected;

export type CloseResult = "closed" | "already_closed" | "role" | "mismatch";

export interface CloseDeps {
  pool: Pool;
  // Null when billing is off (self-hosting): nothing to cancel.
  stripe: Pick<StripeGateway, "cancelSubscription"> | null;
  now: () => Date;
}

// Statuses whose subscription still bills, or may bill again, and so must be canceled.
const ENDED = new Set(["canceled", "incomplete_expired"]);

// The workspace owner closes the workspace after typing its name. Stripe is canceled first: if
// that fails, nothing is closed and the owner can try again. A retry after a failed save finds
// the subscription canceled and closes the workspace.
export async function closeWorkspace(deps: CloseDeps, input: { user: UserId; tenant: TenantId; typedName: string }): Promise<CloseResult> {
  const { user, tenant } = input;
  const pre = await withTenantForUser(deps.pool, user, tenant, async (tx, role) => {
    if (role !== "owner") return { stop: "role" as const };
    if (await getClosure(tx)) return { stop: "already_closed" as const };
    const [t] = await tx.query<{ name: string }>("SELECT name FROM supahound.tenants WHERE id = $1", [tenant]);
    if (!t || !confirms(input.typedName, t.name)) return { stop: "mismatch" as const };
    const billing = await getBilling(tx);
    return { stop: null, subscription: billing.subscriptionId && !ENDED.has(billing.status) ? billing.subscriptionId : null };
  });
  if (pre.stop) return pre.stop;

  let canceled: SubscriptionSnapshot | null = null;
  if ("subscription" in pre && pre.subscription && deps.stripe) canceled = await deps.stripe.cancelSubscription(pre.subscription);

  return withTenantForUser(deps.pool, user, tenant, async (tx, role) => {
    if (role !== "owner") return "role";
    if (await getClosure(tx)) return "already_closed";
    // Save Stripe's answer now rather than wait for the webhook.
    if (canceled) await saveSubscription(tx, canceled, null);
    await recordClosure(tx, user, deps.now());
    return "closed";
  });
}

export type ReopenOutcome = ReopenResult | "role";

export async function reopenClosedWorkspace(pool: Pool, input: { user: UserId; tenant: TenantId; now: Date }): Promise<ReopenOutcome> {
  return withTenantForUser(pool, input.user, input.tenant, async (tx, role) => {
    if (role !== "owner") return "role";
    return reopenWorkspace(tx, input.now);
  });
}

export type DisconnectResult = "disconnected" | "role" | "mismatch" | "missing";

export interface DisconnectDeps {
  pool: Pool;
  vault: TokenVault;
  // Ends the grant at Supabase; best effort (supabase/oauth.ts revokeGrant). Null: skip.
  revoke: ((refreshToken: string) => Promise<boolean>) | null;
}

export interface DisconnectOutcome {
  result: DisconnectResult;
  // True when Supabase confirmed the grant is revoked. False: the owner must remove the app in
  // their Supabase organization (the page says so).
  revoked: boolean;
  projectsRemoved: number;
}

// A workspace owner or admin disconnects a Supabase connection after typing its label. The
// sealed token is deleted with the connection row, and so are the projects watched through it,
// with their incidents, findings and poll runs; their audit rows stay (decision 022). Polling
// stops at once: the scheduler no longer sees the projects, and a poll already running fails
// its claim or its token read. RLS refuses the delete for any other role.
export async function disconnectConnection(
  deps: DisconnectDeps,
  input: { user: UserId; tenant: TenantId; connection: ConnectionId; typedLabel: string },
): Promise<DisconnectOutcome> {
  const none = (result: DisconnectResult): DisconnectOutcome => ({ result, revoked: false, projectsRemoved: 0 });
  const pre = await withTenantForUser(deps.pool, input.user, input.tenant, async (tx, role) => {
    if (role === "member") return { stop: "role" as const };
    const conn = (await listConnections(tx)).find((c) => c.id === input.connection);
    if (!conn) return { stop: "missing" as const };
    if (!confirms(input.typedLabel, conn.label)) return { stop: "mismatch" as const };
    const [row] = await tx.query<{ sealed_token: Buffer }>(
      "SELECT sealed_token FROM supahound.connections WHERE tenant_id = $1 AND id = $2",
      [tx.tenantId, input.connection],
    );
    let refreshToken: string | null = null;
    try {
      refreshToken = parseCredentials(deps.vault.open(row!.sealed_token, { tenantId: tx.tenantId, connectionId: input.connection })).refreshToken;
    } catch {
      // A token that no longer opens cannot be revoked; deleting it is still right.
    }
    return { stop: null, refreshToken };
  });
  if (pre.stop) return none(pre.stop);

  const revoked = "refreshToken" in pre && pre.refreshToken && deps.revoke ? await deps.revoke(pre.refreshToken).catch(() => false) : false;

  return withTenantForUser(deps.pool, input.user, input.tenant, async (tx, role) => {
    if (role === "member") return none("role");
    const [{ n }] = await tx.query<{ n: number }>(
      "SELECT count(*)::int AS n FROM supahound.projects WHERE tenant_id = $1 AND connection_id = $2",
      [tx.tenantId, input.connection],
    ) as [{ n: number }];
    const deleted = await tx.query("DELETE FROM supahound.connections WHERE tenant_id = $1 AND id = $2 RETURNING id", [
      tx.tenantId, input.connection,
    ]);
    if (deleted.length !== 1) return none("missing");
    return { result: "disconnected", revoked, projectsRemoved: n };
  });
}

export type DataJobOutcome =
  | { kind: "retention"; retention: RetentionResult }
  | { kind: "purged" }
  | { kind: "records_expired" }
  | { kind: "nothing" };

// The daily data job for one tenant (decision 037), in one tenant transaction. A closed workspace
// past its purge date is purged (retention is moot); a purged one has its kept records deleted
// after KEEP_RECORDS_YEARS; every other tenant gets incident retention.
export async function runDataJob(pool: Pool, tenant: TenantId, now: Date): Promise<DataJobOutcome> {
  return withTenant(pool, tenant, async (tx) => {
    const closure = await getClosure(tx);
    if (closure?.purgedAt) {
      return (await expireKeptRecords(tx, now)) ? { kind: "records_expired" } : { kind: "nothing" };
    }
    if (closure && closure.purgeAfter <= now) {
      return (await purgeTenant(tx, now)) ? { kind: "purged" } : { kind: "nothing" };
    }
    return { kind: "retention", retention: await applyRetention(tx, now) };
  });
}

export { KEEP_RECORDS_YEARS };
