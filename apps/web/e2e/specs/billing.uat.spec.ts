import { newState } from "@supahound/core/supabase/oauth";
import { tenantId } from "@supahound/core/tenancy/scope";
import { expect, test, type Page } from "@playwright/test";
import { adminQuery } from "../support/seed";
import { signIn, uniqueEmail } from "../support/session";

// UAT for billing with a validated card (decision 028, docs/TESTING.md UAT-B*). The real Worker
// and Postgres; Stripe is the fake in support/fakeStripe.ts, reached through the real Stripe SDK.

const STRIPE = () => process.env.E2E_STRIPE_URL!;
const BILLING_URL = /\/w\/([0-9a-f-]{36})\/billing(\?.*)?$/;

async function newWorkspace(page: Page, tag: string): Promise<string> {
  await signIn(page, uniqueEmail(tag));
  await page.getByLabel("Workspace name").fill(`Billing ${tag}`);
  await page.getByRole("button", { name: "Create workspace" }).click();
  await expect(page).toHaveURL(BILLING_URL);
  return BILLING_URL.exec(new URL(page.url()).pathname)![1]!;
}

async function toCheckout(page: Page): Promise<void> {
  await page.getByRole("checkbox").check();
  await page.getByRole("button", { name: "Add card and start trial" }).click();
  await expect(page.getByRole("heading", { name: "Fake Stripe Checkout" })).toBeVisible();
}

async function billingRow(tenant: string) {
  const [row] = await adminQuery<{ status: string; starter_seats: number | null; pro_seats: number | null; verification_error: string | null; card_verified_at: Date | null; terms_accepted_at: Date | null }>(
    "SELECT status, starter_seats, pro_seats, verification_error, card_verified_at, terms_accepted_at FROM supahound.billing_accounts WHERE tenant_id = $1",
    [tenant],
  );
  return row;
}

async function stripeState() {
  return (await (await fetch(`${STRIPE()}/__test/state`)).json()) as {
    sessions: { metadata: { tenant_id?: string }; payment_intent: { status: string } | null }[];
    subscriptions: { id: string; metadata: { tenant_id?: string }; trial_period_days: number; last_proration_behavior?: string; items: { data: { quantity: number; price: { id: string } }[] } }[];
  };
}

