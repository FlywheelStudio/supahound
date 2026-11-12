import { expect, test, type Page } from "@playwright/test";
import { addViewer, adminQuery, pollAttack, pollPickedProject, userIdFor } from "../support/seed";
import { createPaidWorkspace, settled, signIn, tenantFromUrl, uniqueEmail } from "../support/session";

// UAT for project navigation (issue #98, decision 031): the project dropdown, the project pages and
// their settings. The URL holds the project, so these specs also check that a project ID from
// another workspace is a 404, never that workspace's data.

const ID = "[0-9a-f-]{36}";

async function workspaceWith(page: Page, tag: string, projects: string[]) {
  const email = uniqueEmail(tag);
  await signIn(page, email);
  await page.getByLabel("Workspace name").fill(`${tag} Co`);
  await createPaidWorkspace(page);
  const tenant = tenantFromUrl(page);
  for (const name of projects) await pollPickedProject(tenant, name, []);
  const ids = Object.fromEntries(
    (await adminQuery<{ id: string; name: string }>("SELECT id, name FROM supahound.projects WHERE tenant_id = $1", [tenant])).map((r) => [r.name, r.id]),
  );
  return { tenant, email, ids };
}

const nav = (page: Page) => page.getByRole("navigation", { name: "Main" });

async function switchTo(page: Page, name: string) {
  await page.getByLabel(/Switch project/).click();
  // The link's name also carries the plan badge ("Shop Starter").
  await page.getByRole("list", { name: "Projects" }).getByRole("link", { name: new RegExp(`^${name}\\b`) }).click();
}

