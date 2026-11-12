import type { Pool } from "pg";
import {
  acceptBillingTerms, billedTiers, claimStripeEvent, getBilling, isStripeEventProcessed, listProjectSubscriptions, projectTiers,
  recordCardRejected, refreshProjectTiers, refreshStanding, relinkProjectSubscription, saveProjectSubscription, saveSeats,
  saveSubscription, setStripeCustomer, startProjectBilling, trialAvailable, watchedProjects,
} from "../db/billing.js";
import { getClosure } from "../db/closure.js";
import { applyPortalCancel } from "../db/removal.js";
import { withTenant } from "../db/tenant.js";
import { withTenantForUser } from "../db/user.js";
import { tenantId as parseTenantId, type TenantId, type UserId } from "../tenancy/scope.js";
import { accessFor, accessForAccount, checkCard, seatsFor, TERMS_VERSION, TRIAL_DAYS, type CardEvidence, type CardRejection, type Seats, type Tier } from "./policy.js";
import { createKey, isLive, planReconcile } from "./projects.js";
import { projectSubFromStripe, type InvoiceSummary, type StripeSubscription } from "./stripeMap.js";

// The billing flow (decision 028). Stripe sits behind StripeGateway, so the flow runs against a
// fake in tests. No Stripe call ever runs inside a tenant transaction.

export interface VerificationSession {
  id: string;
  status: "open" | "complete" | "expired";
  tenant: string | null; // metadata.tenant_id, set by our server when it created the session
  customerId: string | null;
  // metadata.trial, set by our server: false when the owner already had a trial elsewhere.
  trialAllowed: boolean;
  hold: (CardEvidence & { paymentIntentId: string; releasable: boolean; paymentMethodId: string | null }) | null;
}

export interface StripeGateway {
  createCustomer(input: { tenant: TenantId; email: string | null; idempotencyKey: string }): Promise<{ id: string }>;
  createVerificationCheckout(input: {
    tenant: TenantId; customerId: string; successUrl: string; cancelUrl: string; trial: boolean;
  }): Promise<{ id: string; url: string }>;
  getVerificationSession(id: string): Promise<VerificationSession>;
  releaseHold(paymentIntentId: string): Promise<void>;
  // The customer's seat subscription (decision 028) that has not ended, if one exists. Project
  // subscriptions (metadata.project_id) are never returned.
  liveSubscription(customerId: string): Promise<StripeSubscription | null>;
  getSubscription(id: string): Promise<StripeSubscription>;
  // prorate: true when the customer adds or removes a project (charged now, pro rata); false when
  // a project changes tier from its usage, which takes effect at the next renewal (decision 028).
  setSeats(subscriptionId: string, seats: Seats, prorate: boolean): Promise<void>;
  portalUrl(customerId: string, returnUrl: string): Promise<string>;
  // Closing a workspace cancels at the end of the paid period; reopening undoes it (decision 037).
  // converted: the conversion CLI marks the seat subscription it cancels (decision 041).
  setCancelAtPeriodEnd(
    subscriptionId: string, cancel: boolean, options?: { converted?: boolean; idempotencyKey?: string },
  ): Promise<StripeSubscription>;

  // One subscription per project (decision 041).
  // Every project subscription bills the customer's default card, so a new card reaches them all.
  setInvoicePaymentMethod(customerId: string, paymentMethodId: string, idempotencyKey: string): Promise<void>;
  createProjectSubscription(input: {
    tenant: TenantId; projectId: string; supabaseRef: string; customerId: string; tier: Tier;
    trialEnd: Date | null; anchor: Date | null; idempotencyKey: string;
  }): Promise<StripeSubscription>;
  // Every subscription of the customer, live or not.
  customerSubscriptions(customerId: string): Promise<StripeSubscription[]>;
  setProjectTier(subscriptionId: string, tier: Tier): Promise<StripeSubscription>;
  invoices(subscriptionId: string, limit: number): Promise<InvoiceSummary[]>;
}

export interface FlowDeps {
  pool: Pool;
  stripe: StripeGateway;
  appUrl: string;
  now: () => Date;
}

function parseTenant(v: string | null): TenantId | null {
  if (!v) return null;
  try {
    return parseTenantId(v);
  } catch {
    return null;
  }
}

export const billingPath = (tenant: TenantId, error?: string) => `/w/${tenant}/billing${error ? `?error=${error}` : ""}`;

