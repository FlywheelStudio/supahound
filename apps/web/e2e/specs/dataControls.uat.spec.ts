import { runDataJob } from "@supahound/core/datacontrols/flow";
import { tenantId } from "@supahound/core/tenancy/scope";
import { expect, test, type Browser, type Page } from "@playwright/test";
import pg from "pg";
import {
  addViewer, adminQuery, pollAttack, refuseRevoke, revokeCalls, seedConnection, seedOAuthConnection, userIdFor,
} from "../support/seed";
import { createPaidWorkspace, settled, signIn, tenantFromUrl, uniqueEmail } from "../support/session";

// UAT for data controls (issue #43, decision 037): disconnect Supabase, close and reopen a
// workspace, and the purge 30 days later. Stripe and the Supabase Management API are the fakes in
// support/; Postgres and RLS are real.

const STRIPE = () => process.env.E2E_STRIPE_URL!;

async function stripeCalls(): Promise<{ method: string; path: string; body: Record<string, unknown> }[]> {
  return (await (await fetch(`${STRIPE()}/__test/calls`)).json()) as never;
}

async function owner(page: Page, tag: string): Promise<{ tenant: string; email: string }> {
  const email = uniqueEmail(tag);
  await signIn(page, email);
  await page.getByLabel("Workspace name").fill(`${tag} Co`);
  await createPaidWorkspace(page);
  return { tenant: tenantFromUrl(page), email };
}

// A workspace that paid through the fake Checkout, so it has a real (fake) Stripe subscription.
async function subscribedOwner(page: Page, tag: string): Promise<{ tenant: string; email: string; subscription: string }> {
  const email = uniqueEmail(tag);
  await signIn(page, email);
  await page.getByLabel("Workspace name").fill(`${tag} Co`);
  await page.getByRole("button", { name: "Create workspace" }).click();
  await expect(page).toHaveURL(/\/billing$/);
  const tenant = /\/w\/([0-9a-f-]{36})\//.exec(new URL(page.url()).pathname)![1]!;
  await page.getByRole("checkbox").check();
  await page.getByRole("button", { name: "Add card and start trial" }).click();
  await page.getByRole("link", { name: "Pay with a good card", exact: true }).click();
  await expect(page).toHaveURL(new RegExp(`/w/${tenant}\\?welcome=1$`));
  const [row] = await adminQuery<{ subscription_id: string }>("SELECT subscription_id FROM supahound.billing_accounts WHERE tenant_id = $1", [tenant]);
  return { tenant, email, subscription: row!.subscription_id };
}

async function asMember(browser: Browser, tenant: string, role: "member" | "admin", tag: string): Promise<Page> {
  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  const email = uniqueEmail(tag);
  await signIn(page, email);
  const id = await userIdFor(email);
  if (role === "member") await addViewer(tenant, id);
  else await adminQuery("INSERT INTO supahound.memberships (tenant_id, user_id, role, email) VALUES ($1, $2, 'admin', $3)", [tenant, id, email]);
  return page;
}

async function settingsLink(page: Page, tenant: string): Promise<void> {
  await page.goto(`/w/${tenant}`);
  await settled(page);
  await page.getByRole("navigation", { name: "Main" }).getByRole("link", { name: "Settings" }).click();
  await expect(page.getByRole("heading", { name: "Workspace settings" })).toBeVisible();
}

