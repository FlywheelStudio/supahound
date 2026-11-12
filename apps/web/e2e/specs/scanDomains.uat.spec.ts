import { expect, test, type Page } from "@playwright/test";
import { addViewer, adminQuery, pollPickedProject, userIdFor } from "../support/seed";
import { createPaidWorkspace, settled, signIn, tenantFromUrl, uniqueEmail } from "../support/session";

// UAT for scan domains per project (issue #100, decisions 034 and 040): an owner attaches a verified
// domain and sees its latest scan on the Security scan tab; a viewer sees it but cannot attach or
// detach; another workspace's project is a 404.

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
  return { tenant, email, ids: ids as Record<string, string> };
}

// Built at runtime, so the repo's secret scan stays clean. It must never reach the page.
const PLANTED = ["sk", "live", `${"Q".repeat(20)}Wxyz`].join("_");

// A domain as the scan funnel stores it, with two finished scans; only the newer one should show.
async function seedScannedDomain(tenant: string, apex: string, verified: boolean): Promise<string> {
  const [d] = await adminQuery<{ id: string }>(
    `INSERT INTO supahound.scan_domains (tenant_id, apex, verification_token, token_expires_at, verified_at)
     VALUES ($1, $2, $3, now() + interval '1 day', CASE WHEN $4 THEN now() END) RETURNING id`,
    [tenant, apex, "c".repeat(32), verified],
  );
  const scan = async (created: string, findings: { severity: string; type: string; evidence: object; fix: string }[]) => {
    const [s] = await adminQuery<{ id: string }>(
      `INSERT INTO supahound.scans (tenant_id, domain_id, mode, status, score, created_at, finished_at)
       VALUES ($1, $2, 'introductory', 'done', 41, $3, $3) RETURNING id`,
      [tenant, d!.id, created],
    );
    for (const f of findings) {
      await adminQuery(
        `INSERT INTO supahound.scan_findings (tenant_id, scan_id, severity, type, endpoint, evidence, fix)
         VALUES ($1, $2, $3, $4, $5, $6, $7)`,
        [tenant, s!.id, f.severity, f.type, `https://${apex}/assets/app.js`, JSON.stringify(f.evidence), f.fix],
      );
    }
  };
  await scan("2026-11-10T08:00:00Z", [{ severity: "medium", type: "stale-finding", evidence: {}, fix: "Old fix." }]);
  await scan("2026-11-11T08:00:00Z", [
    { severity: "low", type: "exposed-file:git-head", evidence: { path: "/.git/HEAD" }, fix: "Block the .git directory." },
    {
      severity: "critical", type: "exposed-secret:stripe-secret-key",
      // "value" is not an allowed evidence key: even if a writer stored a secret, the page drops it.
      evidence: { rule: "stripe-secret-key", name: "Stripe secret key", source: "script", fingerprint: "a1b2c3d4e5f6", last4: "Wxyz", occurrences: 2, value: PLANTED },
      fix: "Revoke and rotate this credential at its provider.",
    },
  ]);
  return d!.id;
}

