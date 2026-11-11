import { expect, test } from "@playwright/test";
import { adminQuery, seedConnection, setSupabaseProjects, userIdFor } from "../support/seed";
import { createPaidWorkspace, settled, signIn, tenantFromUrl, uniqueEmail } from "../support/session";

// UAT for incident alert email settings (issue #16, decision 030). The poller's sending is covered
// by the Postgres suite (packages/core/test/db/alerts.test.ts); this covers what a person does.

const SHOP = "shopshopshopshopshop";

test.describe("UAT: incident alert email", () => {
  test("UAT-W17 the owner's address is on file, every incident emails by default, and the owner can raise the threshold", async ({ page }) => {
    const email = uniqueEmail("w17");
    await signIn(page, email);
    await page.getByLabel("Workspace name").fill("w17 Co");
    await createPaidWorkspace(page);
    const tenant = tenantFromUrl(page);
    const token = `e2e-w17-${tenant}`;
    await setSupabaseProjects(token, [{ ref: SHOP, name: "Shop" }]);
    await seedConnection(tenant, token);

    const onFile = await adminQuery<{ email: string }>("SELECT email FROM supahound.memberships WHERE tenant_id = $1", [tenant]);
    expect(onFile.map((r) => r.email)).toEqual([email]);

    await page.goto(`/w/${tenant}/projects`);
    await page.getByLabel(/Shop/).check();
    await page.getByRole("button", { name: "Watch selected projects" }).click();
    await expect(page.getByRole("status")).toHaveText(/Watching 1 new project/);
    await settled(page);

    const select = page.getByLabel("Email alerts for Shop");
    await expect(select).toHaveValue("low");
    await select.selectOption("high");
    await page.getByRole("button", { name: "Save" }).click();
    await expect(page.getByRole("status")).toHaveText("Email alerts saved: High and above.");
    await expect(page.getByLabel("Email alerts for Shop")).toHaveValue("high");
    const level = await adminQuery<{ email_alerts: string }>("SELECT email_alerts FROM supahound.projects WHERE tenant_id = $1", [tenant]);
    expect(level).toEqual([{ email_alerts: "high" }]);
  });

  test("UAT-W18 a member sees the threshold but cannot change it, even by replaying the owner's form", async ({ page, browser }) => {
    const email = uniqueEmail("w18");
    await signIn(page, email);
    await page.getByLabel("Workspace name").fill("w18 Co");
    await createPaidWorkspace(page);
    const tenant = tenantFromUrl(page);
    const token = `e2e-w18-${tenant}`;
    await setSupabaseProjects(token, [{ ref: SHOP, name: "Shop" }]);
    await seedConnection(tenant, token);
    await page.goto(`/w/${tenant}/projects`);
    await page.getByLabel(/Shop/).check();
    await page.getByRole("button", { name: "Watch selected projects" }).click();
    await expect(page.getByRole("status")).toHaveText(/Watching 1 new project/);
    // Capture the form from a server render: a client-rendered React form has no no-JS fallback.
    await page.goto(`/w/${tenant}/projects`);
    const ownerForm = await page.locator("form", { has: page.getByLabel("Email alerts for Shop") }).evaluate((f) => f.outerHTML);

    const member = await browser.newPage();
    const memberEmail = uniqueEmail("w18-member");
    await signIn(member, memberEmail);
    await adminQuery("INSERT INTO supahound.memberships (tenant_id, user_id, role) VALUES ($1, $2, 'member')", [tenant, await userIdFor(memberEmail)]);
    await member.goto(`/w/${tenant}/projects`);
    await expect(member.getByText("Email alerts: Every incident")).toBeVisible();
    await expect(member.getByLabel("Email alerts for Shop")).toHaveCount(0);

    // Visiting the workspace records the member's own address for alerts.
    await member.goto(`/w/${tenant}`);
    await settled(member);
    const addresses = await adminQuery<{ email: string }>("SELECT email FROM supahound.memberships WHERE tenant_id = $1 ORDER BY role", [tenant]);
    expect(addresses.map((r) => r.email).sort()).toEqual([email, memberEmail].sort());

    await member.goto(`/w/${tenant}/projects`);
    await expect(member.getByText("Email alerts: Every incident")).toBeVisible();
    await settled(member);
    await member.evaluate((html) => {
      document.body.insertAdjacentHTML("beforeend", html);
      const form = document.body.lastElementChild as HTMLFormElement;
      form.querySelector<HTMLInputElement>("select[name=level]")!.value = "off";
      form.requestSubmit();
    }, ownerForm);
    await expect(member).toHaveURL(/error=alerts_role/);
    await expect(member.getByRole("status")).toHaveText(/Only workspace owners and admins can change email alerts/);
    const level = await adminQuery<{ email_alerts: string }>("SELECT email_alerts FROM supahound.projects WHERE tenant_id = $1", [tenant]);
    expect(level).toEqual([{ email_alerts: "low" }]);
    await member.close();
  });
});
