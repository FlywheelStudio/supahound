import { expect, test } from "@playwright/test";
import { addViewer, adminQuery, pollPickedProject, userIdFor } from "../support/seed";
import { createPaidWorkspace, settled, signIn, tenantFromUrl, uniqueEmail } from "../support/session";

// UAT for Supahound's own security events (issue #138, decision 044): sign-ins and invites are
// recorded in the workspace, only its owners can read them, and a row holds no address.

test.describe("UAT: security log", () => {
  test("UAT-W51 the owner reads sign-ins and invites in the security log; a member cannot; rows hold no address", async ({ page, browser }) => {
    const ownerEmail = uniqueEmail("w51");
    await signIn(page, ownerEmail);
    await page.getByLabel("Workspace name").fill("w51 Co");
    await createPaidWorkspace(page);
    const tenant = tenantFromUrl(page);
    await pollPickedProject(tenant, "Shop", []);
    const [shop] = await adminQuery<{ id: string }>("SELECT id FROM supahound.projects WHERE tenant_id = $1", [tenant]);

    // An invite, through the People page.
    await page.goto(`/w/${tenant}/p/${shop!.id}/settings/people`);
    await page.getByLabel("Email", { exact: true }).fill(uniqueEmail("w51-invitee"));
    await page.getByLabel("Role", { exact: true }).selectOption("viewer");
    await page.getByRole("button", { name: "Send invite" }).click();
    await expect(page.getByRole("status")).toHaveText("Invite sent. It expires in 7 days.");

    // A member of the workspace signs in: the sign-in is recorded in it.
    const ctx = await browser.newContext();
    const member = await ctx.newPage();
    const memberEmail = uniqueEmail("w51-member");
    await signIn(member, memberEmail);
    const memberId = await userIdFor(memberEmail);
    await addViewer(tenant, memberId);
    await adminQuery("UPDATE supahound.memberships SET email = $3 WHERE tenant_id = $1 AND user_id = $2", [tenant, memberId, memberEmail]);
    await member.context().clearCookies();
    await signIn(member, memberEmail);
    await expect.poll(async () => (await adminQuery("SELECT 1 FROM supahound.security_events WHERE tenant_id = $1 AND action = 'sign_in'", [tenant])).length).toBe(1);

    // The member gets no log, by the page and by RLS.
    await member.goto(`/w/${tenant}/settings/security`);
    await expect(member.getByText("Only a workspace owner can see the security log.")).toBeVisible();
    await expect(member.getByRole("list", { name: "Security events" })).toHaveCount(0);
    await member.goto(`/w/${tenant}/settings`);
    await expect(member.getByRole("link", { name: "Open the security log" })).toHaveCount(0);

    // The owner opens it from Workspace settings.
    await page.goto(`/w/${tenant}/settings`);
    await settled(page);
    await page.getByRole("link", { name: "Open the security log" }).click();
    await expect(page.getByRole("heading", { name: "Security log" })).toBeVisible();
    const log = page.getByRole("list", { name: "Security events" });
    await expect(log.getByRole("listitem").first()).toContainText("Signed in");
    await expect(log.getByRole("listitem").first()).toContainText(memberEmail);
    await expect(log).toContainText("Sent an invite as Viewer on Shop");
    await expect(log.getByRole("listitem").filter({ hasText: "Sent an invite" })).toContainText(ownerEmail);

    // The rows hold IDs and enums only.
    const rows = await adminQuery<{ action: string; actor_user_id: string; detail: Record<string, unknown> }>(
      "SELECT action, actor_user_id, detail FROM supahound.security_events WHERE tenant_id = $1 ORDER BY created_at",
      [tenant],
    );
    expect(rows.map((r) => r.action)).toEqual(["invite_sent", "sign_in"]);
    expect(rows[1]!.actor_user_id).toBe(memberId);
    expect(JSON.stringify(rows)).not.toContain("@");
    await ctx.close();
  });
});
