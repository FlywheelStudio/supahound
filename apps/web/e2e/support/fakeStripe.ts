import { createHmac, randomBytes } from "node:crypto";
import { createServer, type IncomingMessage, type Server } from "node:http";

// A stand-in for the Stripe API and Checkout page (decision 028). The Worker reaches it through
// STRIPE_API_URL with the real Stripe SDK, so the SDK's form encoding, idempotency keys and error
// handling all run. The "Checkout page" at /pay/<session> offers one button per test card; each
// completes the session the way Stripe would, sends a signed webhook to the app, and returns the
// browser to success_url. Test-only control endpoints live under /__test/.

export type TestCard = "good" | "prepaid" | "cvc_fail" | "cvc_unavailable" | "declined";

export interface FakeStripe {
  url: string;
  webhookSecret: string;
  stop: () => Promise<void>;
}

type Obj = Record<string, unknown>;

// Stripe's form encoding (a[b][0][c]=v) → nested objects and arrays.
function parseForm(body: string): Obj {
  const out: Obj = {};
  for (const [rawKey, value] of new URLSearchParams(body)) {
    const keys = rawKey.replace(/\]/g, "").split("[");
    let node: Obj = out;
    keys.forEach((k, i) => {
      if (i === keys.length - 1) {
        node[k] = value;
        return;
      }
      const nextIsIndex = /^\d+$/.test(keys[i + 1]!);
      node[k] ??= nextIsIndex ? [] : {};
      node = node[k] as Obj;
    });
  }
  return out;
}

async function readBody(req: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(c as Buffer);
  return Buffer.concat(chunks).toString("utf8");
}

const id = (prefix: string) => `${prefix}_${randomBytes(12).toString("hex")}`;

const CARDS: Record<TestCard, { approved: boolean; cvc: string; funding: string; label: string }> = {
  good: { approved: true, cvc: "pass", funding: "credit", label: "Pay with a good card" },
  cvc_unavailable: { approved: true, cvc: "unavailable", funding: "debit", label: "Pay with a card whose bank skips CVC" },
  prepaid: { approved: true, cvc: "pass", funding: "prepaid", label: "Pay with a prepaid card" },
  cvc_fail: { approved: true, cvc: "fail", funding: "credit", label: "Pay with a wrong CVC" },
  declined: { approved: false, cvc: "unchecked", funding: "credit", label: "Give up after a decline" },
};