// "Add card": owners and admins only, after they accept the terms on our page. Returns where to
// send the browser: Stripe Checkout, or back to one of our pages.
export async function startCheckout(
  deps: FlowDeps,
  input: { user: UserId; email: string | null; tenant: TenantId; acceptedTerms: boolean },
): Promise<string> {
  const { tenant } = input;
  const state: { next: string } | { customerId: string | null; trial: boolean } = await withTenantForUser(deps.pool, input.user, tenant, async (tx, role) => {
    // A closing or closed workspace never starts a checkout, even from a replayed form (decision 037).
    if (await getClosure(tx)) return { next: `/w/${tenant}/closed` };
    if (role === "member") return { next: billingPath(tenant, "role") };
    const billing = await getBilling(tx);
    if (accessForAccount(billing) !== "blocked") return { next: `/w/${tenant}` };
    if (!input.acceptedTerms) return { next: billingPath(tenant, "terms") };
    await acceptBillingTerms(tx, TERMS_VERSION, deps.now());
    return { customerId: billing.customerId, trial: await trialAvailable(tx, input.user) };
  });
  if ("next" in state) return state.next;

  let customerId = state.customerId;
  if (!customerId) {
    // The same key for the same tenant, so a double click makes one customer, not two.
    customerId = (await deps.stripe.createCustomer({ tenant, email: input.email, idempotencyKey: `customer-${tenant}` })).id;
    await withTenant(deps.pool, tenant, (tx) => setStripeCustomer(tx, customerId!));
  }
  const session = await deps.stripe.createVerificationCheckout({
    tenant, customerId, trial: state.trial,
    successUrl: `${deps.appUrl}/w/${tenant}/billing/return?session_id={CHECKOUT_SESSION_ID}`,
    cancelUrl: `${deps.appUrl}${billingPath(tenant, "canceled")}`,
  });
  return session.url;
}

export type VerificationResult = "subscribed" | CardRejection | "pending" | "ignored";

// Finishes a Checkout: checks the card, releases the hold, starts the trial. Runs from the
// webhook and from the return URL; both may run at once or more than once, with the same result.
export async function completeVerification(
  deps: FlowDeps,
  sessionId: string,
  expectedTenant: TenantId | null,
): Promise<{ tenant: TenantId | null; result: VerificationResult }> {
  const s = await deps.stripe.getVerificationSession(sessionId);
  const tenant = parseTenant(s.tenant);
  if (!tenant || (expectedTenant && tenant !== expectedTenant) || !s.customerId) return { tenant, result: "ignored" };
  if (s.status !== "complete" || !s.hold) return { tenant, result: "pending" };

  const { billing, closed } = await withTenant(deps.pool, tenant, async (tx) => ({ billing: await getBilling(tx), closed: (await getClosure(tx)) !== null }));
  // The session must belong to the customer this tenant created. Metadata alone is not enough.
  if (billing.customerId !== s.customerId) return { tenant, result: "ignored" };
  // A checkout begun before the workspace closed (decision 037): release the hold, start nothing.
  if (closed) {
    if (s.hold.releasable) await deps.stripe.releaseHold(s.hold.paymentIntentId);
    return { tenant, result: "ignored" };
  }

  const verdict = checkCard(s.hold);
  if (s.hold.releasable) await deps.stripe.releaseHold(s.hold.paymentIntentId);
  if (!verdict.ok) {
    await withTenant(deps.pool, tenant, (tx) => recordCardRejected(tx, verdict.reason));
    return { tenant, result: verdict.reason };
  }
  if (!s.hold.paymentMethodId) {
    await withTenant(deps.pool, tenant, (tx) => recordCardRejected(tx, "not_authorized"));
    return { tenant, result: "not_authorized" };
  }

  // A seat subscription that is still live (decision 028; a workspace not yet converted): keep it.
  const existing = await deps.stripe.liveSubscription(s.customerId);
  const now = deps.now();
  if (existing) {
    await withTenant(deps.pool, tenant, (tx) => saveSubscription(tx, existing, existing.cardVerifiedAt ?? now));
    return { tenant, result: "subscribed" };
  }

  // Decision 041: one subscription per project. The card check itself creates no subscription; it
  // starts the workspace's one trial (decision 032), which every project added during it shares.
  // One trial per workspace, ever, and none for an owner who had one elsewhere (decision 037): the
  // session carries the owner check; the workspace check runs here again.
  const trial = s.trialAllowed && billing.cardVerifiedAt === null && billing.trialEnd === null;
  await deps.stripe.setInvoicePaymentMethod(s.customerId, s.hold.paymentMethodId, `default-pm-${s.id}`);
  await withTenant(deps.pool, tenant, (tx) => startProjectBilling(tx, now, trial ? new Date(now.getTime() + TRIAL_DAYS * DAY_MS) : null));
  // A new card after a failed one: projects whose subscription ended get a new one, billed now.
  try {
    await reconcileProjects(deps, tenant, { afterCardCheck: true });
  } catch {
    // The card is saved; the overview and the daily job reconcile again.
  }
  return { tenant, result: "subscribed" };
}

