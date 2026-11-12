import { expect, test, type Page } from "@playwright/test";
import { addViewer, adminQuery, seedConnection, setSupabaseProjects, userIdFor } from "../support/seed";
import { settled, signIn, uniqueEmail } from "../support/session";

// UAT for one Stripe subscription per project (issue #99, decisions 032 and 041, docs/TESTING.md).
// The real Worker and Postgres; Stripe is the fake in support/fakeStripe.ts, reached through the
// real Stripe SDK; the Supabase Management API is the fake in support/fakeManagement.ts.

const STRIPE = () => process.env.E2E_STRIPE_URL!;
const DAY = /\d{4}-\d{2}-\d{2}/;

interface FakeSub {
  id: string; status: string; trial_end: number | null; cancel_at_period_end: boolean;
  metadata: { tenant_id?: string; project_id?: string }; items: { data: { price: { id: string } }[] };
}

async function projectSubs(tenant: string): Promise<FakeSub[]> {
  const state = (await (await fetch(`${STRIPE()}/__test/state`)).json()) as { subscriptions: FakeSub[] };
  return state.subscriptions.filter((s) => s.metadata.tenant_id === tenant && s.metadata.project_id);
}

async function stripeCalls(): Promise<{ method: string; path: string; body: Record<string, unknown> }[]> {
  return (await (await fetch(`${STRIPE()}/__test/calls`)).json()) as never;
}

// A new workspace whose owner added a good card (the workspace trial starts), with one Supabase
// connection that lists the given projects.
async function ownerWithCard(page: Page, tag: string, projects: { ref: string; name: string }[]) {
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
  const token = `e2e-${tag}-${tenant}`;
  await setSupabaseProjects(token, projects);
  await seedConnection(tenant, token);
  return { tenant, email };
}

async function watch(page: Page, tenant: string, name: string): Promise<string> {
  await page.goto(`/w/${tenant}/projects`);
  await page.getByRole("checkbox", { name: new RegExp(name) }).check();
  await page.getByRole("button", { name: "Watch selected projects" }).click();
  await expect(page.getByRole("status")).toHaveText(/Watching 1 new project/);
  const [p] = await adminQuery<{ id: string }>("SELECT id FROM supahound.projects WHERE tenant_id = $1 AND name = $2", [tenant, name]);
  return p!.id;
}

async function remove(page: Page, tenant: string, name: string): Promise<void> {
  await page.goto(`/w/${tenant}/projects`);
  await settled(page);
  await page.getByRole("link", { name: `Remove ${name}` }).click();
  await expect(page.getByRole("heading", { name: `Remove ${name}?` })).toBeVisible();
  await expect(page.getByText("Its subscription stops at the end of its paid period")).toBeVisible();
  await expect(page.getByTestId("removal-preview")).toHaveText(SENTENCE);
  await page.getByLabel(/to confirm/).fill(name);
  await page.getByRole("button", { name: "Remove project" }).click();
  await expect(page.getByRole("status")).toHaveText(/Removal scheduled/);
}

// Erik's rule (decision 042), as every page words it.
const SENTENCE = new RegExp(`The project stays active until (${DAY.source}) and is deleted on (${DAY.source}) unless you keep it\\.`);

const endTrial = (tenant: string) =>
  adminQuery("UPDATE supahound.billing_accounts SET trial_end = now() - interval '1 day' WHERE tenant_id = $1", [tenant]);

