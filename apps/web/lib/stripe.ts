import { stripeClient, stripeGateway as coreGateway, type StripeConfig } from "@supahound/core/billing/stripeGateway";
import { env } from "cloudflare:workers";
import { verifyStripeEvent } from "./stripeWebhook";

// The web app's Stripe settings (decision 013, 028). The gateway itself is shared with the poller
// (packages/core/src/billing/stripeGateway.ts). STRIPE_API_URL points at a fake in E2E.

// Optional secrets: a self-hosted copy with billing off sets neither.
const secrets = env as typeof env & { STRIPE_SECRET_KEY?: string; STRIPE_WEBHOOK_SECRET?: string };

function secret(name: "STRIPE_SECRET_KEY" | "STRIPE_WEBHOOK_SECRET"): string {
  const v = secrets[name];
  if (!v) throw new Error(`${name} is not set`);
  return v;
}

export function stripeConfig(): StripeConfig {
  return {
    secretKey: secret("STRIPE_SECRET_KEY"),
    apiUrl: env.STRIPE_API_URL,
    prices: { starter: env.STRIPE_PRICE_STARTER, pro: env.STRIPE_PRICE_PRO },
    portalConfiguration: env.STRIPE_PORTAL_CONFIGURATION || undefined,
  };
}

export function stripeGateway() {
  return coreGateway(stripeConfig());
}

// The webhook signature check. Throws on a bad or missing signature (lib/stripeWebhook.ts).
export function verifiedBillingEvent(body: string, signature: string) {
  return verifyStripeEvent(stripeClient(stripeConfig()), body, signature, secret("STRIPE_WEBHOOK_SECRET"));
}