test.describe("UAT: Security scan domains per project", () => {
  test("UAT-W38 an owner attaches a verified domain and sees its latest scan's findings, with the fix; detaching hides them", async ({ page }) => {
    const { tenant, ids } = await workspaceWith(page, "w34", ["Shop", "Blog"]);
    await seedScannedDomain(tenant, "w34-shop.test", true);
    await seedScannedDomain(tenant, "w34-pending.test", false);
    const tab = `/w/${tenant}/p/${ids.Shop}/findings`;

    // No domain yet: the tab says how to link one.
    await page.goto(tab);
    await expect(page.getByRole("heading", { name: "Security scan", exact: true })).toBeVisible();
    await expect(page.getByRole("region", { name: "No domain linked" })).toContainText("No domain is linked to Shop.");
    await page.getByRole("link", { name: "Settings → General" }).click();
    await expect(page).toHaveURL(new RegExp(`/w/${tenant}/p/${ids.Shop}/settings#scan-domains$`));

    // Only the verified domain is offered.
    const select = page.getByLabel("Verified domain");
    await expect(select.locator("option")).toHaveText(["w34-shop.test"]);
    await settled(page);
    await page.getByRole("button", { name: "Attach domain" }).click();
    await expect(page).toHaveURL(/\?domain=linked#scan-domains$/);
    await expect(page.getByRole("status")).toHaveText("Domain attached. Its latest scan shows on the Security scan tab.");
    await expect(page.getByRole("list", { name: "Attached domains" })).toContainText("w34-shop.test");
    await expect(page.getByText("No verified domain is free to attach.")).toBeVisible();

    // The domain belongs to Shop only: Blog has nothing to attach and nothing on its tab.
    await page.goto(`/w/${tenant}/p/${ids.Blog}/settings`);
    await expect(page.getByLabel("Verified domain")).toHaveCount(0);
    await page.goto(`/w/${tenant}/p/${ids.Blog}/findings`);
    await expect(page.getByRole("main")).toContainText("No domain is linked to Blog.");

    // The tab: the newer scan only, most severe first, each with the fix; never the secret.
    await page.goto(tab);
    const scan = page.getByRole("region", { name: "Scan of w34-shop.test" });
    await expect(scan).toContainText("Last finished scan 2026-11-11 08:00 UTC, score 41/100. 1 critical · 1 low.");
    const items = scan.getByRole("list", { name: "Findings for w34-shop.test" }).getByRole("listitem");
    await expect(items).toHaveCount(2);
    await expect(items.nth(0)).toContainText("criticalStripe secret key");
    await expect(items.nth(0)).toContainText("Ends in:…Wxyz");
    await expect(items.nth(0)).toContainText("Fix: Revoke and rotate this credential at its provider.");
    await expect(items.nth(1)).toContainText("lowexposed-file:git-head");
    await expect(items.nth(1)).toContainText("Path:/.git/HEAD");
    await expect(page.getByRole("main")).not.toContainText("stale-finding");
    expect(await page.content()).not.toContain(PLANTED);
    // The endpoint is text, never a link to the scanned site.
    await expect(scan.getByRole("link")).toHaveCount(0);

    // Detach: the findings leave the project.
    await page.goto(`/w/${tenant}/p/${ids.Shop}/settings`);
    await settled(page);
    await page.getByRole("button", { name: "Detach w34-shop.test" }).click();
    await expect(page.getByRole("status")).toHaveText("Domain detached. Its findings no longer show on this project.");
    await page.goto(tab);
    await expect(page.getByRole("main")).toContainText("No domain is linked to Shop.");
  });

  test("UAT-W39 a viewer sees the findings but cannot attach or detach, even replaying the owner's form", async ({ page, browser }) => {
    const { tenant, ids } = await workspaceWith(page, "w35", ["Shop"]);
    const domain = await seedScannedDomain(tenant, "w35-shop.test", true);
    const free = await seedScannedDomain(tenant, "w35-free.test", true);
    await adminQuery("INSERT INTO supahound.scan_domain_links (tenant_id, domain_id, project_id) VALUES ($1, $2, $3)", [tenant, domain, ids.Shop]);
    const settingsUrl = `/w/${tenant}/p/${ids.Shop}/settings`;
    await page.goto(settingsUrl);
    const detachForm = await page.locator("form", { has: page.getByRole("button", { name: "Detach w35-shop.test" }) }).evaluate((f) => f.outerHTML);
    const attachForm = await page.locator("form", { has: page.getByRole("button", { name: "Attach domain" }) }).evaluate((f) => f.outerHTML);

    const viewer = await browser.newPage();
    const viewerEmail = uniqueEmail("w35-viewer");
    await signIn(viewer, viewerEmail);
    await addViewer(tenant, await userIdFor(viewerEmail));

    await viewer.goto(`/w/${tenant}/p/${ids.Shop}/findings`);
    await expect(viewer.getByRole("region", { name: "Scan of w35-shop.test" })).toContainText("1 critical · 1 low");
    await viewer.goto(settingsUrl);
    await expect(viewer.getByRole("list", { name: "Attached domains" })).toContainText("w35-shop.test");
    await expect(viewer.getByRole("button", { name: /Detach|Attach/ })).toHaveCount(0);
    await expect(viewer.getByRole("main")).toContainText("Only the project's owners and admins can attach or detach a domain.");
    // An unattached domain is workspace data: a viewer never sees it.
    await expect(viewer.getByRole("main")).not.toContainText("w35-free.test");

    const replay = async (html: string, domainId: string) => {
      await viewer.goto(settingsUrl);
      await settled(viewer);
      await viewer.evaluate(([h, d]) => {
        document.body.insertAdjacentHTML("beforeend", h);
        const form = document.body.lastElementChild as HTMLFormElement;
        form.querySelector("[name=domainId]")!.outerHTML = `<input type="hidden" name="domainId" value="${d}">`;
        form.requestSubmit();
      }, [html, domainId] as const);
      await expect(viewer).toHaveURL(/\?domain=role#scan-domains$/);
      await expect(viewer.getByRole("status")).toHaveText("Only the project's owners and admins can attach or detach a domain.");
    };
    await replay(detachForm, domain);
    await replay(attachForm, free);
    const links = await adminQuery<{ domain_id: string }>("SELECT domain_id FROM supahound.scan_domain_links WHERE tenant_id = $1", [tenant]);
    expect(links.map((l) => l.domain_id)).toEqual([domain]);
  });

  test("UAT-W40 another workspace's project is a 404 on the Security scan tab and its settings", async ({ page, browser }) => {
    const a = await workspaceWith(page, "w36-a", ["Alpha"]);
    const other = await browser.newPage();
    const b = await workspaceWith(other, "w36-b", ["Bravo"]);
    const domain = await seedScannedDomain(b.tenant, "w36-bravo.test", true);
    await adminQuery("INSERT INTO supahound.scan_domain_links (tenant_id, domain_id, project_id) VALUES ($1, $2, $3)", [b.tenant, domain, b.ids.Bravo]);

    for (const path of [
      `/w/${a.tenant}/p/${b.ids.Bravo}/findings`,
      `/w/${b.tenant}/p/${b.ids.Bravo}/findings`,
      `/w/${a.tenant}/p/${b.ids.Bravo}/settings`,
    ]) {
      const res = await page.goto(path);
      expect(res?.status(), path).toBe(404);
      expect(await page.content(), path).not.toContain("w36-bravo.test");
    }
    // A's own project shows nothing of B's domain.
    await page.goto(`/w/${a.tenant}/p/${a.ids.Alpha}/findings`);
    await expect(page.getByRole("main")).toContainText("No domain is linked to Alpha.");
    await page.goto(`/w/${a.tenant}/p/${a.ids.Alpha}/settings`);
    await expect(page.getByRole("main")).not.toContainText("w36-bravo.test");
  });
});