export async function startFakeStripe(port: number, appUrl: string): Promise<FakeStripe> {
  const webhookSecret = `whsec_${randomBytes(24).toString("hex")}`;
  const customers = new Map<string, Obj>();
  const sessions = new Map<string, Obj>();
  const intents = new Map<string, Obj>();
  const subscriptions = new Map<string, Obj>();
  const idempotent = new Map<string, unknown>();
  const calls: { method: string; path: string; body: Obj }[] = [];
  const events: { event: Obj; status: number; body: string }[] = [];

  function expandedSession(s: Obj): Obj {
    const pi = s.payment_intent ? intents.get(String(s.payment_intent)) ?? null : null;
    return { ...s, payment_intent: pi };
  }

  async function deliver(type: string, object: Obj, eventId = id("evt")): Promise<{ status: number; body: string }> {
    const event = { id: eventId, object: "event", type, created: Math.floor(Date.now() / 1000), data: { object } };
    const payload = JSON.stringify(event);
    const t = Math.floor(Date.now() / 1000);
    const sig = createHmac("sha256", webhookSecret).update(`${t}.${payload}`).digest("hex");
    const res = await fetch(new URL("/api/stripe/webhook", appUrl), {
      method: "POST",
      headers: { "content-type": "application/json", "stripe-signature": `t=${t},v1=${sig}` },
      body: payload,
    });
    const result = { status: res.status, body: await res.text() };
    events.push({ event, ...result });
    return result;
  }

  function pay(s: Obj, card: TestCard) {
    const c = CARDS[card];
    const piId = id("pi");
    const pm = id("pm");
    intents.set(piId, {
      id: piId, object: "payment_intent", status: c.approved ? "requires_capture" : "requires_payment_method",
      payment_method: c.approved ? pm : null, capture_method: "manual",
      latest_charge: {
        id: id("ch"), object: "charge", status: c.approved ? "succeeded" : "failed", captured: false, payment_method: pm,
        outcome: { network_status: c.approved ? "approved_by_network" : "declined_by_network", type: c.approved ? "authorized" : "issuer_declined" },
        payment_method_details: { type: "card", card: { brand: "visa", funding: c.funding, last4: "4242", checks: { cvc_check: c.cvc } } },
      },
    });
    s.payment_intent = piId;
    s.status = "complete";
    s.payment_status = c.approved ? "unpaid" : "unpaid";
  }

  const server: Server = createServer((req, res) => {
    void (async () => {
      const url = new URL(req.url ?? "/", "http://x");
      const path = url.pathname;
      const raw = req.method === "GET" ? "" : await readBody(req);
      const send = (status: number, data: unknown) => {
        res.writeHead(status, { "content-type": "application/json" });
        res.end(JSON.stringify(data));
      };
      const html = (status: number, body: string) => {
        res.writeHead(status, { "content-type": "text/html; charset=utf-8" });
        res.end(`<!doctype html><html><body>${body}</body></html>`);
      };
      const redirect = (to: string) => {
        res.writeHead(303, { location: to });
        res.end();
      };
      const error = (status: number, code: string, message: string) => send(status, { error: { type: "invalid_request_error", code, message } });

      // --- Test controls ---------------------------------------------------------------------
      if (path === "/__test/calls") return send(200, calls);
      if (path === "/__test/events") return send(200, events);
      if (path === "/__test/state") {
        return send(200, { customers: [...customers.values()], sessions: [...sessions.values()].map(expandedSession), subscriptions: [...subscriptions.values()] });
      }
      if (req.method === "POST" && path === "/__test/replay") {
        const last = events.at(-1);
        if (!last) return send(404, { error: "no events" });
        return send(200, await deliver(String(last.event.type), (last.event.data as Obj).object as Obj, String(last.event.id)));
      }
      if (req.method === "POST" && path === "/__test/cancel") {
        const b = JSON.parse(raw || "{}") as { subscription: string };
        const sub = subscriptions.get(b.subscription);
        if (!sub) return send(404, { error: "no such subscription" });
        sub.status = "canceled";
        return send(200, await deliver("customer.subscription.deleted", sub));
      }
      if (req.method === "POST" && path === "/__test/unsigned") {
        const r = await fetch(new URL("/api/stripe/webhook", appUrl), {
          method: "POST", headers: { "content-type": "application/json", "stripe-signature": "t=1,v1=deadbeef" }, body: raw,
        });
        return send(200, { status: r.status });
      }

      // --- The "Checkout page" -----------------------------------------------------------------
      const payPage = /^\/pay\/(cs_[a-z0-9]+)$/.exec(path);
      if (req.method === "GET" && payPage) {
        const s = sessions.get(payPage[1]!);
        if (!s) return html(404, "No such session");
        const card = url.searchParams.get("card") as TestCard | null;
        if (!card) {
          const message = String(((s.custom_text as Obj | undefined)?.submit as Obj | undefined)?.message ?? "");
          const links = (Object.keys(CARDS) as TestCard[])
            .map((k) => `<p><a href="/pay/${s.id}?card=${k}">${CARDS[k].label}</a></p>`).join("");
          return html(200, `<h1>Fake Stripe Checkout</h1><p id="amount">$1.00</p><p id="terms">${message}</p>${links}
            <p><a href="/pay/${s.id}?card=good&webhook=only">Pay with a good card and close the tab</a></p>`);
        }
        if (card === "declined") return redirect(String(s.cancel_url));
        pay(s, card);
        await deliver("checkout.session.completed", { ...s });
        if (url.searchParams.get("webhook") === "only") return html(200, "<p>Paid. You can close this tab.</p>");
        return redirect(String(s.success_url).replace("{CHECKOUT_SESSION_ID}", String(s.id)));
      }
      if (path === "/portal") return html(200, "<h1>Fake Billing Portal</h1>");

      // --- The Stripe API ------------------------------------------------------------------------
      if (!path.startsWith("/v1/")) return send(404, { error: { message: `fake stripe: no route for ${path}` } });
      if (req.headers.authorization !== "Bearer sk_test_e2e") return error(401, "api_key_invalid", "Invalid API key");
      const body = parseForm(raw || url.search.slice(1));
      calls.push({ method: req.method ?? "", path, body });
      const key = req.headers["idempotency-key"];
      const remembered = typeof key === "string" && key.length > 0 && !key.startsWith("stripe-node-retry-") ? `${path}:${key}` : null;
      if (req.method === "POST" && remembered && idempotent.has(remembered)) return send(200, idempotent.get(remembered));
      const ok = (data: unknown) => {
        if (req.method === "POST" && remembered) idempotent.set(remembered, data);
        return send(200, data);
      };

      if (req.method === "POST" && path === "/v1/customers") {
        const c = { id: id("cus"), object: "customer", email: body.email ?? null, metadata: body.metadata ?? {} };
        customers.set(c.id, c);
        return ok(c);
      }
      if (req.method === "POST" && path === "/v1/checkout/sessions") {
        const pid = body.payment_intent_data as Obj | undefined;
        const line = ((body.line_items as Obj[] | undefined)?.[0]?.price_data as Obj | undefined);
        // The contract the app must keep (decision 028): a $1 manual-capture hold that saves the card.
        if (body.mode !== "payment" || pid?.capture_method !== "manual" || pid?.setup_future_usage !== "off_session" || line?.unit_amount !== "100") {
          return error(400, "parameter_invalid", "fake stripe: not a $1 manual-capture card check");
        }
        if (!customers.has(String(body.customer))) return error(400, "resource_missing", "No such customer");
        const s: Obj = {
          id: id("cs"), object: "checkout.session", mode: "payment", status: "open", customer: body.customer,
          client_reference_id: body.client_reference_id, metadata: body.metadata ?? {}, custom_text: body.custom_text,
          success_url: body.success_url, cancel_url: body.cancel_url, payment_intent: null,
        };
        s.url = `http://127.0.0.1:${port}/pay/${s.id}`;
        sessions.set(String(s.id), s);
        return ok(s);
      }
      const sessionGet = /^\/v1\/checkout\/sessions\/(cs_[a-z0-9]+)$/.exec(path);
      if (req.method === "GET" && sessionGet) {
        const s = sessions.get(sessionGet[1]!);
        return s ? ok(expandedSession(s)) : error(404, "resource_missing", "No such session");
      }
      const cancel = /^\/v1\/payment_intents\/(pi_[a-z0-9]+)\/cancel$/.exec(path);
      if (req.method === "POST" && cancel) {
        const pi = intents.get(cancel[1]!);
        if (!pi) return error(404, "resource_missing", "No such payment_intent");
        if (pi.status !== "requires_capture") return error(400, "payment_intent_unexpected_state", "Cannot cancel");
        pi.status = "canceled";
        return ok(pi);
      }
      if (req.method === "GET" && path === "/v1/subscriptions") {
        const data = [...subscriptions.values()].filter((s) => s.customer === body.customer);
        return ok({ object: "list", data, has_more: false, url: "/v1/subscriptions" });
      }
      if (req.method === "POST" && path === "/v1/subscriptions") {
        // No trial_period_days (decision 037: one trial ever): active at once, a 30-day period.
        const trial = body.trial_period_days !== undefined;
        const now = Math.floor(Date.now() / 1000);
        const trialEnd = trial ? now + Number(body.trial_period_days) * 86_400 : null;
        const periodEnd = trialEnd ?? now + 30 * 86_400;
        const sub: Obj = {
          id: id("sub"), object: "subscription", customer: body.customer, status: trial ? "trialing" : "active", trial_end: trialEnd,
          cancel_at_period_end: false, metadata: body.metadata ?? {}, default_payment_method: body.default_payment_method,
          trial_period_days: trial ? Number(body.trial_period_days) : null,
          items: { object: "list", data: (body.items as Obj[]).map((item) => ({
            id: id("si"), quantity: Number(item.quantity), current_period_end: periodEnd, price: { id: item.price },
          })) },
        };
        subscriptions.set(String(sub.id), sub);
        return ok(sub);
      }
      const subUpdate = /^\/v1\/subscriptions\/(sub_[a-z0-9]+)$/.exec(path);
      if (req.method === "POST" && subUpdate) {
        const sub = subscriptions.get(subUpdate[1]!);
        if (!sub) return error(404, "resource_missing", "No such subscription");
        const data = (sub.items as Obj).data as Obj[];
        for (const change of (body.items as Obj[] | undefined) ?? []) {
          const existing = data.find((i) => i.id === change.id);
          if (existing) existing.quantity = Number(change.quantity);
          else data.push({ id: id("si"), quantity: Number(change.quantity), price: { id: change.price } });
        }
        sub.last_proration_behavior = body.proration_behavior;
        // Closing and reopening a workspace (decision 037). Like Stripe, it also sends the event.
        if (body.cancel_at_period_end !== undefined) {
          sub.cancel_at_period_end = body.cancel_at_period_end === "true";
          ok(sub);
          void deliver("customer.subscription.updated", { ...sub });
          return;
        }
        return ok(sub);
      }
      const subGet = /^\/v1\/subscriptions\/(sub_[a-z0-9]+)$/.exec(path);
      if (req.method === "GET" && subGet) {
        const s = subscriptions.get(subGet[1]!);
        return s ? ok(s) : error(404, "resource_missing", "No such subscription");
      }
      if (req.method === "POST" && path === "/v1/billing_portal/sessions") {
        return ok({ id: id("bps"), object: "billing_portal.session", url: `http://127.0.0.1:${port}/portal` });
      }
      error(404, "resource_missing", `fake stripe: no route for ${req.method} ${path}`);
    })().catch((err: unknown) => {
      res.writeHead(500).end(String(err));
    });
  });

  await new Promise<void>((resolve) => server.listen(port, "127.0.0.1", resolve));
  return {
    url: `http://127.0.0.1:${port}`,
    webhookSecret,
    stop: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}
