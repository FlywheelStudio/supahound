import { runDataJob } from "@supahound/core/datacontrols/flow";
import { templateExplanation } from "@supahound/core/explainer/template";
import { pollProject } from "@supahound/core/poller/pollProject";
import { createWorkspace } from "@supahound/core/db/user";
import { projectScope, tenantId, verifiedUserId } from "@supahound/core/tenancy/scope";
import { TokenVault } from "@supahound/core/vault/vault";
import { expect, test, type Browser, type Page } from "@playwright/test";
import pg from "pg";
import { countMailsTo, lastMailTo } from "../support/mail";
import { addViewer, adminQuery, pollAttack, refuseRevoke, revokeCalls, seedConnection, seedOAuthConnection, userIdFor } from "../support/seed";
import { createPaidWorkspace, settled, signIn, tenantFromUrl, uniqueEmail } from "../support/session";

// UAT for data controls (issue #43, decision 037): disconnect Supabase (with the email to the
// project's people), a grant revoked outside Supahound, close at the end of the paid period,
// keep open and reopen, one free trial ever, and the purge that keeps the record. Stripe and the
// Supabase Management API are the fakes in support/; Postgres and RLS are real.

const STRIPE = () => process.env.E2E_STRIPE_URL!;

async function stripeCalls(): Promise<{ method: string; path: string; body: Record<string, unknown> }[]> {
  return (await (await fetch(`${STRIPE()}/__test/calls`)).json()) as never;
}

async function stripeSubscription(id: string): Promise<{ status: string; trial_period_days: number | null; cancel_at_period_end: boolean }> {
  const state = (await (await fetch(`${STRIPE()}/__test/state`)).json()) as { subscriptions: { id: string; status: string; trial_period_days: number | null; cancel_at_period_end: boolean }[] };
  return state.subscriptions.find((s) => s.id === id)!;
}

// Stripe ends the subscription at the end of its period, and that day comes.
async function periodEnds(tenant: string, subscription: string): Promise<void> {
  await fetch(`${STRIPE()}/__test/cancel`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ subscription }) });
  await expect.poll(async () => (await adminQuery<{ status: string }>("SELECT status FROM supahound.billing_accounts WHERE tenant_id = $1", [tenant]))[0]!.status).toBe("canceled");
  await adminQuery(
    "UPDATE supahound.account_closures SET closed_at = now() - interval '1 day', access_ends_at = now() - interval '1 second' WHERE tenant_id = $1",
    [tenant],
  );
}

async function owner(page: Page, tag: string): Promise<{ tenant: string; email: string }> {
  const email = uniqueEmail(tag);
  await signIn(page, email);
  await page.getByLabel("Workspace name").fill(`${tag} Co`);
  await createPaidWorkspace(page);
  return { tenant: tenantFromUrl(page), email };
}

async function payThroughCheckout(page: Page, tenant: string, button: RegExp): Promise<string> {
  await page.getByRole("checkbox").check();
  await page.getByRole("button", { name: button }).click();
  await page.getByRole("link", { name: "Pay with a good card", exact: true }).click();
  await expect(page).toHaveURL(new RegExp(`/w/${tenant}\\?welcome=1$`));
  const [row] = await adminQuery<{ subscription_id: string }>("SELECT subscription_id FROM supahound.billing_accounts WHERE tenant_id = $1", [tenant]);
  return row!.subscription_id;
}

// A workspace that paid through the fake Checkout, so it has a real (fake) Stripe subscription.
async function subscribedOwner(page: Page, tag: string, email = uniqueEmail(tag)): Promise<{ tenant: string; email: string; subscription: string }> {
  await signIn(page, email);
  await page.getByLabel("Workspace name").fill(`${tag} Co`);
  await page.getByRole("button", { name: "Create workspace" }).click();
  await expect(page).toHaveURL(/\/billing$/);
  const tenant = /\/w\/([0-9a-f-]{36})\//.exec(new URL(page.url()).pathname)![1]!;
  return { tenant, email, subscription: await payThroughCheckout(page, tenant, /^Add card and start trial$/) };
}

async function asMember(browser: Browser, tenant: string, role: "member" | "admin", tag: string): Promise<{ page: Page; email: string }> {
  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  const email = uniqueEmail(tag);
  await signIn(page, email);
  const id = await userIdFor(email);
  if (role === "member") {
    await addViewer(tenant, id);
    await adminQuery("UPDATE supahound.memberships SET email = $3 WHERE tenant_id = $1 AND user_id = $2", [tenant, id, email]);
  } else {
    await adminQuery("INSERT INTO supahound.memberships (tenant_id, user_id, role, email) VALUES ($1, $2, 'admin', $3)", [tenant, id, email]);
  }
  return { page, email };
}