test.describe("UAT: a validated card before any use", () => {
  test("UAT-B1 a new workspace can open nothing but billing", async ({ page }) => {
    const tenant = await newWorkspace(page, "b1");
    await expect(page.getByRole("heading", { name: "Add a card to start your 7-day free trial" })).toBeVisible();
    for (const path of [`/w/${tenant}`, `/w/${tenant}/projects`]) {
      await page.goto(path);
      await expect(page, path).toHaveURL(new RegExp(`/w/${tenant}/billing$`));
    }
    // The Supabase OAuth callback is gated too: a valid state for this workspace connects nothing.
    await page.goto(`/api/supabase/callback?state=${encodeURIComponent(newState(tenantId(tenant)))}&code=x`);
    await expect(page).toHaveURL(new RegExp(`/w/${tenant}/billing$`));
    expect(await adminQuery("SELECT 1 FROM supahound.connections WHERE tenant_id = $1", [tenant])).toHaveLength(0);
  });

  test("UAT-B2 the terms must be accepted on our page, and Checkout repeats them", async ({ page }) => {
    const tenant = await newWorkspace(page, "b2");
    // Skip the browser's own check to prove the server enforces it.
    await page.getByRole("checkbox").evaluate((el) => el.removeAttribute("required"));
    await page.getByRole("button", { name: "Add card and start trial" }).click();
    await expect(page).toHaveURL(new RegExp(`/w/${tenant}/billing\\?error=terms$`));
    await expect(page.getByRole("alert")).toContainText("accept the terms");
    await expect(page.locator("#billing-terms")).toContainText("we contact you about Enterprise");
    await expect(page.locator("#billing-terms")).toContainText("$1 hold");

    await toCheckout(page);
    await expect(page.locator("#amount")).toHaveText("$1.00");
    await expect(page.locator("#terms")).toContainText("$1 hold");
    await expect(page.locator("#terms")).toContainText("$19.99 per month");
    await expect(page.locator("#terms")).toContainText("$99 per month if it sent more than 1 million requests");
    expect((await billingRow(tenant))!.terms_accepted_at).not.toBeNull();
  });

  test("UAT-B3 a good card starts a 7-day trial, releases the hold and opens the workspace", async ({ page }) => {
    const tenant = await newWorkspace(page, "b3");
    await toCheckout(page);
    await page.getByRole("link", { name: "Pay with a good card", exact: true }).click();
    await expect(page).toHaveURL(new RegExp(`/w/${tenant}\\?welcome=1$`));
    await expect(page.getByText("Card confirmed and the hold released")).toBeVisible();
    await expect(page.getByText(/Your free trial ends on \d{4}-\d{2}-\d{2}/)).toBeVisible();
    await expect(page.getByRole("button", { name: "Connect Supabase" })).toBeVisible();

    const row = await billingRow(tenant);
    expect([row!.status, row!.starter_seats, row!.pro_seats, row!.verification_error, row!.card_verified_at !== null]).toEqual(["trialing", 1, 0, null, true]);
    const state = await stripeState();
    const session = state.sessions.find((s) => s.metadata.tenant_id === tenant)!;
    expect(session.payment_intent!.status).toBe("canceled"); // the $1 hold is released, never captured
    const subs = state.subscriptions.filter((s) => s.metadata.tenant_id === tenant);
    expect(subs).toHaveLength(1);
    expect(subs[0]!.trial_period_days).toBe(7);
    expect(subs[0]!.items.data.map((i) => [i.price.id, i.quantity])).toEqual([["price_starter_e2e", 1], ["price_pro_e2e", 0]]);
  });

  test("UAT-B4 a card whose bank skips the CVC check passes", async ({ page }) => {
    const tenant = await newWorkspace(page, "b4");
    await toCheckout(page);
    await page.getByRole("link", { name: "Pay with a card whose bank skips CVC" }).click();
    await expect(page).toHaveURL(new RegExp(`/w/${tenant}\\?welcome=1$`));
    expect((await billingRow(tenant))!.status).toBe("trialing");
  });

  for (const [id, card, link, text] of [
    ["UAT-B5", "prepaid", "Pay with a prepaid card", "Prepaid cards are not accepted"],
    ["UAT-B6", "cvc_failed", "Pay with a wrong CVC", "The security code did not match"],
    ["UAT-B7", "canceled", "Give up after a decline", "No card was added"],
  ] as const) {
    test(`${id} ${card}: no trial, the hold is released, and the workspace stays closed`, async ({ page }) => {
      const tenant = await newWorkspace(page, id.toLowerCase());
      await toCheckout(page);
      await page.getByRole("link", { name: link }).click();
      await expect(page).toHaveURL(new RegExp(`/w/${tenant}/billing\\?error=${card}$`));
      await expect(page.getByRole("alert")).toContainText(text);
      const row = await billingRow(tenant);
      expect(row!.status).toBe("none");
      const state = await stripeState();
      expect(state.subscriptions.filter((s) => s.metadata.tenant_id === tenant)).toHaveLength(0);
      for (const s of state.sessions.filter((x) => x.metadata.tenant_id === tenant && x.payment_intent)) {
        expect(s.payment_intent!.status).not.toBe("requires_capture"); // no hold is left on the card
      }
      await page.goto(`/w/${tenant}`);
      await expect(page).toHaveURL(new RegExp(`/w/${tenant}/billing$`));
    });
  }

  test("UAT-B8 the webhook alone starts the trial, and a replay changes nothing", async ({ page }) => {
    const tenant = await newWorkspace(page, "b8");
    await toCheckout(page);
    await page.getByRole("link", { name: "Pay with a good card and close the tab" }).click();
    await expect(page.getByText("You can close this tab")).toBeVisible();
    expect((await billingRow(tenant))!.status).toBe("trialing");

    const replay = (await (await fetch(`${STRIPE()}/__test/replay`, { method: "POST" })).json()) as { status: number; body: string };
    expect(replay.status).toBe(200);
    expect(JSON.parse(replay.body)).toEqual({ result: "duplicate" });
    const subs = (await stripeState()).subscriptions.filter((s) => s.metadata.tenant_id === tenant);
    expect(subs).toHaveLength(1);

    await page.goto(`/w/${tenant}`);
    await expect(page).toHaveURL(new RegExp(`/w/${tenant}$`));
  });

  test("UAT-B9 a webhook without Stripe's signature is refused", async () => {
    const r = (await (await fetch(`${STRIPE()}/__test/unsigned`, { method: "POST", body: JSON.stringify({ id: "evt_forged1", type: "customer.subscription.updated" }) })).json()) as { status: number };
    expect(r.status).toBe(400);
  });

  test("UAT-B10 a canceled subscription closes the workspace again, and the next card gets no second trial", async ({ page }) => {
    const tenant = await newWorkspace(page, "b10");
    await toCheckout(page);
    await page.getByRole("link", { name: "Pay with a good card", exact: true }).click();
    await expect(page).toHaveURL(new RegExp(`/w/${tenant}\\?welcome=1$`));
    const sub = (await stripeState()).subscriptions.find((s) => s.metadata.tenant_id === tenant)!;
    const res = (await (await fetch(`${STRIPE()}/__test/cancel`, { method: "POST", body: JSON.stringify({ subscription: sub.id }) })).json()) as { status: number };
    expect(res.status).toBe(200);
    await page.goto(`/w/${tenant}`);
    await expect(page).toHaveURL(new RegExp(`/w/${tenant}/billing$`));
    // Decision 037: one free trial per workspace, ever.
    await expect(page.getByRole("heading", { name: "Add a card to start your subscription" })).toBeVisible();
  });

  test("UAT-B11 a member cannot add the card, and is told to ask an owner", async ({ page, browser }) => {
    const tenant = await newWorkspace(page, "b11");
    const memberEmail = uniqueEmail("b11-member");
    const member = await (await browser.newContext()).newPage();
    await signIn(member, memberEmail);
    const user = (await (await fetch(`${process.env.E2E_AUTH_URL}/__test/user?email=${encodeURIComponent(memberEmail)}`)).json()) as { id: string };
    await adminQuery("INSERT INTO supahound.memberships (tenant_id, user_id, role) VALUES ($1, $2, 'member')", [tenant, user.id]);
    await member.goto(`/w/${tenant}`);
    await expect(member).toHaveURL(new RegExp(`/w/${tenant}/billing$`));
    await expect(member.getByText("Ask a workspace owner or admin to add one")).toBeVisible();
    await expect(member.getByRole("button", { name: "Add card and start trial" })).toHaveCount(0);
    await member.close();
  });

  test("UAT-B12 each project shows its own tier; a busy project bills at Pro from the next renewal", async ({ page }) => {
    const tenant = await newWorkspace(page, "b12");
    await toCheckout(page);
    await page.getByRole("link", { name: "Pay with a good card", exact: true }).click();
    await expect(page).toHaveURL(new RegExp(`/w/${tenant}\\?welcome=1$`));

    // What the daily usage count leaves behind (packages/core/test/db/billing.test.ts covers the count):
    // one quiet project, one above 1 million requests, one above 10 million.
    const { pollPickedProject } = await import("../support/seed");
    for (const name of ["Quiet app", "Busy app", "Huge app"]) await pollPickedProject(tenant, name, []);
    await adminQuery(
      `UPDATE supahound.projects SET requests_30d = CASE name WHEN 'Quiet app' THEN 250000 WHEN 'Busy app' THEN 3400000 ELSE 12000000 END,
         billing_tier = CASE name WHEN 'Quiet app' THEN 'starter' ELSE 'pro' END, usage_counted_at = now()
       WHERE tenant_id = $1`,
      [tenant],
    );
    await page.goto(`/w/${tenant}`);
    await expect(page.getByText(/Starter \$19\.99\/mo · 250,000 requests in 30 days/)).toBeVisible();
    await expect(page.getByText(/Pro \$99\/mo · 3,400,000 requests in 30 days/)).toBeVisible();
    await expect(page.getByText("we will contact you about Enterprise")).toBeVisible();

    // The overview saw the stored seats drift and billed the tiers without proration: nothing is
    // charged before the next renewal.
    const sub = (await stripeState()).subscriptions.find((s) => s.metadata.tenant_id === tenant)!;
    expect(sub.items.data.map((i) => [i.price.id, i.quantity])).toEqual([["price_starter_e2e", 1], ["price_pro_e2e", 2]]);
    expect(sub.last_proration_behavior).toBe("none");
    const row = await billingRow(tenant);
    expect([row!.starter_seats, row!.pro_seats]).toEqual([1, 2]);

    await page.goto(`/w/${tenant}/billing`);
    await expect(page.getByRole("list", { name: "Projects and their tier" })).toContainText("Huge app");
    await expect(page.getByRole("list", { name: "Projects and their tier" })).toContainText("Enterprise: we will contact you");
  });

  // Decision 029: a workspace whose only owner signs in on an exempt domain needs no card.
  const staffEmail = (tag: string) => uniqueEmail(tag).replace(/@example\.com$/, "@staff.test");
  const userId = async (email: string) =>
    ((await (await fetch(`${process.env.E2E_AUTH_URL}/__test/user?email=${encodeURIComponent(email)}`)).json()) as { id: string }).id;

  test("UAT-B13 a staff owner opens a workspace with no card; it needs one once a second owner joins", async ({ page, browser }) => {
    const email = staffEmail("b13");
    await signIn(page, email);
    await page.getByLabel("Workspace name").fill("Billing b13 staff");
    await page.getByRole("button", { name: "Create workspace" }).click();
    await expect(page).toHaveURL(/\/w\/[0-9a-f-]{36}$/);
    const tenant = /\/w\/([0-9a-f-]{36})$/.exec(new URL(page.url()).pathname)![1]!;
    await page.goto(`/w/${tenant}/projects`);
    await expect(page).toHaveURL(new RegExp(`/w/${tenant}/projects$`));
    await page.goto(`/w/${tenant}/billing`);
    await expect(page.getByRole("region", { name: "Complimentary workspace" })).toContainText("Complimentary");
    await expect(page.getByRole("button", { name: "Add card and start trial" })).toHaveCount(0);
    // No Stripe customer, no Checkout, no subscription.
    expect(await billingRow(tenant)).toMatchObject({ status: "none", card_verified_at: null });
    expect((await stripeState()).sessions.filter((s) => s.metadata.tenant_id === tenant)).toHaveLength(0);
    const [exempt] = await adminQuery<{ exempt_owner: string }>("SELECT exempt_owner FROM supahound.billing_accounts WHERE tenant_id = $1", [tenant]);
    expect(exempt?.exempt_owner).toBe(await userId(email));

    // A second owner (here a customer): the exemption ends, and the workspace needs a card.
    const customer = uniqueEmail("b13-customer");
    const other = await (await browser.newContext()).newPage();
    await signIn(other, customer);
    await other.close();
    await adminQuery("INSERT INTO supahound.memberships (tenant_id, user_id, role) VALUES ($1, $2, 'owner')", [tenant, await userId(customer)]);
    await page.goto(`/w/${tenant}`);
    await expect(page).toHaveURL(new RegExp(`/w/${tenant}/billing$`));
    await expect(page.getByRole("button", { name: "Add card and start trial" })).toBeVisible();
  });

  test("UAT-B14 a staff member in a customer's workspace does not make it free", async ({ page, browser }) => {
    const tenant = await newWorkspace(page, "b14");
    const email = staffEmail("b14-staff");
    const staff = await (await browser.newContext()).newPage();
    await signIn(staff, email);
    await adminQuery("INSERT INTO supahound.memberships (tenant_id, user_id, role) VALUES ($1, $2, 'admin')", [tenant, await userId(email)]);
    await staff.goto(`/w/${tenant}`);
    await expect(staff).toHaveURL(new RegExp(`/w/${tenant}/billing$`));
    await expect(staff.getByRole("button", { name: "Add card and start trial" })).toBeVisible();
    expect(await adminQuery("SELECT 1 FROM supahound.billing_accounts WHERE tenant_id = $1 AND exempt_owner IS NOT NULL", [tenant])).toHaveLength(0);
    await staff.close();
  });
});

