import type { Pool } from "pg";
import {
  accessFor, isBillingStatus, isTier, tierFor, USAGE_WINDOW_DAYS,
  type Access, type BillingStatus, type CardRejection, type Seats, type Tier,
} from "../billing/policy.js";
import type { ProjectId, TenantId, UserId } from "../tenancy/scope.js";
import type { TenantTx } from "./tenant.js";
import { withTenantForUser, type Role } from "./user.js";

// Billing rows (decision 028). Every function runs inside a tenant transaction. Never call Stripe
// from inside one: read, close, call Stripe, then write in a new transaction.

// "stripe": the hosted product; a tenant needs a validated card. "off": self-hosted without billing.
export type BillingMode = "stripe" | "off";

export function billingMode(value: unknown): BillingMode {
  if (value === "stripe" || value === "off") return value;
  throw new Error('SUPAHOUND_BILLING must be "stripe" or "off"');
}

export class PaymentRequiredError extends Error {
  constructor(readonly tenant: TenantId) {
    super("This workspace needs a validated card");
    this.name = "PaymentRequiredError";
  }
}

export interface BillingAccount {
  customerId: string | null;
  status: BillingStatus;
  subscriptionId: string | null;
  seats: Seats | null;
  trialEnd: Date | null;
  currentPeriodEnd: Date | null;
  cancelAtPeriodEnd: boolean;
  cardVerifiedAt: Date | null;
  verificationError: string | null;
  termsVersion: string | null;
  termsAcceptedAt: Date | null;
}

interface Row {
  stripe_customer_id: string | null;
  status: string;
  subscription_id: string | null;
  starter_seats: number | null;
  pro_seats: number | null;
  trial_end: Date | null;
  current_period_end: Date | null;
  cancel_at_period_end: boolean;
  card_verified_at: Date | null;
  verification_error: string | null;
  terms_version: string | null;
  terms_accepted_at: Date | null;
}

const NONE: BillingAccount = {
  customerId: null, status: "none", subscriptionId: null, seats: null, trialEnd: null, currentPeriodEnd: null,
  cancelAtPeriodEnd: false, cardVerifiedAt: null, verificationError: null, termsVersion: null, termsAcceptedAt: null,
};

// The tenant's billing state; a tenant with no row has status "none".
export async function getBilling(tx: TenantTx): Promise<BillingAccount> {
  const [r] = await tx.query<Row>(
    `SELECT stripe_customer_id, status, subscription_id, starter_seats, pro_seats, trial_end, current_period_end,
            cancel_at_period_end, card_verified_at, verification_error, terms_version, terms_accepted_at
     FROM supahound.billing_accounts WHERE tenant_id = $1`,
    [tx.tenantId],
  );
  if (!r) return NONE;
  return {
    customerId: r.stripe_customer_id,
    status: isBillingStatus(r.status) ? r.status : "none",
    subscriptionId: r.subscription_id,
    seats: r.starter_seats === null || r.pro_seats === null ? null : { starter: r.starter_seats, pro: r.pro_seats },
    trialEnd: r.trial_end,
    currentPeriodEnd: r.current_period_end,
    cancelAtPeriodEnd: r.cancel_at_period_end,
    cardVerifiedAt: r.card_verified_at,
    verificationError: r.verification_error,
    termsVersion: r.terms_version,
    termsAcceptedAt: r.terms_accepted_at,
  };
}

// $1 is always the tenant. Creates the row on first use, then applies the assignments. `set` is
// a constant from this file, never input.
async function upsert(tx: TenantTx, set: string, params: unknown[]): Promise<void> {
  await tx.query("INSERT INTO supahound.billing_accounts (tenant_id) VALUES ($1) ON CONFLICT (tenant_id) DO NOTHING", [tx.tenantId]);
  await tx.query(`UPDATE supahound.billing_accounts SET ${set}, updated_at = now() WHERE tenant_id = $1`, [tx.tenantId, ...params]);
}

// The owner accepted the billing terms on our page, just before Checkout.
export async function acceptBillingTerms(tx: TenantTx, version: string, at: Date): Promise<void> {
  await upsert(tx, "terms_version = $2, terms_accepted_at = $3, verification_error = NULL", [version, at]);
}

export async function setStripeCustomer(tx: TenantTx, customerId: string): Promise<void> {
  await upsert(tx, "stripe_customer_id = $2", [customerId]);
}

export async function recordCardRejected(tx: TenantTx, reason: CardRejection | "error"): Promise<void> {
  await upsert(tx, "verification_error = $2", [reason]);
}

export interface SubscriptionSnapshot {
  id: string;
  customerId: string;
  status: BillingStatus;
  seats: Seats;
  trialEnd: Date | null;
  currentPeriodEnd: Date | null;
  cancelAtPeriodEnd: boolean;
}

