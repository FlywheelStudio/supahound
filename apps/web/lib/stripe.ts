import type { StripeGateway } from "@supahound/core/billing/flow";
import { TRIAL_DAYS, VERIFICATION_CURRENCY, VERIFICATION_HOLD_CENTS, type Plan } from "@supahound/core/billing/policy";
import { env } from "cloudflare:workers";
import Stripe from "stripe";
import { PURPOSE, sessionFromStripe, subscriptionFromStripe, termsText } from "./stripeMap";
import { verifyStripeEvent } from "./stripeWebhook";

// Stripe on Workers (decision 013): the fetch HTTP client and SubtleCrypto for webhook signatures.
// One client per request, like the database pool. STRIPE_API_URL points the client at a fake in E2E.

// Optional secrets: a self-hosted copy with billing off sets neither.
const secrets = env as typeof env & { STRIPE_SECRET_KEY?: string; STRIPE_WEBHOOK_SECRET?: string };

function secret(name: "STRIPE_SECRET_KEY" | "STRIPE_WEBHOOK_SECRET"): string {
  const v = secrets[name];
  if (!v) throw new Error(`${name} is not set`);
  return v;
}

export function stripeClient(): Stripe {
  const base = new URL(env.STRIPE_API_URL);
  return new Stripe(secret("STRIPE_SECRET_KEY"), {
    httpClient: Stripe.createFetchHttpClient(),
    host: base.hostname,
    port: base.port || (base.protocol === "http:" ? 80 : 443),
    protocol: base.protocol === "http:" ? "http" : "https",
    maxNetworkRetries: 2,
    timeout: 15_000,
    appInfo: { name: "Supahound" },
  });
}

function priceFor(plan: Plan): string {
  return plan === "agency" ? env.STRIPE_PRICE_AGENCY : env.STRIPE_PRICE_BUILDER;
}

function planForPrice(priceId: string): Plan | null {
  if (priceId === env.STRIPE_PRICE_BUILDER) return "builder";
  if (priceId === env.STRIPE_PRICE_AGENCY) return "agency";
  return null;
}

type Obj = Record<string, unknown>;
const asObj = (v: unknown) => v as unknown as Obj;

export function stripeGateway(stripe: Stripe = stripeClient()): StripeGateway {
  return {
    async createCustomer({ tenant, email, idempotencyKey }) {
      const c = await stripe.customers.create({ email: email ?? undefined, metadata: { tenant_id: tenant } }, { idempotencyKey });
      return { id: c.id };
    },

    async createVerificationCheckout({ tenant, customerId, plan, successUrl, cancelUrl }) {
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
        metadata: { tenant_id: tenant, plan, purpose: PURPOSE },
        custom_text: { submit: { message: termsText(plan) } },
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
      const list = await stripe.subscriptions.list({ customer: customerId, status: "all", limit: 20 });
      const live = list.data.find((s) => !["canceled", "incomplete_expired"].includes(s.status));
      return live ? subscriptionFromStripe(asObj(live), planForPrice) : null;
    },

    async createTrialSubscription({ tenant, customerId, plan, seats, paymentMethodId, cardVerifiedAt, idempotencyKey }) {
      const s = await stripe.subscriptions.create({
        customer: customerId,
        items: [{ price: priceFor(plan), quantity: seats }],
        trial_period_days: TRIAL_DAYS,
        default_payment_method: paymentMethodId,
        trial_settings: { end_behavior: { missing_payment_method: "cancel" } },
        payment_settings: { save_default_payment_method: "on_subscription" },
        metadata: { tenant_id: tenant, plan, card_verified_at: cardVerifiedAt.toISOString() },
      }, { idempotencyKey });
      return subscriptionFromStripe(asObj(s), planForPrice);
    },

    async getSubscription(id) {
      return subscriptionFromStripe(asObj(await stripe.subscriptions.retrieve(id)), planForPrice);
    },

    async setSeats(subscriptionId, seats) {
      const sub = await stripe.subscriptions.retrieve(subscriptionId);
      const item = sub.items.data[0];
      if (!item) throw new Error("Subscription has no items");
      await stripe.subscriptionItems.update(item.id, { quantity: seats, proration_behavior: "create_prorations" });
    },

    async portalUrl(customerId, returnUrl) {
      return (await stripe.billingPortal.sessions.create({ customer: customerId, return_url: returnUrl })).url;
    },
  };
}

// The webhook signature check. Throws on a bad or missing signature (lib/stripeWebhook.ts).
export function verifiedBillingEvent(body: string, signature: string, stripe: Stripe = stripeClient()) {
  return verifyStripeEvent(stripe, body, signature, secret("STRIPE_WEBHOOK_SECRET"));
}
