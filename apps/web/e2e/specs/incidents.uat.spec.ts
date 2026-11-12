import { expect, test, type Page } from "@playwright/test";
import { adminQuery, ALICE, BOB, pollAttack, pollPickedProject, sha256Hex } from "../support/seed";
import { createPaidWorkspace, settled, signIn, tenantFromUrl, uniqueEmail } from "../support/session";

// UAT for incident history (issue #44, decision 035): the 30-day list with keyset pages, the
// incident detail, and a 404 for every incident the URL may not show.

const ID = "[0-9a-f-]{36}";

async function workspaceWith(page: Page, tag: string) {
  await signIn(page, uniqueEmail(tag));
  await page.getByLabel("Workspace name").fill(`${tag} Co`);
  await createPaidWorkspace(page);
  const tenant = tenantFromUrl(page);
  // "Api" gets one real incident from the poller (template summary); "Blog" stays quiet.
  await pollAttack(tenant, "Api");
  await pollPickedProject(tenant, "Blog", []);
  const ids = Object.fromEntries(
    (await adminQuery<{ id: string; name: string }>("SELECT id, name FROM supahound.projects WHERE tenant_id = $1", [tenant])).map((r) => [r.name, r.id]),
  );
  return { tenant, ids };
}

// Resolved incidents seen 1..n hours ago, with no summary (the explainer skipped them).
async function seedResolved(tenant: string, project: string, n: number) {
  await adminQuery(
    `INSERT INTO supahound.incidents (tenant_id, project_id, actor, status, severity, detectors, signals, finding_count, hits, opened_at, last_seen_at)
     SELECT $1, $2, 'user:seeded-' || g, 'resolved', 'medium', '{service_role_misuse}', '{browser_caller}', 2, 10 + g,
            now() - g * interval '1 hour' - interval '7 minutes', now() - g * interval '1 hour'
     FROM generate_series(1, $3::int) AS g`,
    [tenant, project, n],
  );
}

async function seedOne(tenant: string, project: string, status: "open" | "resolved", age: string): Promise<string> {
  const rows = await adminQuery<{ id: string }>(
    `INSERT INTO supahound.incidents (tenant_id, project_id, actor, status, severity, detectors, signals, finding_count, hits, opened_at, last_seen_at)
     VALUES ($1, $2, 'user:' || gen_random_uuid(), $3, 'low', '{cross_tenant}', '{range}', 1, 4, now() - $4::interval, now() - $4::interval)
     RETURNING id`,
    [tenant, project, status, age],
  );
  return rows[0]!.id;
}

const history = (page: Page) => page.getByRole("list", { name: "Incident history" });
const hrefs = async (page: Page) => history(page).getByRole("link").evaluateAll((as) => as.map((a) => a.getAttribute("href")!));