const DAY_MS = 86_400_000;

// Copies Stripe's current view of a subscription into the tenant's rows. Stripe is the source of
// truth, so event order does not matter. A project subscription (metadata.project_id, decision 041)
// goes to project_subscriptions and never touches the seat columns; a seat subscription of a
// converted workspace only runs out its period, so nothing is stored for it.
export async function refreshSubscription(deps: FlowDeps, subscriptionId: string): Promise<TenantId | null> {
  const sub = await deps.stripe.getSubscription(subscriptionId);
  const tenant = parseTenant(sub.tenant);
  if (!tenant) return null;
  const project = projectSubFromStripe(sub);
  const saved = await withTenant(deps.pool, tenant, async (tx) => {
    const billing = await getBilling(tx);
    if (billing.customerId !== sub.customerId) return false;
    if (project) {
      const [before] = await tx.query<{ cancel_at_period_end: boolean }>(
        "SELECT cancel_at_period_end FROM supahound.project_subscriptions WHERE tenant_id = $1 AND subscription_id = $2",
        [tx.tenantId, project.subscriptionId],
      );
      await saveProjectSubscription(tx, project, project.projectId);
      // Decision 042: a cancel set or cleared in the Billing Portal schedules or undoes the removal.
      if (before) await applyPortalCancel(tx, project, before.cancel_at_period_end, deps.now());
      await refreshStanding(tx);
      return true;
    }
    // A project subscription whose item is at no known price: fail closed, store nothing.
    if (sub.projectId) return false;
    if (billing.model === "project") return true;
    // A subscription row needs a verified card (migration CHECK). Our subscriptions carry the
    // verification time in their metadata; one without it was not created by this flow.
    if (!billing.cardVerifiedAt && !sub.cardVerifiedAt) return false;
    await saveSubscription(tx, sub, sub.cardVerifiedAt);
    return true;
  });
  return saved ? tenant : null;
}

export interface ReconcileOutcome {
  actions: number;
  failed: number;
}

// Decision 041: makes Stripe match the watched projects (billing/projects.ts planReconcile). Runs
// after a project is added or removed, after a disconnect or reconnect, after the daily usage count
// (tier changes), when the overview sees drift, and after a new card. Safe to run at any time and
// more than once: creates use idempotency keys, and a subscription Stripe already has for the
// project (a create whose row was never written) is adopted, not created again. Does nothing for a
// seat or exempt workspace, a closing one (closing cancels everything) or a blocked one (a new
// card must come first; afterCardCheck is that card).
export async function reconcileProjects(deps: FlowDeps, tenant: TenantId, opts: { afterCardCheck?: boolean } = {}): Promise<ReconcileOutcome> {
  const pre = await withTenant(deps.pool, tenant, async (tx) => {
    const billing = await getBilling(tx);
    if (billing.model !== "project" || billing.exempt || !billing.customerId || !billing.cardVerifiedAt) return null;
    if (await getClosure(tx)) return null;
    if (!opts.afterCardCheck && accessForAccount(billing) === "blocked") return null;
    const subs = await listProjectSubscriptions(tx);
    return {
      customerId: billing.customerId,
      plan: planReconcile({ now: deps.now(), workspaceTrialEnd: billing.trialEnd, watched: await watchedProjects(tx), subs }),
    };
  });
  if (!pre || pre.plan.length === 0) return { actions: 0, failed: 0 };

  const inStripe = pre.plan.some((a) => a.kind === "create") ? await deps.stripe.customerSubscriptions(pre.customerId) : [];
  let failed = 0;
  for (const a of pre.plan) {
    try {
      let sub: StripeSubscription;
      switch (a.kind) {
        case "relink":
          await withTenant(deps.pool, tenant, (tx) => relinkProjectSubscription(tx, a.subscriptionId, a.projectId));
          continue;
        case "create":
          sub = inStripe.find((s) => s.projectId === a.projectId && s.tenant === tenant && isLive(s.status))
            ?? await deps.stripe.createProjectSubscription({
              tenant, projectId: a.projectId, supabaseRef: a.supabaseRef, customerId: pre.customerId, tier: a.tier,
              trialEnd: a.trialEnd, anchor: null, idempotencyKey: createKey(tenant, a.projectId, a.attempt),
            });
          break;
        case "resume":
          sub = await deps.stripe.setCancelAtPeriodEnd(a.subscriptionId, false);
          break;
        case "cancel":
          sub = await deps.stripe.setCancelAtPeriodEnd(a.subscriptionId, true);
          break;
        case "tier":
          sub = await deps.stripe.setProjectTier(a.subscriptionId, a.tier);
          break;
      }
      const row = projectSubFromStripe(sub);
      if (row) await withTenant(deps.pool, tenant, (tx) => saveProjectSubscription(tx, row, row.projectId));
    } catch {
      failed++;
    }
  }
  await withTenant(deps.pool, tenant, (tx) => refreshStanding(tx));
  if (failed > 0) throw new Error(`reconcile: ${failed} of ${pre.plan.length} Stripe changes failed`);
  return { actions: pre.plan.length, failed };
}