test.describe("UAT: project navigation", () => {
  test("UAT-W19 the owner opens a project from the overview and switches projects from the dropdown", async ({ page }) => {
    const { tenant, ids } = await workspaceWith(page, "w19", ["Blog", "Shop"]);
    await pollAttack(tenant, "Api");
    await page.reload();
    await settled(page);

    await page.getByRole("main").getByRole("link", { name: "Api", exact: true }).first().click();
    await expect(page).toHaveURL(new RegExp(`/w/${tenant}/p/${ID}$`));
    await expect(page.getByRole("heading", { name: "Api", exact: true })).toBeVisible();
    await expect(page.getByRole("region", { name: "Project status" })).toContainText("Open incidents1");
    await expect(page.getByRole("main").getByRole("listitem").first()).toContainText(/critical|high|medium|low/);
    await expect(nav(page).getByRole("link", { name: "Dashboard" })).toHaveAttribute("aria-current", "page");

    await settled(page);
    await switchTo(page, "Shop");
    await expect(page).toHaveURL(`/w/${tenant}/p/${ids.Shop}`);
    await expect(page.getByRole("heading", { name: "Shop", exact: true })).toBeVisible();
    await expect(page.getByRole("main")).toContainText("No open incidents.");
    // The menu closed after the switch.
    await expect(page.getByRole("list", { name: "Projects" })).toBeHidden();

    await settled(page);
    await nav(page).getByRole("link", { name: "Incidents" }).click();
    await expect(page).toHaveURL(`/w/${tenant}/p/${ids.Shop}/incidents`);
    await expect(page.getByRole("heading", { name: "Incidents" })).toBeVisible();

    // Switching keeps nothing from the old project: the dropdown goes to the new project's dashboard.
    await settled(page);
    await switchTo(page, "Blog");
    await expect(page).toHaveURL(`/w/${tenant}/p/${ids.Blog}`);

    await settled(page);
    await page.getByLabel(/Switch project/).click();
    await page.getByRole("link", { name: "All projects" }).click();
    await expect(page).toHaveURL(`/w/${tenant}`);
    await expect(page.getByRole("heading", { name: "Overview" })).toBeVisible();
  });

  test("UAT-W20 project settings: general, notifications with SMS coming soon, plan, people", async ({ page }) => {
    const { tenant, ids } = await workspaceWith(page, "w20", ["Shop"]);
    const base = `/w/${tenant}/p/${ids.Shop}`;

    await page.goto(`${base}/settings`);
    await expect(page.getByRole("heading", { name: "General" })).toBeVisible();
    await expect(page.getByRole("main")).toContainText("Shop");
    await settled(page);
    await page.getByRole("link", { name: "Remove Shop…" }).click();
    await expect(page).toHaveURL(`/w/${tenant}/projects?remove=${ids.Shop}`);
    await expect(page.getByRole("heading", { name: "Remove Shop?" })).toBeVisible();

    await page.goto(`${base}/settings/notifications`);
    await expect(page.getByLabel("Email alerts for Shop")).toHaveValue("low");
    await expect(page.getByLabel("Phone number")).toBeDisabled();
    await expect(page.getByRole("main")).toContainText("SMSComing soon");

    await page.goto(`${base}/settings/plan`);
    await expect(page.getByRole("region", { name: "Current plan" })).toContainText("Starter $19.99 per month");
    await expect(page.getByRole("link", { name: "workspace billing" })).toHaveAttribute("href", `/w/${tenant}/billing`);

    // People shipped with issue #24 (people.uat.spec.ts covers it in full).
    await page.goto(`${base}/settings/people`);
    await expect(page.getByRole("heading", { name: "People", exact: true })).toBeVisible();
    await expect(page.getByRole("button", { name: "Send invite" })).toBeVisible();
    await expect(nav(page).getByRole("link", { name: "People" })).not.toContainText("Soon");

    await page.goto(`${base}/findings`);
    await expect(page.getByRole("main")).toContainText("Security scan findingsComing soon");
    await expect(nav(page).getByRole("link", { name: "Security scan" })).toContainText("Soon");
  });

  test("UAT-W21 a project ID from another workspace is a 404, and so is a made-up one", async ({ page, browser }) => {
    const a = await workspaceWith(page, "w21-a", ["Alpha secret"]);
    const other = await browser.newPage();
    const b = await workspaceWith(other, "w21-b", ["Bravo secret"]);

    // B's project under A's workspace, B's project under B's workspace, and a valid-looking ID.
    for (const path of [
      `/w/${a.tenant}/p/${b.ids["Bravo secret"]}`,
      `/w/${b.tenant}/p/${b.ids["Bravo secret"]}/settings/notifications`,
      `/w/${a.tenant}/p/00000000-0000-4000-8000-000000000000`,
      `/w/${a.tenant}/p/not-a-uuid/settings`,
    ]) {
      const res = await page.goto(path);
      expect(res?.status(), path).toBe(404);
      await expect(page.getByText("Bravo secret")).toHaveCount(0);
    }
    // A's own project still opens, and its dropdown lists only A's projects.
    await page.goto(`/w/${a.tenant}/p/${a.ids["Alpha secret"]}`);
    await page.getByLabel(/Switch project/).click();
    await expect(page.getByRole("list", { name: "Projects" }).getByRole("link")).toContainText(["All projects", "Alpha secret"]);
    await other.close();
  });

  test("UAT-W22 a viewer can open every page but gets no Add project, no Remove and no alert form", async ({ page, browser }) => {
    const { tenant, ids } = await workspaceWith(page, "w22", ["Shop"]);
    const member = await browser.newPage();
    const memberEmail = uniqueEmail("w22-member");
    await signIn(member, memberEmail);
    await addViewer(tenant, await userIdFor(memberEmail));

    const base = `/w/${tenant}/p/${ids.Shop}`;
    await member.goto(base);
    await member.getByLabel(/Switch project/).click();
    await expect(member.getByRole("link", { name: "+ Add project" })).toHaveCount(0);
    await member.goto(`${base}/settings`);
    await expect(member.getByRole("heading", { name: "Remove project" })).toHaveCount(0);
    await member.goto(`${base}/settings/notifications`);
    await expect(member.getByLabel("Email alerts for Shop")).toHaveCount(0);
    await expect(member.getByRole("main")).toContainText("Only the project's owners, admins and editors can change this.");
    await member.close();

    // The owner gets all three.
    await page.goto(base);
    await page.getByLabel(/Switch project/).click();
    await expect(page.getByRole("link", { name: "+ Add project" })).toBeVisible();
  });
});
