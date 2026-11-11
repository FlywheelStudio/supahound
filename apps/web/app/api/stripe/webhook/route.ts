import { handleBillingEvent } from "@supahound/core/billing/flow";
import { flowDeps, mode } from "../../../../lib/billing";
import { withPool } from "../../../../lib/db";
import { verifiedBillingEvent } from "../../../../lib/stripe";

// Stripe webhooks (decision 013, 028). The signature is checked before anything is parsed; the
// handler is idempotent per tenant. A 500 makes Stripe retry, which is safe.
export async function POST(request: Request): Promise<Response> {
  if (mode() === "off") return new Response(null, { status: 404 });
  const signature = request.headers.get("stripe-signature");
  if (!signature) return Response.json({ error: "missing signature" }, { status: 400 });
  const body = await request.text();
  let event;
  try {
    event = await verifiedBillingEvent(body, signature);
  } catch {
    return Response.json({ error: "invalid signature" }, { status: 400 });
  }
  try {
    const result = await withPool((pool) => handleBillingEvent(flowDeps(pool), event));
    return Response.json({ result });
  } catch {
    // Logged by event ID and type only: never the payload, which carries customer data.
    console.log(JSON.stringify({ event: "stripe_webhook_failed", stripe_event: event.id, type: event.type }));
    return Response.json({ error: "processing failed" }, { status: 500 });
  }
}
