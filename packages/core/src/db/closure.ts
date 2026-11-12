import type { TenantId, UserId } from "../tenancy/scope.js";
import type { TenantTx } from "./tenant.js";

// Closing a workspace (issue #43, decision 037). The owner closes it; polling stops at once
// (every project is paused); 30 days later the daily data job purges the tenant. Until then the
// owner may reopen it. Every function runs inside a tenant transaction.

export const PURGE_AFTER_DAYS = 30;
// The tax and legal records the purge keeps (decision 037) are deleted this long after it.
export const KEEP_RECORDS_YEARS = 7;

export class WorkspaceClosedError extends Error {
  constructor(readonly tenant: TenantId) {
    super("This workspace is closed");
    this.name = "WorkspaceClosedError";
  }
}

export interface Closure {
  closedAt: Date;
  closedBy: string;
  purgeAfter: Date;
  purgedAt: Date | null;
}

interface Row {
  closed_at: Date;
  closed_by: string;
  purge_after: Date;
  purged_at: Date | null;
}

const toClosure = (r: Row): Closure => ({ closedAt: r.closed_at, closedBy: r.closed_by, purgeAfter: r.purge_after, purgedAt: r.purged_at });

// The workspace's closure, or null when it is open.
export async function getClosure(tx: TenantTx): Promise<Closure | null> {
  const [r] = await tx.query<Row>(
    "SELECT closed_at, closed_by, purge_after, purged_at FROM supahound.account_closures WHERE tenant_id = $1",
    [tx.tenantId],
  );
  return r ? toClosure(r) : null;
}

// Closes the workspace: records the closure, pauses every project (the poller skips paused
// projects, in this code and in the code before it), and cancels open invites (accepting one
// would add a member to a closed workspace). A second call changes nothing. RLS refuses the insert
// unless the signed-in user is a workspace owner.
export async function recordClosure(tx: TenantTx, user: UserId, now: Date): Promise<Closure> {
  await tx.query(
    `INSERT INTO supahound.account_closures (tenant_id, closed_at, closed_by, purge_after)
     VALUES ($1, $2, $3, $2::timestamptz + make_interval(days => ${PURGE_AFTER_DAYS}))
     ON CONFLICT (tenant_id) DO NOTHING`,
    [tx.tenantId, now, user],
  );
  await tx.query("UPDATE supahound.projects SET paused = true WHERE tenant_id = $1 AND NOT paused", [tx.tenantId]);
  await tx.query(
    `UPDATE supahound.project_invites SET canceled_at = $2
     WHERE tenant_id = $1 AND accepted_at IS NULL AND canceled_at IS NULL`,
    [tx.tenantId, now],
  );
  return (await getClosure(tx))!;
}

export type ReopenResult = "reopened" | "not_closed" | "too_late";

// Reopens a closed workspace before its purge and resumes polling. No code pauses a project for
// any other reason, so every project resumes. Billing starts again from the billing page: closing
// canceled the subscription.
export async function reopenWorkspace(tx: TenantTx, now: Date): Promise<ReopenResult> {
  const closure = await getClosure(tx);
  if (!closure) return "not_closed";
  if (closure.purgedAt || closure.purgeAfter <= now) return "too_late";
  const rows = await tx.query(
    "DELETE FROM supahound.account_closures WHERE tenant_id = $1 AND purged_at IS NULL RETURNING tenant_id",
    [tx.tenantId],
  );
  if (rows.length !== 1) return "too_late";
  await tx.query("UPDATE supahound.projects SET paused = false WHERE tenant_id = $1 AND paused", [tx.tenantId]);
  return "reopened";
}

// The purge, once purge_after has passed. Copies the records Supahound keeps (decision 037) onto
// the closure row, then deletes the tenant row: every other row of the tenant goes with it through
// the foreign keys (ON DELETE CASCADE from tenants, connections and projects). Returns false, and
// changes nothing, when no purge is due.
export async function purgeTenant(tx: TenantTx, now: Date): Promise<boolean> {
  const kept = await tx.query(
    `UPDATE supahound.account_closures c SET
       purged_at = $2,
       stripe_customer_id = b.stripe_customer_id,
       subscription_id = b.subscription_id,
       terms_version = b.terms_version,
       terms_accepted_at = b.terms_accepted_at,
       card_verified_at = b.card_verified_at,
       scan_consents = COALESCE((
         SELECT jsonb_agg(jsonb_build_object(
                  'domain', d.apex, 'tos_version', a.tos_version, 'email', a.email,
                  'ip', host(a.ip), 'accepted_at', a.accepted_at) ORDER BY a.accepted_at)
         FROM supahound.scan_authorizations a
         JOIN supahound.scan_domains d ON d.tenant_id = a.tenant_id AND d.id = a.domain_id
         WHERE a.tenant_id = $1), '[]'::jsonb)
     FROM (SELECT $1::uuid AS tenant_id) t
     LEFT JOIN supahound.billing_accounts b ON b.tenant_id = t.tenant_id
     WHERE c.tenant_id = t.tenant_id AND c.tenant_id = $1 AND c.purged_at IS NULL AND c.purge_after <= $2
     RETURNING c.tenant_id`,
    [tx.tenantId, now],
  );
  if (kept.length !== 1) return false;
  await tx.query("DELETE FROM supahound.tenants WHERE id = $1", [tx.tenantId]);
  return true;
}

// Deletes the kept records KEEP_RECORDS_YEARS after the purge. RLS allows this delete only then.
export async function expireKeptRecords(tx: TenantTx, now: Date): Promise<boolean> {
  const rows = await tx.query(
    `DELETE FROM supahound.account_closures
     WHERE tenant_id = $1 AND purged_at < $2::timestamptz - make_interval(years => ${KEEP_RECORDS_YEARS})
     RETURNING tenant_id`,
    [tx.tenantId, now],
  );
  return rows.length === 1;
}

export interface KeptRecord {
  purgedAt: Date | null;
  stripeCustomerId: string | null;
  subscriptionId: string | null;
  termsVersion: string | null;
  termsAcceptedAt: Date | null;
  cardVerifiedAt: Date | null;
  scanConsents: unknown[];
}

// What the purge kept, for tests and support.
export async function keptRecord(tx: TenantTx): Promise<KeptRecord | null> {
  const [r] = await tx.query<{
    purged_at: Date | null; stripe_customer_id: string | null; subscription_id: string | null; terms_version: string | null;
    terms_accepted_at: Date | null; card_verified_at: Date | null; scan_consents: unknown[];
  }>(
    `SELECT purged_at, stripe_customer_id, subscription_id, terms_version, terms_accepted_at, card_verified_at, scan_consents
     FROM supahound.account_closures WHERE tenant_id = $1`,
    [tx.tenantId],
  );
  if (!r) return null;
  return {
    purgedAt: r.purged_at, stripeCustomerId: r.stripe_customer_id, subscriptionId: r.subscription_id,
    termsVersion: r.terms_version, termsAcceptedAt: r.terms_accepted_at, cardVerifiedAt: r.card_verified_at,
    scanConsents: r.scan_consents,
  };
}