test.describe("UAT: data controls", () => {
  test("UAT-W29 an owner disconnects Supabase: token and its projects gone, audit kept, grant revoked at Supabase", async ({ page }) => {
    const { tenant } = await owner(page, "w29");
    const conn = await seedOAuthConnection(tenant, `e2e-w29-${tenant}`, `refresh-w29-${tenant}`);
    const other = await seedConnection(tenant, `e2e-w29b-${tenant}`);
    await adminQuery("UPDATE supahound.connections SET label = 'Second org' WHERE id = $1", [other]);
    await pollAttack(tenant, "Shop");
    // pollAttack watches "Shop" through its own connection; move it onto the one we disconnect.
    await adminQuery("UPDATE supahound.projects SET connection_id = $2 WHERE tenant_id = $1", [tenant, conn]);
    const audit = (await adminQuery<{ n: number }>("SELECT count(*)::int AS n FROM supahound.audit_log WHERE tenant_id = $1", [tenant]))[0]!.n;
    expect(audit).toBeGreaterThan(0);

    await settingsLink(page, tenant);
    const list = page.getByRole("list", { name: "Supabase connections" });
    await expect(list).toContainText("1 project");
    await page.getByRole("link", { name: "Disconnect Supabase", exact: true }).click();
    const confirm = page.getByRole("region", { name: "Disconnect Supabase?" });
    await expect(confirm).toContainText("deletes its sealed access token");
    await expect(confirm).toContainText("The 1 project watched through it is removed");
    await expect(confirm).toContainText("Audit log entries stay");

    await confirm.getByLabel(/Type/).fill("supabase");
    await page.getByRole("button", { name: "Disconnect Supabase" }).click();
    await expect(page.getByRole("status")).toHaveText("The name did not match. Nothing was disconnected.");
    expect(await adminQuery("SELECT 1 FROM supahound.connections WHERE id = $1", [conn])).toHaveLength(1);

    await page.getByRole("region", { name: "Disconnect Supabase?" }).getByLabel(/Type/).fill("Supabase");
    await page.getByRole("button", { name: "Disconnect Supabase" }).click();
    await expect(page.getByRole("status")).toContainText("Supabase disconnected. Supahound deleted its access token and stopped watching 1 project.");
    await expect(page.getByRole("status")).toContainText("Supabase confirmed that the grant is revoked.");
    expect(await adminQuery("SELECT 1 FROM supahound.connections WHERE id = $1", [conn])).toHaveLength(0);
    expect(await adminQuery("SELECT 1 FROM supahound.connections WHERE id = $1", [other])).toHaveLength(1);
    expect(await adminQuery("SELECT 1 FROM supahound.projects WHERE tenant_id = $1", [tenant])).toHaveLength(0);
    expect(await adminQuery("SELECT 1 FROM supahound.incidents WHERE tenant_id = $1", [tenant])).toHaveLength(0);
    expect((await adminQuery<{ n: number }>("SELECT count(*)::int AS n FROM supahound.audit_log WHERE tenant_id = $1", [tenant]))[0]!.n).toBe(audit);
    expect((await revokeCalls()).filter((c) => c.refresh_token === `refresh-w29-${tenant}`)).toEqual([
      { client_id: "e2e-oauth-client", refresh_token: `refresh-w29-${tenant}` },
    ]);
    await expect(page.getByRole("list", { name: "Supabase connections" })).not.toContainText("1 project");
  });

  test("UAT-W30 a member cannot disconnect, even by a replayed form; an admin can; a refused revoke is reported", async ({ page, browser }) => {
    const { tenant } = await owner(page, "w30");
    const refresh = `refresh-w30-${tenant}`;
    const conn = await seedOAuthConnection(tenant, `e2e-w30-${tenant}`, refresh);
    await page.goto(`/w/${tenant}/settings?disconnect=${conn}`);
    const ownerForm = await page.locator("form", { has: page.getByRole("button", { name: "Disconnect Supabase" }) }).evaluate((f) => f.outerHTML);

    const member = await asMember(browser, tenant, "member", "w30m");
    await member.goto(`/w/${tenant}/settings?disconnect=${conn}`);
    await expect(member.getByRole("heading", { name: "Workspace settings" })).toBeVisible();
    await expect(member.getByRole("link", { name: /^Disconnect/ })).toHaveCount(0);
    await expect(member.getByRole("button", { name: "Disconnect Supabase" })).toHaveCount(0);
    await expect(member.getByText("Only workspace owners and admins can disconnect Supabase.")).toBeVisible();
    await expect(member.getByRole("button", { name: "Close workspace" })).toHaveCount(0);
    // Replay the owner's form from the member's session.
    await member.evaluate((html) => {
      document.body.insertAdjacentHTML("beforeend", html);
      const form = document.body.lastElementChild as HTMLFormElement;
      (form.querySelector("input[name=confirmLabel]") as HTMLInputElement).value = "Supabase";
    }, ownerForm);
    await member.locator("form").last().getByRole("button", { name: "Disconnect Supabase" }).click();
    await expect(member.getByRole("status")).toHaveText("Only workspace owners and admins can disconnect Supabase.");
    expect(await adminQuery("SELECT 1 FROM supahound.connections WHERE id = $1", [conn])).toHaveLength(1);

    await refuseRevoke(refresh);
    const admin = await asMember(browser, tenant, "admin", "w30a");
    await admin.goto(`/w/${tenant}/settings?disconnect=${conn}`);
    await admin.getByRole("region", { name: "Disconnect Supabase?" }).getByLabel(/Type/).fill("Supabase");
    await admin.getByRole("button", { name: "Disconnect Supabase" }).click();
    await expect(admin.getByRole("status")).toContainText("Supabase did not confirm the revocation: remove the Supahound app");
    expect(await adminQuery("SELECT 1 FROM supahound.connections WHERE id = $1", [conn])).toHaveLength(0);
  });

  test("UAT-W31 the owner closes the workspace: exact name, Stripe canceled at once, polling stops, every page goes to the closed page", async ({ page, browser }) => {
    const { tenant, subscription } = await subscribedOwner(page, "w31");
    await pollAttack(tenant, "Shop");
    const member = await asMember(browser, tenant, "member", "w31m");

    await settingsLink(page, tenant);
    await page.getByLabel(/Type .* to confirm/).fill("w31 co");
    await page.getByRole("button", { name: "Close workspace" }).click();
    await expect(page.getByRole("status")).toHaveText("The name did not match. The workspace is still open.");
    expect(await adminQuery("SELECT 1 FROM supahound.account_closures WHERE tenant_id = $1", [tenant])).toHaveLength(0);

    await page.getByLabel(/Type .* to confirm/).fill("w31 Co");
    await page.getByRole("button", { name: "Close workspace" }).click();
    await expect(page).toHaveURL(new RegExp(`/w/${tenant}/closed\\?closed=1$`));
    await expect(page.getByRole("heading", { name: "w31 Co is closed" })).toBeVisible();
    await expect(page.getByText("(30 days left)")).toBeVisible();

    const cancels = (await stripeCalls()).filter((c) => c.method === "DELETE" && c.path === `/v1/subscriptions/${subscription}`);
    expect(cancels).toHaveLength(1);
    expect(cancels[0]!.body).toMatchObject({ prorate: "false", invoice_now: "false" });
    const [state] = await adminQuery<{ paused: boolean; status: string }>(
      `SELECT (SELECT bool_and(paused) FROM supahound.projects WHERE tenant_id = $1) AS paused,
              (SELECT status FROM supahound.billing_accounts WHERE tenant_id = $1) AS status`, [tenant]);
    expect(state).toEqual({ paused: true, status: "canceled" });

    for (const path of [`/w/${tenant}`, `/w/${tenant}/projects`, `/w/${tenant}/billing`, `/w/${tenant}/settings`]) {
      await member.goto(path);
      await expect(member, path).toHaveURL(new RegExp(`/w/${tenant}/closed$`));
    }
    await expect(member.getByText("Only a workspace owner can reopen it.")).toBeVisible();
    await expect(member.getByRole("button", { name: "Reopen workspace" })).toHaveCount(0);
  });

  test("UAT-W32 an admin cannot close, even by a replayed form; the owner reopens, polling resumes, and billing asks for a card", async ({ page, browser }) => {
    const { tenant } = await subscribedOwner(page, "w32");
    await pollAttack(tenant, "Shop");
    await page.goto(`/w/${tenant}/settings`);
    const ownerForm = await page.locator("form", { has: page.getByRole("button", { name: "Close workspace" }) }).evaluate((f) => f.outerHTML);

    const admin = await asMember(browser, tenant, "admin", "w32a");
    await admin.goto(`/w/${tenant}/settings`);
    await expect(admin.getByText("Only a workspace owner can close the workspace.")).toBeVisible();
    await admin.evaluate((html) => {
      document.body.insertAdjacentHTML("beforeend", html);
      const form = document.body.lastElementChild as HTMLFormElement;
      (form.querySelector("input[name=confirmName]") as HTMLInputElement).value = "w32 Co";
    }, ownerForm);
    await admin.locator("form").last().getByRole("button", { name: "Close workspace" }).click();
    await expect(admin.getByRole("status")).toHaveText("Only a workspace owner can close the workspace.");
    expect(await adminQuery("SELECT 1 FROM supahound.account_closures WHERE tenant_id = $1", [tenant])).toHaveLength(0);

    await page.getByLabel(/Type .* to confirm/).fill("w32 Co");
    await page.getByRole("button", { name: "Close workspace" }).click();
    await expect(page.getByRole("heading", { name: "w32 Co is closed" })).toBeVisible();
    await page.getByRole("button", { name: "Reopen workspace" }).click();
    // Closing canceled the subscription, so the reopened workspace asks for a card again.
    await expect(page).toHaveURL(new RegExp(`/w/${tenant}/billing$`));
    await expect(page.getByRole("heading", { name: "Add a card to start your 7-day free trial" })).toBeVisible();
    const [p] = await adminQuery<{ paused: boolean }>("SELECT bool_or(paused) AS paused FROM supahound.projects WHERE tenant_id = $1", [tenant]);
    expect(p!.paused).toBe(false);
    expect(await adminQuery("SELECT 1 FROM supahound.account_closures WHERE tenant_id = $1", [tenant])).toHaveLength(0);
  });

  test("UAT-W33 30 days after closing, the data job deletes the workspace and keeps only the billing record", async ({ page }) => {
    const { tenant, subscription } = await subscribedOwner(page, "w33");
    await pollAttack(tenant, "Shop");
    const bystander = await (async () => {
      const ctx = await page.context().browser()!.newContext();
      const p = await ctx.newPage();
      return owner(p, "w33b");
    })();
    await pollAttack(bystander.tenant, "Bystander shop");
    const count = async (t: string) => (await adminQuery<{ n: number }>(
      `SELECT (SELECT count(*) FROM supahound.projects WHERE tenant_id = $1) + (SELECT count(*) FROM supahound.incidents WHERE tenant_id = $1)
            + (SELECT count(*) FROM supahound.memberships WHERE tenant_id = $1) + (SELECT count(*) FROM supahound.audit_log WHERE tenant_id = $1) AS n`, [t]))[0]!.n;
    const bystanderBefore = await count(bystander.tenant);

    await page.goto(`/w/${tenant}/settings`);
    await page.getByLabel(/Type .* to confirm/).fill("w33 Co");
    await page.getByRole("button", { name: "Close workspace" }).click();
    await expect(page.getByRole("heading", { name: "w33 Co is closed" })).toBeVisible();

    const app = new pg.Pool({ connectionString: process.env.E2E_APP_DB_URL, max: 1 });
    try {
      expect(await runDataJob(app, tenantId(tenant), new Date(Date.now() + 29 * 86_400_000))).toMatchObject({ kind: "retention" });
      expect(await runDataJob(app, tenantId(tenant), new Date(Date.now() + 31 * 86_400_000))).toEqual({ kind: "purged" });
    } finally {
      await app.end();
    }
    expect(Number(await count(tenant))).toBe(0);
    expect(await adminQuery("SELECT 1 FROM supahound.tenants WHERE id = $1", [tenant])).toHaveLength(0);
    const [kept] = await adminQuery<{ subscription_id: string; terms_version: string; stripe_customer_id: string }>(
      "SELECT subscription_id, terms_version, stripe_customer_id FROM supahound.account_closures WHERE tenant_id = $1", [tenant]);
    expect(kept).toMatchObject({ subscription_id: subscription, terms_version: expect.any(String), stripe_customer_id: expect.stringMatching(/^cus_/) });
    expect(Number(await count(bystander.tenant))).toBe(Number(bystanderBefore));

    // The former owner now has no workspace: the app sends them to onboarding, the old URL is a 404.
    await page.goto("/app");
    await expect(page).toHaveURL(/\/onboarding$/);
    const res = await page.goto(`/w/${tenant}`);
    expect(res?.status()).toBe(404);
  });
});