async function openSettings(page: Page, tenant: string): Promise<void> {
  await page.goto(`/w/${tenant}`);
  await settled(page);
  await page.getByRole("navigation", { name: "Main" }).getByRole("link", { name: "Settings" }).click();
  await expect(page.getByRole("heading", { name: "Workspace settings" })).toBeVisible();
}

const tokenLength = async (connection: string) =>
  (await adminQuery<{ n: number }>("SELECT length(sealed_token) AS n FROM supahound.connections WHERE id = $1", [connection]))[0]?.n;

test.describe("UAT: data controls", () => {
  test("UAT-W29 an owner disconnects Supabase: token gone, polling stops, history kept for 30 days, everyone on the project is emailed", async ({ page, browser }) => {
    const { tenant, email } = await owner(page, "w29");
    await pollAttack(tenant, "Shop");
    const conn = await seedOAuthConnection(tenant, `e2e-w29-${tenant}`, `refresh-w29-${tenant}`);
    // pollAttack watches "Shop" through its own connection; move it onto the one we disconnect.
    await adminQuery("UPDATE supahound.projects SET connection_id = $2 WHERE tenant_id = $1", [tenant, conn]);
    const viewer = await asMember(browser, tenant, "member", "w29v");

    await openSettings(page, tenant);
    await page.getByRole("link", { name: "Disconnect Supabase", exact: true }).last().click();
    const confirm = page.getByRole("region", { name: "Disconnect Supabase?" });
    await expect(confirm).toContainText("deletes its sealed access token");
    await expect(confirm).toContainText("Everyone on the 1 project watched through it gets an email");
    await expect(confirm).toContainText("after 30 days, unless you reconnect");

    await confirm.getByLabel(/Type/).fill("supabase");
    await page.getByRole("button", { name: "Disconnect Supabase" }).click();
    await expect(page.getByRole("status")).toHaveText("The name did not match. Nothing was disconnected.");
    expect(await tokenLength(conn)).toBeGreaterThan(0);

    await page.getByRole("region", { name: "Disconnect Supabase?" }).getByLabel(/Type/).fill("Supabase");
    await page.getByRole("button", { name: "Disconnect Supabase" }).click();
    await expect(page.getByRole("status")).toContainText("stopped watching 1 project. Everyone on it got an email.");
    await expect(page.getByRole("status")).toContainText("Supabase confirmed that the grant is revoked.");
    await expect(page.getByRole("list", { name: "Supabase connections" })).toContainText(/Disconnected on \d{4}-\d{2}-\d{2}\. History deleted on/);

    expect(await tokenLength(conn)).toBe(0);
    const [state] = await adminQuery<{ paused: boolean; incidents: number }>(
      `SELECT (SELECT bool_and(paused) FROM supahound.projects WHERE connection_id = $2) AS paused,
              (SELECT count(*)::int FROM supahound.incidents WHERE tenant_id = $1) AS incidents`, [tenant, conn]);
    expect(state).toEqual({ paused: true, incidents: 1 });
    expect((await revokeCalls()).filter((c) => c.refresh_token === `refresh-w29-${tenant}`)).toHaveLength(1);

    for (const to of [email, viewer.email]) {
      const mail = await lastMailTo(to, /^Supabase was disconnected from w29 Co$/);
      expect(mail.text).toContain(`${email} disconnected the Supabase connection "Supabase" from w29 Co`);
      expect(mail.text).toContain("stopped watching: Shop.");
      expect(mail.text).toMatch(/deletes these projects' history on \d{4}-\d{2}-\d{2} unless someone reconnects/);
    }
    await page.goto(`/w/${tenant}`);
    // The Projects list on the overview (the open-incidents list above it names Shop too).
    await expect(page.getByRole("listitem").filter({ hasText: "Shop" }).last()).toContainText("Supabase disconnected");
  });

  test("UAT-W30 a member cannot disconnect, even by a replayed form; an admin can; a refused revoke is reported", async ({ page, browser }) => {
    const { tenant } = await owner(page, "w30");
    const refresh = `refresh-w30-${tenant}`;
    const conn = await seedOAuthConnection(tenant, `e2e-w30-${tenant}`, refresh);
    await page.goto(`/w/${tenant}/settings?disconnect=${conn}`);
    const ownerForm = await page.locator("form", { has: page.getByRole("button", { name: "Disconnect Supabase" }) }).evaluate((f) => f.outerHTML);

    const { page: member } = await asMember(browser, tenant, "member", "w30m");
    await member.goto(`/w/${tenant}/settings?disconnect=${conn}`);
    await expect(member.getByRole("heading", { name: "Workspace settings" })).toBeVisible();
    await expect(member.getByRole("link", { name: /^Disconnect/ })).toHaveCount(0);
    await expect(member.getByRole("button", { name: "Disconnect Supabase" })).toHaveCount(0);
    await expect(member.getByRole("button", { name: "Close workspace" })).toHaveCount(0);
    await member.evaluate((html) => {
      document.body.insertAdjacentHTML("beforeend", html);
      const form = document.body.lastElementChild as HTMLFormElement;
      (form.querySelector("input[name=confirmLabel]") as HTMLInputElement).value = "Supabase";
    }, ownerForm);
    await member.locator("form").last().getByRole("button", { name: "Disconnect Supabase" }).click();
    await expect(member.getByRole("status")).toHaveText("Only workspace owners and admins can disconnect Supabase.");
    expect(await tokenLength(conn)).toBeGreaterThan(0);

    await refuseRevoke(refresh);
    const { page: admin } = await asMember(browser, tenant, "admin", "w30a");
    await admin.goto(`/w/${tenant}/settings?disconnect=${conn}`);
    await admin.getByRole("region", { name: "Disconnect Supabase?" }).getByLabel(/Type/).fill("Supabase");
    await admin.getByRole("button", { name: "Disconnect Supabase" }).click();
    await expect(admin.getByRole("status")).toContainText("Supabase did not confirm the revocation: remove the Supahound app");
    // A connection with no project has no history to keep: it goes at once.
    expect(await adminQuery("SELECT 1 FROM supahound.connections WHERE id = $1", [conn])).toHaveLength(0);
  });

  test("UAT-W31 a grant revoked outside Supahound stops polling, emails the project's people once, and shows on settings", async ({ page }) => {
    const { tenant, email } = await owner(page, "w31");
    await pollAttack(tenant, "Shop");
    const conn = await seedConnection(tenant, JSON.stringify({ accessToken: "old", refreshToken: `refresh-w31-${tenant}`, expiresAt: "2000-01-01T00:00:00Z" }));
    await adminQuery("UPDATE supahound.projects SET connection_id = $2, last_polled_at = NULL WHERE tenant_id = $1", [tenant, conn]);
    // pollAttack's run covers the last minutes; without it the next window starts fresh.
    await adminQuery("DELETE FROM supahound.poll_runs WHERE tenant_id = $1", [tenant]);
    const [project] = await adminQuery<{ id: string }>("SELECT id FROM supahound.projects WHERE tenant_id = $1", [tenant]);

    // The poller (core's real pollProject) refreshes the token; Supabase answers invalid_grant.
    const app = new pg.Pool({ connectionString: process.env.E2E_APP_DB_URL, max: 2 });
    const sent: string[] = [];
    try {
      const outcome = await pollProject(projectScope(tenant, project!.id), {
        app, vault: TokenVault.fromEnv({ SUPAHOUND_MASTER_KEYS: process.env.E2E_MASTER_KEYS }),
        oauth: {
          clientId: "e2e-oauth-client", clientSecret: "e2e-oauth-secret", redirectUri: "http://x/cb",
          fetch: (async () => new Response(JSON.stringify({ error: "invalid_grant" }), { status: 400 })) as unknown as typeof fetch,
        },
        queryLogs: async () => [], queryPolicies: async () => [],
        explain: async (f) => ({ explanation: templateExplanation(f), source: "template", model: null, zdrConfirmed: null, attempts: [] }),
        alerts: { send: async (m) => { sent.push(`${m.to}|${m.subject}`); }, from: { email: "alerts@supahound.test", name: "Supahound" }, appUrl: process.env.E2E_APP_URL! },
      });
      expect(outcome).toEqual({ status: "unable_to_assess", errorCode: "grant_revoked" });
    } finally {
      await app.end();
    }
    expect(sent).toEqual([`${email}|Supahound lost access to Supabase for w31 Co`]);
    await openSettings(page, tenant);
    await expect(page.getByRole("list", { name: "Supabase connections" })).toContainText(/Access revoked in Supabase on \d{4}-\d{2}-\d{2}/);
    await expect(page.getByRole("button", { name: "Reconnect Supabase" })).toBeVisible();
  });

  test("UAT-W32 the owner closes: exact name, Stripe cancels at the period end, the workspace works until then, then every page goes to the closed page", async ({ page, browser }) => {
    const { tenant, subscription } = await subscribedOwner(page, "w32");
    await pollAttack(tenant, "Shop");
    const { page: member } = await asMember(browser, tenant, "member", "w32m");

    await openSettings(page, tenant);
    await page.getByLabel(/Type .* to confirm/).fill("w32 co");
    await page.getByRole("button", { name: "Close workspace" }).click();
    await expect(page.getByRole("status")).toHaveText("The name did not match. The workspace is still open.");
    expect(await adminQuery("SELECT 1 FROM supahound.account_closures WHERE tenant_id = $1", [tenant])).toHaveLength(0);

    await page.getByLabel(/Type .* to confirm/).fill("w32 Co");
    await page.getByRole("button", { name: "Close workspace" }).click();
    await expect(page.getByRole("status")).toContainText("Workspace closing. It works until");
    await expect(page.getByRole("heading", { name: /^This workspace closes on \d{4}-\d{2}-\d{2}$/ })).toBeVisible();

    const updates = (await stripeCalls()).filter((c) => c.method === "POST" && c.path === `/v1/subscriptions/${subscription}`);
    expect(updates.map((c) => c.body.cancel_at_period_end)).toEqual(["true"]);
    expect(await stripeSubscription(subscription)).toMatchObject({ status: "trialing", cancel_at_period_end: true });
    // Until the period ends, the workspace works and says when it closes.
    await member.goto(`/w/${tenant}`);
    await expect(member.getByRole("alert")).toContainText("This workspace closes on");
    await expect(member.getByRole("heading", { name: "Overview" })).toBeVisible();

    await periodEnds(tenant, subscription);
    for (const path of [`/w/${tenant}`, `/w/${tenant}/projects`, `/w/${tenant}/billing`, `/w/${tenant}/settings`]) {
      await member.goto(path);
      await expect(member, path).toHaveURL(new RegExp(`/w/${tenant}/closed$`));
    }
    await expect(member.getByRole("heading", { name: "w32 Co is closed" })).toBeVisible();
    await expect(member.getByText("Only a workspace owner can reopen it.")).toBeVisible();
  });

  test("UAT-W33 an admin cannot close, even by a replayed form; the owner keeps it open, later reopens, and gets no second free trial", async ({ page, browser }) => {
    const { tenant, subscription } = await subscribedOwner(page, "w33");
    await page.goto(`/w/${tenant}/settings`);
    const ownerForm = await page.locator("form", { has: page.getByRole("button", { name: "Close workspace" }) }).evaluate((f) => f.outerHTML);

    const { page: admin } = await asMember(browser, tenant, "admin", "w33a");
    await admin.goto(`/w/${tenant}/settings`);
    await expect(admin.getByText("Only a workspace owner can close the workspace.")).toBeVisible();
    await admin.evaluate((html) => {
      document.body.insertAdjacentHTML("beforeend", html);
      const form = document.body.lastElementChild as HTMLFormElement;
      (form.querySelector("input[name=confirmName]") as HTMLInputElement).value = "w33 Co";
    }, ownerForm);
    await admin.locator("form").last().getByRole("button", { name: "Close workspace" }).click();
    await expect(admin.getByRole("status")).toHaveText("Only a workspace owner can close the workspace.");
    expect(await adminQuery("SELECT 1 FROM supahound.account_closures WHERE tenant_id = $1", [tenant])).toHaveLength(0);

    // Close, then keep it open before the period ends: the Stripe cancel is undone.
    await page.getByLabel(/Type .* to confirm/).fill("w33 Co");
    await page.getByRole("button", { name: "Close workspace" }).click();
    await page.getByRole("button", { name: "Keep the workspace open" }).click();
    await expect(page).toHaveURL(new RegExp(`/w/${tenant}$`));
    expect(await stripeSubscription(subscription)).toMatchObject({ cancel_at_period_end: false });
    expect(await adminQuery("SELECT 1 FROM supahound.account_closures WHERE tenant_id = $1", [tenant])).toHaveLength(0);

    // Close again and let the period end; then reopen from the closed page.
    await page.goto(`/w/${tenant}/settings`);
    await page.getByLabel(/Type .* to confirm/).fill("w33 Co");
    await page.getByRole("button", { name: "Close workspace" }).click();
    await periodEnds(tenant, subscription);
    await page.goto(`/w/${tenant}/closed`);
    await page.getByRole("button", { name: "Reopen workspace" }).click();
    await expect(page).toHaveURL(new RegExp(`/w/${tenant}/billing$`));
    await expect(page.getByRole("heading", { name: "Add a card to start your subscription" })).toBeVisible();
    await expect(page.locator("#billing-terms")).toContainText("No free trial");
    const second = await payThroughCheckout(page, tenant, /^Add card and subscribe$/);
    expect(await stripeSubscription(second)).toMatchObject({ status: "active", trial_period_days: null });
  });

  test("UAT-W34 an owner who had a free trial gets none in a second workspace", async ({ page }) => {
    const { email } = await subscribedOwner(page, "w34");
    // The app creates one workspace per sign-in; the second comes straight from core.
    const app = new pg.Pool({ connectionString: process.env.E2E_APP_DB_URL, max: 1 });
    let second: string;
    try {
      second = await createWorkspace(app, verifiedUserId(await userIdFor(email)), "w34 Second", email);
    } finally {
      await app.end();
    }
    await page.goto(`/w/${second}`);
    await expect(page).toHaveURL(/\/billing$/);
    await expect(page.getByRole("heading", { name: "Add a card to start your subscription" })).toBeVisible();
    await page.getByRole("checkbox").check();
    await page.getByRole("button", { name: "Add card and subscribe" }).click();
    await expect(page.locator("#terms")).toContainText("No free trial");
  });

  test("UAT-W35 once the workspace stops paying, the data job deletes its logs and history and keeps its record; members still see the closed page", async ({ page, browser }) => {
    const { tenant, subscription } = await subscribedOwner(page, "w35");
    await pollAttack(tenant, "Shop");
    const { page: member } = await asMember(browser, tenant, "member", "w35m");
    const bystander = await owner(await (await browser.newContext()).newPage(), "w35b");
    await pollAttack(bystander.tenant, "Bystander shop");
    const counts = async (t: string) => (await adminQuery<Record<string, number>>(
      `SELECT (SELECT count(*)::int FROM supahound.tenants WHERE id = $1) AS tenants,
              (SELECT count(*)::int FROM supahound.memberships WHERE tenant_id = $1) AS memberships,
              (SELECT count(*)::int FROM supahound.billing_accounts WHERE tenant_id = $1) AS billing,
              (SELECT count(*)::int FROM supahound.stripe_events WHERE tenant_id = $1) AS stripe_events,
              (SELECT count(*)::int FROM supahound.audit_log WHERE tenant_id = $1) AS audit,
              (SELECT count(*)::int FROM supahound.connections WHERE tenant_id = $1) AS connections,
              (SELECT count(*)::int FROM supahound.projects WHERE tenant_id = $1) AS projects,
              (SELECT count(*)::int FROM supahound.incidents WHERE tenant_id = $1) AS incidents`, [t]))[0]!;
    const bystanderBefore = await counts(bystander.tenant);

    await page.goto(`/w/${tenant}/settings`);
    await page.getByLabel(/Type .* to confirm/).fill("w35 Co");
    await page.getByRole("button", { name: "Close workspace" }).click();
    await expect(page.getByRole("heading", { name: /^This workspace closes on/ })).toBeVisible();
    const before = await counts(tenant);

    const app = new pg.Pool({ connectionString: process.env.E2E_APP_DB_URL, max: 1 });
    try {
      // A trial is not paying, but the purge waits for the end of the period plus 30 days.
      expect(await runDataJob(app, tenantId(tenant), new Date())).toMatchObject({ purged: false });
      await periodEnds(tenant, subscription);
      await adminQuery("UPDATE supahound.account_closures SET purge_after = now() WHERE tenant_id = $1", [tenant]);
      expect(await runDataJob(app, tenantId(tenant), new Date())).toMatchObject({ paying: false, purged: true });
    } finally {
      await app.end();
    }
    const after = await counts(tenant);
    expect(after).toEqual({ ...before, stripe_events: after.stripe_events, connections: 0, projects: 0, incidents: 0 });
    expect(after.stripe_events).toBeGreaterThanOrEqual(before.stripe_events!);
    expect(await counts(bystander.tenant)).toEqual(bystanderBefore);

    await member.goto(`/w/${tenant}`);
    await expect(member).toHaveURL(new RegExp(`/w/${tenant}/closed$`));
    await expect(member.getByText("The workspace record, its billing and payment history and its audit log are kept.")).toBeVisible();
    await expect(member.getByRole("button", { name: "Reopen workspace" })).toHaveCount(0);
    expect(countMailsTo("nobody@example.com", /./)).toBe(0);
  });
});