test.describe("UAT: one subscription per project", () => {
  test("UAT-W45 a project added during the trial shares the workspace trial; its plan page shows the first charge", async ({ page }) => {
    const { tenant } = await ownerWithCard(page, "w45", [{ ref: "trialtrialtrialtrial", name: "Trial app" }]);
    const [{ trial_end: trialEnd }] = await adminQuery<{ trial_end: Date }>("SELECT trial_end FROM supahound.billing_accounts WHERE tenant_id = $1", [tenant]) as [{ trial_end: Date }];
    const project = await watch(page, tenant, "Trial app");
    const [sub] = await projectSubs(tenant);
    expect([sub!.metadata.project_id, sub!.status, sub!.trial_end]).toEqual([project, "trialing", Math.floor(trialEnd.getTime() / 1000)]);

    await page.goto(`/w/${tenant}/p/${project}/settings/plan`);
    await expect(page.getByTestId("subscription-status")).toHaveText("Free trial");
    await expect(page.getByTestId("subscription-next")).toHaveText(new RegExp(`^First charge ${DAY.source} \\(after the trial\\)$`));
    await expect(page.getByRole("region", { name: "Invoices" })).toContainText("No invoices yet.");
    await page.goto(`/w/${tenant}/billing`);
    await expect(page.getByRole("table", { name: "Subscriptions by project" })).toContainText("Trial app");
    await expect(page.getByRole("region", { name: "Project subscriptions" })).toContainText("$19.99 for 1 projects");
  });

  test("UAT-W46 a project added after the trial is billed from the day it is added, and its invoice shows on its page", async ({ page }) => {
    const { tenant } = await ownerWithCard(page, "w46", [{ ref: "laterlaterlaterlater", name: "Later app" }]);
    await endTrial(tenant);
    const project = await watch(page, tenant, "Later app");
    const [sub] = await projectSubs(tenant);
    expect([sub!.status, sub!.trial_end]).toEqual(["active", null]);
    const create = (await stripeCalls()).filter((c) => c.method === "POST" && c.path === "/v1/subscriptions" && (c.body.metadata as Record<string, string>)?.project_id === project);
    expect(create).toHaveLength(1);
    expect(create[0]!.body.trial_end).toBeUndefined();

    await page.goto(`/w/${tenant}/p/${project}/settings/plan`);
    await expect(page.getByTestId("subscription-status")).toHaveText("Active");
    await expect(page.getByTestId("subscription-next")).toHaveText(new RegExp(`^Next charge ${DAY.source}$`));
    await expect(page.getByRole("region", { name: "Invoices" })).toContainText("$19.99 · paid");
  });

  test("UAT-W47 removing a project cancels its subscription at the period end; picking it again keeps it and resumes it with no second charge", async ({ page }) => {
    const { tenant } = await ownerWithCard(page, "w47", [{ ref: "gonegonegonegonegone", name: "Gone app" }]);
    await endTrial(tenant);
    await watch(page, tenant, "Gone app");
    const [sub] = await projectSubs(tenant);
    await remove(page, tenant, "Gone app");
    await expect.poll(async () => (await projectSubs(tenant))[0]!.cancel_at_period_end).toBe(true);
    expect((await projectSubs(tenant))[0]!.status).toBe("active");
    // The project stays until its deletion date (decision 042), so the row keeps its link.
    expect(await adminQuery("SELECT 1 FROM supahound.project_subscriptions WHERE subscription_id = $1 AND project_id IS NOT NULL", [sub!.id])).toHaveLength(1);
    await page.goto(`/w/${tenant}/billing`);
    await expect(page.getByRole("table", { name: "Subscriptions by project" })).toContainText(/Gone app.*Ends \d{4}-\d{2}-\d{2}, nothing more is charged/);
    await expect(page.getByRole("region", { name: "Removals scheduled" })).toContainText(SENTENCE);

    await watch(page, tenant, "Gone app");
    await expect.poll(async () => (await projectSubs(tenant)).map((s) => [s.id, s.cancel_at_period_end])).toEqual([[sub!.id, false]]);
    expect(await adminQuery("SELECT 1 FROM supahound.projects WHERE tenant_id = $1 AND removal_requested_at IS NOT NULL", [tenant])).toHaveLength(0);
  });

  test("UAT-W50 remove shows the dates on every page, and Keep project cancels the removal and resumes the subscription", async ({ page }) => {
    const { tenant } = await ownerWithCard(page, "w50", [{ ref: "keepkeepkeepkeepkeep", name: "Kept app" }]);
    await endTrial(tenant);
    const project = await watch(page, tenant, "Kept app");
    const [sub] = await projectSubs(tenant);
    await remove(page, tenant, "Kept app");
    await expect.poll(async () => (await projectSubs(tenant))[0]!.cancel_at_period_end).toBe(true);

    // The dates: the subscription's period end, and 7 days after it.
    const [row] = await adminQuery<{ active_until: Date; delete_after: Date }>("SELECT active_until, delete_after FROM supahound.projects WHERE id = $1", [project]);
    const day = (d: Date) => d.toISOString().slice(0, 10);
    const words = `The project stays active until ${day(row!.active_until)} and is deleted on ${day(row!.delete_after)} unless you keep it.`;
    expect(row!.delete_after.getTime() - row!.active_until.getTime()).toBe(7 * 86_400_000);
    await expect(page.getByTestId("removal-scheduled")).toContainText(words);
    await page.goto(`/w/${tenant}/p/${project}`);
    await expect(page.getByTestId("removal-scheduled")).toContainText(words);
    await page.goto(`/w/${tenant}/billing`);
    await expect(page.getByRole("region", { name: "Removals scheduled" })).toContainText(words);
    await page.goto(`/w/${tenant}/p/${project}/settings/plan`);
    await expect(page.getByTestId("removal-scheduled")).toContainText(words);
    await expect(page.getByTestId("removal-scheduled")).toContainText("nothing extra is charged");

    await page.getByRole("button", { name: "Keep project" }).click();
    await expect(page).toHaveURL(new RegExp(`/settings/plan\\?kept=1$`));
    await expect(page.getByRole("status")).toHaveText("Project kept. Its removal is canceled.");
    await expect(page.getByTestId("removal-scheduled")).toHaveCount(0);
    await expect.poll(async () => (await projectSubs(tenant)).map((s) => [s.id, s.cancel_at_period_end])).toEqual([[sub!.id, false]]);
    expect(await adminQuery("SELECT 1 FROM supahound.projects WHERE id = $1 AND removal_requested_at IS NULL", [project])).toHaveLength(1);
  });

  test("UAT-W48 a project Viewer sees the plan but cannot manage billing or see invoices, even by a replayed form", async ({ page, browser }) => {
    const { tenant } = await ownerWithCard(page, "w48", [{ ref: "viewviewviewviewview", name: "Viewed app" }]);
    const project = await watch(page, tenant, "Viewed app");
    await page.goto(`/w/${tenant}/p/${project}/settings/plan`);
    const ownerForm = await page.locator("form", { has: page.getByRole("button", { name: "Manage card and invoices" }) }).evaluate((f) => f.outerHTML);

    const viewer = await (await browser.newContext()).newPage();
    const email = uniqueEmail("w48v");
    await signIn(viewer, email);
    await addViewer(tenant, await userIdFor(email));
    await viewer.goto(`/w/${tenant}/p/${project}/settings/plan`);
    await expect(viewer.getByTestId("subscription-status")).toHaveText("Free trial");
    await expect(viewer.getByText("Workspace owners and admins manage the card and billing.")).toBeVisible();
    await expect(viewer.getByRole("button", { name: "Manage card and invoices" })).toHaveCount(0);
    await expect(viewer.getByRole("region", { name: "Invoices" })).toHaveCount(0);

    const portals = async () => (await stripeCalls()).filter((c) => c.path === "/v1/billing_portal/sessions").length;
    const before = await portals();
    await viewer.evaluate((html) => document.body.insertAdjacentHTML("beforeend", html), ownerForm);
    await viewer.locator("form").last().getByRole("button", { name: "Manage card and invoices" }).click();
    await expect(viewer).toHaveURL(new RegExp(`/settings/plan\\?error=role$`));
    await expect(viewer.getByRole("alert")).toHaveText("Only workspace owners and admins can manage billing.");
    expect(await portals()).toBe(before);
    await viewer.close();
  });

  test("UAT-W49 the owner opens the Billing Portal from the plan page, and comes back to it", async ({ page }) => {
    const { tenant } = await ownerWithCard(page, "w49", [{ ref: "portalportalportalpo", name: "Portal app" }]);
    const project = await watch(page, tenant, "Portal app");
    await page.goto(`/w/${tenant}/p/${project}/settings/plan`);
    await page.getByRole("button", { name: "Manage card and invoices" }).click();
    await expect(page.getByRole("heading", { name: "Fake Billing Portal" })).toBeVisible();
    const call = (await stripeCalls()).filter((c) => c.path === "/v1/billing_portal/sessions").at(-1)!;
    expect(String(call.body.return_url)).toMatch(new RegExp(`/w/${tenant}/p/${project}/settings/plan$`));
  });

  test("UAT-B15 a signed event for a project subscription is processed once; a replay changes nothing", async ({ page }) => {
    const { tenant } = await ownerWithCard(page, "b15", [{ ref: "hookhookhookhookhook", name: "Hook app" }]);
    const project = await watch(page, tenant, "Hook app");
    const [sub] = await projectSubs(tenant);
    type Delivery = { event: { id: string; type: string; data: { object: { id: string } } }; status: number; body: string };
    const created = async () => ((await (await fetch(`${STRIPE()}/__test/events`)).json()) as Delivery[])
      .filter((e) => e.event.type === "customer.subscription.created" && e.event.data.object.id === sub!.id);
    await expect.poll(async () => (await created()).length).toBe(1);
    expect(JSON.parse((await created())[0]!.body)).toEqual({ result: "processed" });
    const replay = (await (await fetch(`${STRIPE()}/__test/replay`, { method: "POST" })).json()) as { status: number; body: string };
    expect([replay.status, JSON.parse(replay.body)]).toEqual([200, { result: "duplicate" }]);
    expect(await adminQuery("SELECT 1 FROM supahound.project_subscriptions WHERE tenant_id = $1 AND project_id = $2", [tenant, project])).toHaveLength(1);
  });
});
