import { runDataJob } from "@supahound/core/datacontrols/flow";
import { tenantId } from "@supahound/core/tenancy/scope";
import { expect, test, type Page } from "@playwright/test";
import pg from "pg";
import { addViewer, adminQuery, managementCalls, pollAttack, seedConnection, setSupabaseProjects, userIdFor } from "../support/seed";
import { createPaidWorkspace, settled, signIn, tenantFromUrl, uniqueEmail } from "../support/session";

// UAT for the project picker (issue #9): connect → pick → watched, members, removal, Supabase errors.
// The Worker calls a fake Management API (support/fakeManagement.ts); Postgres and RLS are real.

const SHOP = "shopshopshopshopshop";
const BLOG = "blogblogblogblogblog";
const OLD = "oldoldoldoldoldoldol";
const FORGED = "forgedforgedforgedfo";

async function ownerWithConnection(page: Page, tag: string, projects = [
  { ref: SHOP, name: "Shop" }, { ref: BLOG, name: "Blog" }, { ref: OLD, name: "Old", status: "INACTIVE" },
]) {
  const email = uniqueEmail(tag);
  await signIn(page, email);
  await page.getByLabel("Workspace name").fill(`${tag} Co`);
  await createPaidWorkspace(page);
  const tenant = tenantFromUrl(page);
  const token = `e2e-${tag}-${tenant}`;
  await setSupabaseProjects(token, projects);
  await seedConnection(tenant, token);
  return { tenant, token, email };
}

const watchedRefs = async (tenant: string) =>
  (await adminQuery<{ supabase_ref: string }>("SELECT supabase_ref FROM supahound.projects WHERE tenant_id = $1 ORDER BY 1", [tenant]))
    .map((r) => r.supabase_ref);

