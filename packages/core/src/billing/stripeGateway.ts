import Stripe from "stripe";
import type { StripeGateway } from "./flow.js";
import { VERIFICATION_CURRENCY, VERIFICATION_HOLD_CENTS } from "./policy.js";
import { invoiceFromStripe, PURPOSE, seatsFromItems, sessionFromStripe, subscriptionFromStripe, termsText, type PriceIds } from "./stripeMap.js";

// The real StripeGateway (decision 013, 028), shared by the web app and the poller. Runs on
// Workers and Node: the fetch HTTP client, one client per request. apiUrl points at a fake in E2E.

export interface StripeConfig {
  secretKey: string;
  apiUrl: string;
  prices: PriceIds;
  // A Billing Portal configuration ID; empty uses the account's default configuration.
  portalConfiguration?: string;
}

export function stripeClient(config: Pick<StripeConfig, "secretKey" | "apiUrl">): Stripe {
  const base = new URL(config.apiUrl);
  return new Stripe(config.secretKey, {
    httpClient: Stripe.createFetchHttpClient(),
    host: base.hostname,
    port: base.port || (base.protocol === "http:" ? 80 : 443),
    protocol: base.protocol === "http:" ? "http" : "https",
    maxNetworkRetries: 2,
    timeout: 15_000,
    appInfo: { name: "Supahound" },
  });
}

type Obj = Record<string, unknown>;
const asObj = (v: unknown) => v as unknown as Obj;

export function stripeGateway(config: StripeConfig, stripe: Stripe = stripeClient(config)): StripeGateway {
  const { prices } = config;
  return {
    async createCustomer({ tenant, email, idempotencyKey }) {
      const c = await stripe.customers.create({ ...(email ? { email } : {}), metadata: { tenant_id: tenant } }, { idempotencyKey });
      return { id: c.id };
    },

    async createVerificationCheckout({ tenant, customerId, successUrl, cancelUrl, trial }) {
      const s = await stripe.checkout.sessions.create({
        mode: "payment",
        customer: customerId,
        client_reference_id: tenant,
        // Cards only: the check reads the card's CVC result and funding type.
        allowed_payment_method_types: ["card"],
        line_items: [{
          quantity: 1,
          price_data: {
            currency: VERIFICATION_CURRENCY,
            unit_amount: VERIFICATION_HOLD_CENTS,
            product_data: { name: "Card check (hold released at once)" },
          },
        }],
        payment_intent_data: {
          capture_method: "manual",
          setup_future_usage: "off_session",
          description: "Supahound card check. This hold is released at once and never charged.",
          metadata: { tenant_id: tenant, purpose: PURPOSE },
        },
        metadata: { tenant_id: tenant, purpose: PURPOSE, trial: trial ? "yes" : "no" },
        custom_text: { submit: { message: termsText(trial) } },
        success_url: successUrl,
        cancel_url: cancelUrl,
      });
      if (!s.url) throw new Error("Stripe returned a Checkout Session without a URL");
      return { id: s.id, url: s.url };
    },

    async getVerificationSession(id) {
      const s = await stripe.checkout.sessions.retrieve(id, { expand: ["payment_intent.latest_charge"] });
      return sessionFromStripe(asObj(s));
    },

    async releaseHold(paymentIntentId) {
      try {
        await stripe.paymentIntents.cancel(paymentIntentId, {}, { idempotencyKey: `release-${paymentIntentId}` });
      } catch (err) {
        // Already released (a retry, or the hold expired): the goal is met.
        if ((err as { code?: string }).code !== "payment_intent_unexpected_state") throw err;
      }
    },

    async liveSubscription(customerId) {
      const list = await stripe.subscriptions.list({ customer: customerId, status: "all", limit: 100 });
      // The seat subscription only: project subscriptions carry metadata.project_id (decision 041).
      const live = list.data.find((s) => !["canceled", "incomplete_expired"].includes(s.status) && !s.metadata?.project_id);
      return live ? subscriptionFromStripe(asObj(live), prices) : null;
    },

    async getSubscription(id) {
      return subscriptionFromStripe(asObj(await stripe.subscriptions.retrieve(id)), prices);
    },

    async setSeats(subscriptionId, seats, prorate) {
      const sub = await stripe.subscriptions.retrieve(subscriptionId);
      const { itemIds } = seatsFromItems(asObj(sub).items, prices);
      const items = (["starter", "pro"] as const).map((tier) =>
        itemIds[tier] ? { id: itemIds[tier], quantity: seats[tier] } : { price: prices[tier], quantity: seats[tier] },
      );
      await stripe.subscriptions.update(subscriptionId, {
        items,
        proration_behavior: prorate ? "create_prorations" : "none",
      });
    },

    async setCancelAtPeriodEnd(id, cancel, options) {
      const s = await stripe.subscriptions.update(
        id,
        { cancel_at_period_end: cancel, ...(options?.converted ? { metadata: { converted: "yes" } } : {}) },
        options?.idempotencyKey ? { idempotencyKey: options.idempotencyKey } : undefined,
      );
      return subscriptionFromStripe(asObj(s), prices);
    },

    // --- One subscription per project (decision 041) ---

    async setInvoicePaymentMethod(customerId, paymentMethodId, idempotencyKey) {
      await stripe.customers.update(customerId, { invoice_settings: { default_payment_method: paymentMethodId } }, { idempotencyKey });
    },

    async createProjectSubscription({ tenant, projectId, supabaseRef, customerId, tier, trialEnd, anchor, idempotencyKey }) {
      const s = await stripe.subscriptions.create({
        customer: customerId,
        items: [{ price: prices[tier], quantity: 1 }],
        // The workspace trial (shared by every project added during it), or a seat subscription's
        // trial end during conversion. A missing card at the trial end cancels, as in decision 028.
        ...(trialEnd
          ? { trial_end: Math.floor(trialEnd.getTime() / 1000), trial_settings: { end_behavior: { missing_payment_method: "cancel" as const } } }
          : {}),
        // Conversion of a paid seat subscription: no charge until its period end, then monthly.
        ...(anchor ? { billing_cycle_anchor: Math.floor(anchor.getTime() / 1000), proration_behavior: "none" as const } : {}),
        metadata: { tenant_id: tenant, project_id: projectId, supabase_ref: supabaseRef },
      }, { idempotencyKey });
      return subscriptionFromStripe(asObj(s), prices);
    },

    async customerSubscriptions(customerId) {
      const out = [];
      for await (const s of stripe.subscriptions.list({ customer: customerId, status: "all", limit: 100 })) {
        out.push(subscriptionFromStripe(asObj(s), prices));
      }
      return out;
    },

    async setProjectTier(subscriptionId, tier) {
      const sub = await stripe.subscriptions.retrieve(subscriptionId);
      const item = sub.items.data[0];
      if (!item) throw new Error("project subscription without an item");
      // Takes effect at the next renewal, in both directions (decision 028).
      const s = await stripe.subscriptions.update(subscriptionId, {
        items: [{ id: item.id, price: prices[tier], quantity: 1 }],
        proration_behavior: "none",
      });
      return subscriptionFromStripe(asObj(s), prices);
    },

    async invoices(subscriptionId, limit) {
      const list = await stripe.invoices.list({ subscription: subscriptionId, limit });
      return list.data.map((i) => invoiceFromStripe(asObj(i)));
    },

    async portalUrl(customerId, returnUrl) {
      return (await stripe.billingPortal.sessions.create({
        customer: customerId,
        return_url: returnUrl,
        ...(config.portalConfiguration ? { configuration: config.portalConfiguration } : {}),
      })).url;
    },
  };
}
