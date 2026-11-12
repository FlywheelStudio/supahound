import type { TenantId, UserId } from "../tenancy/scope.js";
import type { TenantTx } from "./tenant.js";

// Closing a workspace (issue #43, decision 037). The owner closes it; the Stripe subscription
// cancels at the end of its period and the workspace works until then (access_ends_at). Once the
// workspace no longer pays, and at least 30 days after the close, the daily data job deletes its
// logs and history. The workspace record is never deleted. Until the purge, the owner may reopen.
// Every function runs inside a tenant transaction.

export const PURGE_AFTER_DAYS = 30;

export class WorkspaceClosedError extends Error {
  constructor(readonly tenant: TenantId) {
    super("This workspace is closed");
    this.name = "WorkspaceClosedError";
  }
}

export interface Closure {
  closedAt: Date;
  closedBy: string;
  accessEndsAt: Date;
  purgeAfter: Date;
  purgedAt: Date | null;
}

interface Row {
  closed_at: Date;
  closed_by: string;
  access_ends_at: Date;
  purge_after: Date;
  purged_at: Date | null;
}

const toClosure = (r: Row): Closure => ({
  closedAt: r.closed_at, closedBy: r.closed_by, accessEndsAt: r.access_ends_at, purgeAfter: r.purge_after, purgedAt: r.purged_at,
});

// The workspace's closure, or null when it is open.
export async function getClosure(tx: TenantTx): Promise<Closure | null> {
  const [r] = await tx.query<Row>(
    "SELECT closed_at, closed_by, access_ends_at, purge_after, purged_at FROM supahound.account_closures WHERE tenant_id = $1",
    [tx.tenantId],
  );
  return r ? toClosure(r) : null;
}

// Closed for its members: the paid period after the close has ended. Before that it is "closing".
export const isClosedNow = (c: Closure | null, now: Date): boolean => c !== null && c.accessEndsAt <= now;

// Closes the workspace. accessEndsAt: the end of the paid or trial period that Stripe now cancels
// at, or `now` when nothing was paid. Cancels open invites (accepting one would add a member to a
// closing workspace) and ends a staff exemption (decision 029: closing is the owner saying they
// are done, so the data is not kept as if paid). A second call changes nothing. RLS refuses the
// insert unless the signed-in user is a workspace owner.
export async function recordClosure(tx: TenantTx, user: UserId, now: Date, accessEndsAt: Date): Promise<Closure> {
  const ends = accessEndsAt > now ? accessEndsAt : now;
  await tx.query(
    `INSERT INTO supahound.account_closures (tenant_id, closed_at, closed_by, access_ends_at, purge_after)
     VALUES ($1, $2, $3, $4, $4::timestamptz + make_interval(days => ${PURGE_AFTER_DAYS}))
     ON CONFLICT (tenant_id) DO NOTHING`,
    [tx.tenantId, now, user, ends],
  );
  await tx.query(
    `UPDATE supahound.project_invites SET canceled_at = $2
     WHERE tenant_id = $1 AND accepted_at IS NULL AND canceled_at IS NULL`,
    [tx.tenantId, now],
  );
  await tx.query(
    `UPDATE supahound.billing_accounts SET exempt_owner = NULL, exempt_at = NULL, updated_at = now()
     WHERE tenant_id = $1 AND exempt_owner IS NOT NULL`,
    [tx.tenantId],
  );
  return (await getClosure(tx))!;
}

export type ReopenResult = "reopened" | "not_closed" | "too_late";

// Reopens a closed workspace before its purge. The caller resumes the Stripe subscription when its
// cancel is still pending; once it has ended, the billing page asks for a card (no new trial).
export async function reopenWorkspace(tx: TenantTx): Promise<ReopenResult> {
  const closure = await getClosure(tx);
  if (!closure) return "not_closed";
  if (closure.purgedAt) return "too_late";
  const rows = await tx.query(
    "DELETE FROM supahound.account_closures WHERE tenant_id = $1 AND purged_at IS NULL RETURNING tenant_id",
    [tx.tenantId],
  );
  return rows.length === 1 ? "reopened" : "too_late";
}

// While the workspace pays, the purge waits: it moves to 30 days after today, so it runs 30 days
// after the last paid day.
export async function deferPurge(tx: TenantTx, now: Date): Promise<void> {
  await tx.query(
    `UPDATE supahound.account_closures
     SET purge_after = greatest(purge_after, $2::timestamptz + make_interval(days => ${PURGE_AFTER_DAYS}))
     WHERE tenant_id = $1 AND purged_at IS NULL`,
    [tx.tenantId, now],
  );
}

// The purge (decision 037): deletes the workspace's logs and history, and never its record. The
// caller has checked, in this transaction, that the workspace does not pay. Returns false, and
// changes nothing, when no purge is due.
//
// Deleted: Supabase connections (sealed tokens) and through them every project with its incidents,
// findings, poll runs, service-key networks, usage, project roles and invites; OAuth states; scans
// with their findings and jobs.
// Kept: the tenants row, memberships (members still open the closed page), billing_accounts and
// stripe_events (the payment history), audit_log (its rows lose their project link, decision 022),
// scan domains and authorizations (the consent record), and the closure row.
export async function purgeHistory(tx: TenantTx, now: Date): Promise<boolean> {
  const due = await tx.query(
    `UPDATE supahound.account_closures SET purged_at = $2
     WHERE tenant_id = $1 AND purged_at IS NULL AND purge_after <= $2
     RETURNING tenant_id`,
    [tx.tenantId, now],
  );
  if (due.length !== 1) return false;
  await tx.query("DELETE FROM supahound.connections WHERE tenant_id = $1", [tx.tenantId]);
  // Projects always hang off a connection; this catches nothing today and anything added later.
  await tx.query("DELETE FROM supahound.projects WHERE tenant_id = $1", [tx.tenantId]);
  await tx.query("DELETE FROM supahound.oauth_states WHERE tenant_id = $1", [tx.tenantId]);
  await tx.query("DELETE FROM supahound.scans WHERE tenant_id = $1", [tx.tenantId]);
  return true;
}