test.describe("UAT: choose the projects Supahound watches", () => {
  test("UAT-W11 the owner picks a project and sees it waiting for its first poll", async ({ page }) => {
    const { tenant } = await ownerWithConnection(page, "w11");
    await page.reload();
    await settled(page);
    await page.getByRole("link", { name: "Choose projects" }).click();
    await expect(page.getByRole("heading", { name: "Projects", exact: true })).toBeVisible();

    await expect(page.getByLabel(/Old/)).toBeDisabled();
    await expect(page.getByText("(inactive; cannot be watched)")).toBeVisible();
    await page.getByLabel(/Shop/).check();
    await page.getByRole("button", { name: "Watch selected projects" }).click();
    await expect(page.getByRole("status")).toHaveText(/Watching 1 new project/);
    await expect(page.getByRole("list", { name: "Watched projects" })).toContainText("Shop");
    expect(await watchedRefs(tenant)).toEqual([SHOP]);

    await page.getByRole("navigation", { name: "Main" }).getByRole("link", { name: "Overview" }).click();
    await expect(page.getByRole("listitem").filter({ hasText: "Shop" })).toContainText("waiting for first poll");
    await expect(page.getByRole("heading", { name: "Finish setup" })).toBeVisible(); // plan and alerts remain
    await expect(page.getByRole("link", { name: "Choose projects" })).toHaveCount(0);
  });

  test("UAT-W12 a forged pick adds only running projects Supabase lists, each once", async ({ page }) => {
    const { tenant } = await ownerWithConnection(page, "w12");
    await page.goto(`/w/${tenant}/projects`);
    await page.getByLabel(/Blog/).check();
    // Add refs the page never offered: a project outside the connection and an inactive one.
    await page.locator("form", { has: page.getByRole("button", { name: "Watch selected projects" }) }).evaluate((form, refs) => {
      for (const ref of refs) {
        const input = document.createElement("input");
        Object.assign(input, { type: "checkbox", name: "ref", value: ref, checked: true });
        form.appendChild(input);
      }
    }, [FORGED, OLD, BLOG]);
    await page.getByRole("button", { name: "Watch selected projects" }).click();
    await expect(page.getByRole("status")).toHaveText(/Watching 1 new project/);
    expect(await watchedRefs(tenant)).toEqual([BLOG]);
    const names = await adminQuery<{ name: string }>("SELECT name FROM supahound.projects WHERE tenant_id = $1", [tenant]);
    expect(names).toEqual([{ name: "Blog" }]);
  });

  test("UAT-W13 a member sees watched projects but cannot pick, remove, or trigger Supabase calls", async ({ page, browser }) => {
    const { tenant, token } = await ownerWithConnection(page, "w13");
    await page.goto(`/w/${tenant}/projects`);
    const ownerForm = await page.locator("form", { has: page.getByRole("button", { name: "Watch selected projects" }) }).evaluate((f) => f.outerHTML);
    await page.getByLabel(/Shop/).check();
    await page.getByRole("button", { name: "Watch selected projects" }).click();
    await expect(page.getByRole("status")).toHaveText(/Watching 1 new project/);
    const shopId = (await adminQuery<{ id: string }>("SELECT id FROM supahound.projects WHERE tenant_id = $1", [tenant]))[0]!.id;

    const member = await browser.newPage();
    const memberEmail = uniqueEmail("w13-member");
    await signIn(member, memberEmail);
    await addViewer(tenant, await userIdFor(memberEmail));
    const callsBefore = await managementCalls(token);

    await member.goto(`/w/${tenant}/projects?remove=${shopId}`);
    await expect(member.getByRole("list", { name: "Watched projects" })).toContainText("Shop");
    await expect(member.getByText("Only workspace owners and admins can choose projects.")).toBeVisible();
    await expect(member.getByRole("checkbox")).toHaveCount(0);
    await expect(member.getByRole("link", { name: /Remove/ })).toHaveCount(0);
    await expect(member.getByRole("button", { name: "Remove project" })).toHaveCount(0);
    expect(await managementCalls(token)).toBe(callsBefore);

    // Replay the owner's form (same server action) from the member's session.
    await member.evaluate((html) => {
      document.body.insertAdjacentHTML("beforeend", html);
      const form = document.body.lastElementChild as HTMLFormElement;
      for (const box of form.querySelectorAll<HTMLInputElement>("input[name=ref]")) box.checked = true;
      form.requestSubmit();
    }, ownerForm);
    await expect(member).toHaveURL(/error=role/);
    await expect(member.getByRole("status")).toHaveText(/Only workspace owners and admins/);
    expect(await watchedRefs(tenant)).toEqual([SHOP]);
    expect(await managementCalls(token)).toBe(callsBefore);
    await member.close();
  });

  test("UAT-W14 removing a project needs its name, schedules its deletion 7 days after it stops, then deletes its incidents and keeps its audit log", async ({ page }) => {
    const { tenant } = await ownerWithConnection(page, "w14");
    await pollAttack(tenant, "Client app");
    const id = (await adminQuery<{ id: string }>("SELECT id FROM supahound.projects WHERE tenant_id = $1", [tenant]))[0]!.id;
    const audit = async () =>
      (await adminQuery<{ n: number }>("SELECT count(*)::int AS n FROM supahound.audit_log WHERE tenant_id = $1", [tenant]))[0]!.n;
    const auditBefore = await audit();
    expect(auditBefore).toBeGreaterThan(0);

    await page.goto(`/w/${tenant}/projects`);
    await settled(page);
    await page.getByRole("link", { name: "Remove Client app" }).click();
    // If this fails again: a URL without ?remove= means the click was lost; with it, the render was slow.
    await expect(page).toHaveURL(new RegExp(`/w/${tenant}/projects\\?remove=${id}$`));
    await expect(page.getByRole("heading", { name: "Remove Client app?" })).toBeVisible();
    await expect(page.getByText(/permanently deletes its incidents, findings and poll history/)).toBeVisible();
    // Billing is on but this workspace has no project subscription row: the project stops now.
    await expect(page.getByTestId("removal-preview")).toHaveText(/^Supahound stops watching the project now\. It is deleted on \d{4}-\d{2}-\d{2} unless you keep it\.$/);

    await page.getByLabel(/to confirm/).fill("client app");
    await page.getByRole("button", { name: "Remove project" }).click();
    await expect(page.getByRole("status")).toHaveText(/did not match/);
    expect(await adminQuery("SELECT 1 FROM supahound.projects WHERE id = $1", [id])).toHaveLength(1);

    await page.getByLabel(/to confirm/).fill("Client app");
    await page.getByRole("button", { name: "Remove project" }).click();
    await expect(page.getByRole("status")).toHaveText(/Removal scheduled/);
    await expect(page.getByTestId("removal-scheduled")).toContainText(/It is deleted on \d{4}-\d{2}-\d{2} unless you keep it\./);
    // Nothing is deleted yet (decision 042).
    const [row] = await adminQuery<{ delete_after: Date }>("SELECT delete_after FROM supahound.projects WHERE id = $1", [id]);
    expect(await adminQuery("SELECT 1 FROM supahound.incidents WHERE project_id = $1", [id])).not.toHaveLength(0);

    const app = new pg.Pool({ connectionString: process.env.E2E_APP_DB_URL, max: 1 });
    try {
      expect(await runDataJob(app, tenantId(tenant), new Date(row!.delete_after.getTime() - 1))).toMatchObject({ projectsDeleted: 0 });
      expect(await runDataJob(app, tenantId(tenant), row!.delete_after)).toMatchObject({ projectsDeleted: 1 });
    } finally {
      await app.end();
    }
    expect(await adminQuery("SELECT 1 FROM supahound.projects WHERE id = $1", [id])).toHaveLength(0);
    expect(await adminQuery("SELECT 1 FROM supahound.incidents WHERE project_id = $1", [id])).toHaveLength(0);
    expect(await audit()).toBe(auditBefore);
    const orphaned = await adminQuery("SELECT 1 FROM supahound.audit_log WHERE tenant_id = $1 AND project_id IS NULL", [tenant]);
    expect(orphaned.length).toBe(auditBefore);
  });

  test("UAT-W15 a revoked Supabase grant asks for a reconnect instead of failing", async ({ page }) => {
    const { tenant, token } = await ownerWithConnection(page, "w15");
    await setSupabaseProjects(token, [], 401);
    const res = await page.goto(`/w/${tenant}/projects`);
    expect(res?.status()).toBe(200);
    await expect(page.getByRole("alert")).toHaveText(/Reconnect Supabase/);
    await expect(page.getByRole("checkbox")).toHaveCount(0);
  });
});