test.describe("UAT: incident history", () => {
  test("UAT-W23 the incident list shows 30 days of open and resolved incidents, newest first, in pages", async ({ page }) => {
    const { tenant, ids } = await workspaceWith(page, "w23");
    await seedResolved(tenant, ids.Api!, 26);
    const staleOpen = await seedOne(tenant, ids.Api!, "open", "40 days");
    const tooOld = await seedOne(tenant, ids.Api!, "resolved", "31 days");

    await page.goto(`/w/${tenant}/p/${ids.Api}/incidents`);
    await expect(page.getByRole("heading", { name: "Incidents" })).toBeVisible();
    await expect(history(page).getByRole("listitem")).toHaveCount(25);
    // Newest first: the poller's incident (4 minutes ago), then the seeded ones by hour.
    const first = history(page).getByRole("listitem").first();
    await expect(first).toContainText("critical");
    await expect(first).toContainText("Open");
    await expect(first).toContainText("Cross-tenant data access");
    await expect(history(page).getByRole("listitem").nth(1)).toContainText("11 requests");
    await expect(history(page).getByRole("listitem").nth(1)).toContainText("Resolved");
    await expect(history(page).getByRole("listitem").nth(24)).toContainText("34 requests");
    const page1 = await hrefs(page);

    await settled(page);
    await page.getByRole("link", { name: "Older incidents" }).click();
    await expect(page).toHaveURL(new RegExp(`/incidents\\?before=\\d+_${ID}$`));
    // 26 seeded + the poller's + the stale open one = 28; the 31-day-old resolved one is gone.
    await expect(history(page).getByRole("listitem")).toHaveCount(3);
    await expect(history(page).getByRole("listitem").last()).toContainText("Open");
    await expect(page.getByRole("link", { name: "Older incidents" })).toHaveCount(0);
    const page2 = await hrefs(page);
    const all = [...page1, ...page2];
    expect(new Set(all).size).toBe(28);
    expect(all).toContain(`/w/${tenant}/p/${ids.Api}/incidents/${staleOpen}`);
    expect(all).not.toContain(`/w/${tenant}/p/${ids.Api}/incidents/${tooOld}`);

    await settled(page);
    await page.getByRole("link", { name: "Newest" }).click();
    await expect(page).toHaveURL(`/w/${tenant}/p/${ids.Api}/incidents`);

    // The quiet project has its own, empty history.
    await page.goto(`/w/${tenant}/p/${ids.Blog}/incidents`);
    await expect(page.getByRole("main")).toContainText("No incidents in the last 30 days.");
  });

  test("UAT-W24 the incident detail shows the actor alias, signals, counts, time range, summary and fix", async ({ page }) => {
    const { tenant, ids } = await workspaceWith(page, "w24");
    await seedResolved(tenant, ids.Api!, 1);

    // From the project dashboard to the incident.
    await page.goto(`/w/${tenant}/p/${ids.Api}`);
    await settled(page);
    await page.getByRole("main").getByRole("link", { name: /critical/ }).click();
    await expect(page).toHaveURL(new RegExp(`/w/${tenant}/p/${ids.Api}/incidents/${ID}$`));
    await expect(page.getByRole("heading", { name: "Cross-tenant data access" })).toBeVisible();
    await expect(page.getByRole("navigation", { name: "Main" }).getByRole("link", { name: "Incidents" })).toHaveAttribute("aria-current", "page");

    const facts = page.getByRole("region", { name: "Incident facts" });
    await expect(facts).toContainText(`ActorUser ${sha256Hex(`user:${ALICE}`).slice(0, 8)}`);
    await expect(facts).toContainText("Requests37");
    await expect(facts).toContainText("Findings1");
    await expect(facts).toContainText(/First seen\d{4}-\d{2}-\d{2} \d{2}:\d{2} UTC/);
    await expect(facts).toContainText("Durationunder a minute");
    await expect(page.getByRole("region", { name: "Signals" })).toContainText("Filtered on another user's ID");
    await expect(page.getByRole("region", { name: "Summary" })).toContainText("A signed-in user requested rows owned by 1 other user(s) in notes");
    const fix = page.getByRole("region", { name: "Suggested fix" });
    await expect(fix).toContainText("Check the RLS policy on notes compares user_id to auth.uid().");
    await expect(fix.locator("code")).toContainText(["notes", "user_id", "auth.uid()"]);

    // No raw user IDs or user agents reach the page.
    const html = await page.content();
    for (const banned of [ALICE, BOB, "python-httpx"]) expect(html).not.toContain(banned);

    // An incident with no stored summary still shows its facts and a summary from the counts.
    await page.goto(`/w/${tenant}/p/${ids.Api}/incidents`);
    await settled(page);
    await history(page).getByRole("link", { name: /Resolved/ }).click();
    await expect(page.getByRole("heading", { name: "Service-role key misuse" })).toBeVisible();
    await expect(page.getByRole("region", { name: "Summary" })).toContainText("11 requests in 2 findings.");
    await expect(page.getByRole("region", { name: "Incident facts" })).toContainText("Duration7 minutes");
    await expect(page.getByRole("region", { name: "Suggested fix" })).toHaveCount(0);
  });

  test("UAT-W25 another workspace's, another project's, an old, a made-up or a malformed incident is a 404", async ({ page, browser }) => {
    const a = await workspaceWith(page, "w25-a");
    const other = await browser.newPage();
    const b = await workspaceWith(other, "w25-b");
    const [aIncident] = await adminQuery<{ id: string }>("SELECT id FROM supahound.incidents WHERE project_id = $1", [a.ids.Api]);
    const [bIncident] = await adminQuery<{ id: string }>("SELECT id FROM supahound.incidents WHERE project_id = $1", [b.ids.Api]);
    const tooOld = await seedOne(a.tenant, a.ids.Api!, "resolved", "31 days");
    const aApi = `/w/${a.tenant}/p/${a.ids.Api}/incidents`;

    // A's own incident opens.
    expect((await page.goto(`${aApi}/${aIncident!.id}`))?.status()).toBe(200);

    for (const path of [
      `${aApi}/${bIncident!.id}`, // B's incident under A's project
      `/w/${a.tenant}/p/${a.ids.Blog}/incidents/${aIncident!.id}`, // A's incident under A's other project
      `/w/${a.tenant}/p/${b.ids.Api}/incidents/${bIncident!.id}`, // B's project under A's workspace
      `${aApi}/${tooOld}`, // resolved and older than 30 days
      `${aApi}/00000000-0000-4000-8000-000000000000`,
      `${aApi}/not-a-uuid`,
      `${aApi}?before=garbage`,
    ]) {
      const res = await page.goto(path);
      expect(res?.status(), path).toBe(404);
    }

    // B, signed in, opens A's incident URL: a 404, and none of A's names.
    const res = await other.goto(`${aApi}/${aIncident!.id}`);
    expect(res?.status()).toBe(404);
    await expect(other.getByText("w25-a Co")).toHaveCount(0);
    await other.close();
  });
});
