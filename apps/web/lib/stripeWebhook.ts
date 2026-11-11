import type { BillingEvent } from "@supahound/core/billing/flow";
import Stripe from "stripe";
import { billingEventFromStripe } from "@supahound/core/billing/stripeMap";

// The webhook signature check, without Workers bindings so it is unit-tested with Stripe's own
// signing helper. Throws on a missing, wrong, tampered or stale (over 5 minutes) signature.
export async function verifyStripeEvent(stripe: Stripe, body: string, signature: string, secret: string): Promise<BillingEvent> {
  const event = await stripe.webhooks.constructEventAsync(body, signature, secret, 300, Stripe.createSubtleCryptoProvider());
  return billingEventFromStripe(event as unknown as Record<string, unknown>);
}