// Writes Stripe's current view of the subscription. cardVerifiedAt is set when the subscription
// is first created after a card check; later refreshes keep the first value.
export async function saveSubscription(tx: TenantTx, s: SubscriptionSnapshot, cardVerifiedAt: Date | null): Promise<void> {
  await upsert(
    tx,
    `stripe_customer_id = $2, status = $3, subscription_id = $4, starter_seats = $5, pro_seats = $6, trial_end = $7,
     current_period_end = $8, cancel_at_period_end = $9, card_verified_at = COALESCE(card_verified_at, $10),
     verification_error = NULL`,
    [s.customerId, s.status, s.id, s.seats.starter, s.seats.pro, s.trialEnd, s.currentPeriodEnd, s.cancelAtPeriodEnd, cardVerifiedAt],
  );
}

export async function saveSeats(tx: TenantTx, seats: Seats): Promise<void> {
  await upsert(tx, "starter_seats = $2, pro_seats = $3", [seats.starter, seats.pro]);
}

export async function isStripeEventProcessed(tx: TenantTx, eventId: string): Promise<boolean> {
  const rows = await tx.query("SELECT 1 FROM supahound.stripe_events WHERE tenant_id = $1 AND event_id = $2", [tx.tenantId, eventId]);
  return rows.length === 1;
}

// Records a Stripe event for this tenant. False when it was already processed (a replay).
export async function claimStripeEvent(tx: TenantTx, eventId: string, type: string): Promise<boolean> {
  const rows = await tx.query(
    `INSERT INTO supahound.stripe_events (tenant_id, event_id, type) VALUES ($1, $2, $3)
     ON CONFLICT (tenant_id, event_id) DO NOTHING RETURNING event_id`,
    [tx.tenantId, eventId, type],
  );
  return rows.length === 1;
}

// --- Usage and tiers -------------------------------------------------------------------------------

export interface ProjectTier {
  id: ProjectId;
  tier: Tier;
  requests30d: number | null;
}

export async function projectTiers(tx: TenantTx): Promise<ProjectTier[]> {
  const rows = await tx.query<{ id: ProjectId; billing_tier: string; requests_30d: string | null }>(
    "SELECT id, billing_tier, requests_30d FROM supahound.projects WHERE tenant_id = $1 ORDER BY created_at",
    [tx.tenantId],
  );
  return rows.map((r) => ({
    id: r.id, tier: isTier(r.billing_tier) ? r.billing_tier : "starter", requests30d: r.requests_30d === null ? null : Number(r.requests_30d),
  }));
}

// One UTC day of edge-log requests for one project. Counting the same day again replaces it.
export async function saveDailyUsage(tx: TenantTx, project: ProjectId, day: string, requests: number): Promise<void> {
  await tx.query(
    `INSERT INTO supahound.project_usage (tenant_id, project_id, day, requests) VALUES ($1, $2, $3, $4)
     ON CONFLICT (tenant_id, project_id, day) DO UPDATE SET requests = EXCLUDED.requests, counted_at = now()`,
    [tx.tenantId, project, day, requests],
  );
}

// Sums each project's last 30 counted days (up to and including `today`) and sets its tier.
export async function refreshProjectTiers(tx: TenantTx, today: string): Promise<ProjectTier[]> {
  const rows = await tx.query<{ id: ProjectId; total: string }>(
    `SELECT p.id, COALESCE(sum(u.requests), 0)::bigint AS total
     FROM supahound.projects p
     LEFT JOIN supahound.project_usage u
       ON u.tenant_id = p.tenant_id AND u.project_id = p.id
      AND u.day > $2::date - $3::int AND u.day <= $2::date
     WHERE p.tenant_id = $1
     GROUP BY p.id`,
    [tx.tenantId, today, USAGE_WINDOW_DAYS],
  );
  for (const r of rows) {
    const total = Number(r.total);
    await tx.query(
      `UPDATE supahound.projects SET requests_30d = $3, billing_tier = $4, usage_counted_at = now()
       WHERE tenant_id = $1 AND id = $2`,
      [tx.tenantId, r.id, total, tierFor(total)],
    );
  }
  return projectTiers(tx);
}

// The gate (decision 028, point 7). The only tenant entry point for signed-in pages and actions
// other than the billing routes. Membership and billing are both checked inside the transaction
// that runs fn; a tenant without a validated card gets PaymentRequiredError before fn runs.
export async function withPaidTenantForUser<T>(
  pool: Pool,
  mode: BillingMode,
  user: UserId,
  tenant: TenantId,
  fn: (tx: TenantTx, role: Role, access: Access) => Promise<T>,
): Promise<T> {
  return withTenantForUser(pool, user, tenant, async (tx, role) => {
    if (mode === "off") return fn(tx, role, "full");
    const access = accessFor((await getBilling(tx)).status);
    if (access === "blocked") throw new PaymentRequiredError(tenant);
    return fn(tx, role, access);
  });
}