// Bills a change in the watched projects or their tiers, in whichever model the workspace uses.
export async function syncBilling(deps: FlowDeps, tenant: TenantId, prorate: boolean): Promise<void> {
  const model = await withTenant(deps.pool, tenant, async (tx) => (await getBilling(tx)).model);
  if (model === "project") await reconcileProjects(deps, tenant);
  else await syncSeats(deps, tenant, prorate);
}

// Bills one seat per watched project at its tier. Called after the picker adds or removes a
// project (prorate: true), after the daily usage count (prorate: false), and when the overview
// sees the stored seats drift from the projects.
export async function syncSeats(deps: FlowDeps, tenant: TenantId, prorate: boolean): Promise<void> {
  const want = await withTenant(deps.pool, tenant, async (tx) => {
    const billing = await getBilling(tx);
    // A converted workspace's seat subscription only runs out its period: never charge it again.
    if (billing.model !== "workspace" || !billing.subscriptionId || accessFor(billing.status) === "blocked") return null;
    const seats = seatsFor(billedTiers(await projectTiers(tx)));
    const same = billing.seats && billing.seats.starter === seats.starter && billing.seats.pro === seats.pro;
    return same ? null : { subscriptionId: billing.subscriptionId, seats };
  });
  if (!want) return;
  await deps.stripe.setSeats(want.subscriptionId, want.seats, prorate);
  await withTenant(deps.pool, tenant, (tx) => saveSeats(tx, want.seats));
}

// After the daily usage count: set each project's tier from its last 30 days, then bill the new
// tiers from the next renewal. A project above the Enterprise line stays on Pro (decision 028).
export async function applyUsageTiers(deps: FlowDeps, tenant: TenantId, today: string): Promise<void> {
  await withTenant(deps.pool, tenant, (tx) => refreshProjectTiers(tx, today));
  await syncBilling(deps, tenant, false);
}

// A verified Stripe event, reduced to what the flow needs (apps/web/lib/stripe.ts builds it).
export interface BillingEvent {
  id: string;
  type: string;
  tenant: string | null;
  checkoutSessionId: string | null;
  subscriptionId: string | null;
}

export type WebhookResult = "processed" | "duplicate" | "ignored";

// The webhook, after the signature check. Idempotent per tenant: a replayed event ID is skipped,
// and every step is safe to run twice, so a crash before the event is recorded only means the
// retry repeats safe work.
export async function handleBillingEvent(deps: FlowDeps, e: BillingEvent): Promise<WebhookResult> {
  const tenant = parseTenant(e.tenant);
  if (!tenant) return "ignored";
  if (await withTenant(deps.pool, tenant, (tx) => isStripeEventProcessed(tx, e.id))) return "duplicate";

  let handled = false;
  if (e.type === "checkout.session.completed" && e.checkoutSessionId) {
    const { result } = await completeVerification(deps, e.checkoutSessionId, tenant);
    handled = result !== "ignored";
  } else if (e.subscriptionId && (e.type.startsWith("customer.subscription.") || e.type.startsWith("invoice."))) {
    handled = (await refreshSubscription(deps, e.subscriptionId)) === tenant;
  }
  if (!handled) return "ignored";
  await withTenant(deps.pool, tenant, (tx) => claimStripeEvent(tx, e.id, e.type));
  return "processed";
}
