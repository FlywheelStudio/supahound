import { expect, test } from "@playwright/test";
import { addViewer, adminQuery, pollPickedProject, userIdFor } from "../support/seed";
import { createPaidWorkspace, settled, signIn, tenantFromUrl, uniqueEmail } from "../support/session";

// UAT for expected networks (issue #185, decision 050): an owner marks the network of a
// service-role incident as expected, sees it on the Notifications page and removes it; a viewer
// gets no button, and the owner's form replayed by the viewer is refused by the server.

const NETWORK = "example telecom ag";

async function seedServiceRoleIncident(tenant: string, project: string): Promise<string> {
  const [incident] = await adminQuery<{ id: string }>(
    `INSERT INTO supahound.incidents (tenant_id, project_id, actor, status, severity, detectors, signals, finding_count, hits, opened_at, last_seen_at)
     VALUES ($1, $2, 'service_role:net:0123456789ab', 'open', 'high', '{service_role_misuse}', '{non_hosting_network}', 1, 3,
             now() - interval '6 minutes', now() - interval '4 minutes')
     RETURNING id`,
    [tenant, project],
  );
  const [run] = await adminQuery<{ id: string }>(
    `INSERT INTO supahound.poll_runs (tenant_id, project_id, window_start, window_end, status)
     VALUES ($1, $2, now() - interval '10 minutes', now() - interval '5 minutes', 'ok') RETURNING id`,
    [tenant, project],
  );
  await adminQuery(
    `INSERT INTO supahound.findings (tenant_id, project_id, poll_run_id, incident_id, detector, severity, actor, signals, evidence, hits, first_seen, last_seen)
     VALUES ($1, $2, $3, $4, 'service_role_misuse', 'high', 'service_role:net:0123456789ab', '{non_hosting_network}',
             jsonb_build_object('callerClass', 'server', 'networkType', 'other', 'asn', null, 'network', $5::text, 'expectedNetwork', false),
             3, now() - interval '6 minutes', now() - interval '4 minutes')`,
    [tenant, project, run!.id, incident!.id, NETWORK],
  );
  return incident!.id;
}

test.describe("UAT: expected networks", () => {
  test("UAT-W55 an owner marks a service-role incident's network as expected; a viewer cannot; remove restores", async ({ page, browser }) => {
    await signIn(page, uniqueEmail("w55"));
    await page.getByLabel("Workspace name").fill("w55 Co");
    await createPaidWorkspace(page);
    const tenant = tenantFromUrl(page);
    await pollPickedProject(tenant, "Api", []);
    const [{ id: project }] = await adminQuery<{ id: string }>("SELECT id FROM supahound.projects WHERE tenant_id = $1", [tenant]) as [{ id: string }];
    const incident = await seedServiceRoleIncident(tenant, project);
    const incidentUrl = `/w/${tenant}/p/${project}/incidents/${incident}`;
    const settingsUrl = `/w/${tenant}/p/${project}/settings/notifications`;

    await page.goto(incidentUrl);
    await expect(page.getByRole("region", { name: "Incident facts" })).toContainText(NETWORK);
    const mark = page.getByRole("button", { name: `Mark ${NETWORK} as expected` });
    await expect(mark).toBeVisible();
    const ownerForm = await page.locator("form", { has: mark }).evaluate((f) => f.outerHTML);

    await settled(page);
    await mark.click();
    await expect(page).toHaveURL(`${settingsUrl}?expected=marked#expected-networks`);
    await expect(page.getByRole("status")).toHaveText(/Marked as expected/);
    await expect(page.getByRole("list", { name: "Networks marked as expected" })).toContainText(NETWORK);
    expect(await adminQuery("SELECT network FROM supahound.expected_networks WHERE tenant_id = $1", [tenant])).toEqual([{ network: NETWORK }]);
    const audit = await adminQuery<{ detail: Record<string, unknown> }>(
      "SELECT detail FROM supahound.audit_log WHERE tenant_id = $1 AND action = 'detection_setting'", [tenant]);
    expect(audit.map((a) => a.detail)).toMatchObject([{ setting: "expected_network", change: "mark", network: NETWORK }]);

    // Marked: the incident page no longer offers it.
    await page.goto(incidentUrl);
    await expect(page.getByRole("button", { name: /as expected/ })).toHaveCount(0);

    // A viewer: no buttons on either page, and the owner's form replayed is refused.
    await adminQuery("DELETE FROM supahound.expected_networks WHERE tenant_id = $1", [tenant]);
    const member = await browser.newPage();
    const memberEmail = uniqueEmail("w55-viewer");
    await signIn(member, memberEmail);
    await addViewer(tenant, await userIdFor(memberEmail));
    await member.goto(incidentUrl);
    await expect(member.getByRole("region", { name: "Incident facts" })).toContainText(NETWORK);
    await expect(member.getByRole("button", { name: /as expected/ })).toHaveCount(0);
    await member.goto(settingsUrl);
    await expect(member.getByText("Only the project's owners and admins can mark or remove a network.")).toBeVisible();
    await settled(member);
    await member.evaluate((html) => {
      document.body.insertAdjacentHTML("beforeend", html);
      (document.body.lastElementChild as HTMLFormElement).requestSubmit();
    }, ownerForm);
    await expect(member).toHaveURL(/expected=role/);
    await expect(member.getByRole("status")).toHaveText(/Only the project's owners and admins/);
    expect(await adminQuery("SELECT network FROM supahound.expected_networks WHERE tenant_id = $1", [tenant])).toEqual([]);
    await member.close();

    // The owner marks again, then removes it on the Notifications page.
    await page.goto(incidentUrl);
    await settled(page);
    await page.getByRole("button", { name: `Mark ${NETWORK} as expected` }).click();
    await expect(page).toHaveURL(`${settingsUrl}?expected=marked#expected-networks`);
    await settled(page);
    await page.getByRole("button", { name: `Remove ${NETWORK}` }).click();
    await expect(page).toHaveURL(`${settingsUrl}?expected=unmarked#expected-networks`);
    await expect(page.getByRole("main")).toContainText("No network is marked as expected.");
    expect(await adminQuery("SELECT network FROM supahound.expected_networks WHERE tenant_id = $1", [tenant])).toEqual([]);
  });
});
