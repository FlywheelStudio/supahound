import { expect, test } from "@playwright/test";
import { pollPickedProject } from "../support/seed";
import { createPaidWorkspace, signIn, tenantFromUrl, uniqueEmail } from "../support/session";

// Ownership refresh (issue #10, decision 024). The poll reads each project's RLS policies; the
// overview must never show a project that detector 2 could not check as if it were clean.

test.describe("UAT: detector 2 coverage on the overview", () => {
  test("UAT-W16 the overview says when cross-tenant reads cannot be assessed or have nothing to cover", async ({ page }) => {
    await signIn(page, uniqueEmail("w16"));
    await page.getByLabel("Workspace name").fill("Coverage Co");
    await createPaidWorkspace(page);
    const tenant = tenantFromUrl(page);

    await pollPickedProject(tenant, "Locked app", "forbidden");
    await pollPickedProject(tenant, "Team app", [{
      schemaname: "public", tablename: "notes", permissive: "PERMISSIVE", roles: ["authenticated"], cmd: "ALL",
      qual: "(team_id IN ( SELECT m.team_id FROM members m WHERE (m.user_id = auth.uid())))",
    }]);
    await pollPickedProject(tenant, "Owned app", [{
      schemaname: "public", tablename: "notes", permissive: "PERMISSIVE", roles: ["authenticated"], cmd: "ALL",
      qual: "(auth.uid() = user_id)",
    }]);
    await page.reload();

    const row = (name: string) => page.getByRole("listitem").filter({ hasText: name });
    await expect(row("Locked app")).toContainText("Cross-tenant reads: unable to assess");
    await expect(row("Team app")).toContainText("Cross-tenant reads: no owner-scoped tables found");
    await expect(row("Owned app")).not.toContainText("Cross-tenant reads");
    await expect(row("Owned app")).toContainText("ok");
  });
});
