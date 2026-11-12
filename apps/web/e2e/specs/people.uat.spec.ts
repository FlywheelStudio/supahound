import { expect, test, type Page } from "@playwright/test";
import { countMailsTo, inviteLinkIn, lastMailTo } from "../support/mail";
import { addViewer, adminQuery, pollPickedProject, sha256Hex, userIdFor } from "../support/seed";
import { createPaidWorkspace, settled, signIn, tenantFromUrl, uniqueEmail } from "../support/session";

// UAT for people and roles per project (issue #24, decisions 033 and 036): invite by email,
// accept after a magic-link sign-in, see only that project; roles enforced on the server.

const INVITE_SUBJECT = /^Join /;

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

async function invite(page: Page, peopleUrl: string, email: string, role: string) {
  await page.goto(peopleUrl);
  await page.getByLabel("Email", { exact: true }).fill(email);
  await page.getByLabel("Role", { exact: true }).selectOption(role);
  await page.getByRole("button", { name: "Send invite" }).click();
}

// Signs in from the login page the app sent us to, keeping its ?next=, through the real hook.
async function signInHere(page: Page, email: string) {
  await expect(page).toHaveURL(/\/login\?next=/);
  await page.getByLabel("Work email").fill(email);
  await page.getByRole("button", { name: /sign-in link|Email me/ }).click();
  await expect(page.getByText("Check your email for a sign-in link.")).toBeVisible();
  const sent = (await (await fetch(`${process.env.E2E_AUTH_URL}/__test/sent`)).json()) as { email: string; tokenHash: string; type: string }[];
  const link = sent.filter((s) => s.email === email).at(-1)!;
  await page.goto(`/auth/confirm?token_hash=${link.tokenHash}&type=${link.type}`);
}

test.describe("UAT: people and roles per project", () => {
  test("UAT-W26 an owner invites a colleague by email; signed out, they sign in from the link, accept, and see only that project", async ({ page, browser }) => {
    const { tenant, email: ownerEmail, ids } = await workspaceWith(page, "w26", ["Shop", "Blog"]);
    const people = `/w/${tenant}/p/${ids.Shop}/settings/people`;
    const invitee = uniqueEmail("w26-invitee");

    await invite(page, people, invitee.toUpperCase(), "editor");
    await expect(page.getByRole("status")).toHaveText("Invite sent. It expires in 7 days.");
    await expect(page.getByRole("list", { name: "Pending invites" })).toContainText(`${invitee}Editor`);
    const stored = await adminQuery<{ token_hash: string; email: string }>("SELECT token_hash, email FROM supahound.project_invites WHERE tenant_id = $1", [tenant]);
    expect(stored.map((r) => r.email)).toEqual([invitee]);

    // The email: project, role, inviter, expiry and our accept link. Only the token's hash is stored.
    const mail = await lastMailTo(invitee, INVITE_SUBJECT);
    expect(mail.subject).toBe("Join Shop on Supahound");
    expect(mail.text).toContain(`${ownerEmail} invited you to the project Shop on Supahound, as Editor.`);
    expect(mail.text).toContain("expires in 7 days");
    const link = inviteLinkIn(mail);
    const token = new URL(link, "http://x").searchParams.get("token")!;
    expect(stored[0]!.token_hash).toBe(sha256Hex(token));

    // A fresh browser, signed out: opening the link changes nothing and asks for sign-in.
    const ctx = await browser.newContext();
    const them = await ctx.newPage();
    await them.goto(link);
    await expect(them.getByRole("heading", { name: "You are invited to a project on Supahound" })).toBeVisible();
    expect((await adminQuery("SELECT 1 FROM supahound.project_invites WHERE tenant_id = $1 AND accepted_at IS NOT NULL", [tenant])).length).toBe(0);
    await them.getByRole("link", { name: "Sign in to accept" }).click();
    await signInHere(them, invitee);

    // The sign-in link brings them back to the invite, not to onboarding.
    await expect(them).toHaveURL(/\/invite\?token=/);
    await expect(them.getByRole("heading", { name: "Join Shop" })).toBeVisible();
    await them.getByRole("button", { name: "Accept invite" }).click();
    await expect(them).toHaveURL(new RegExp(`/w/${tenant}/p/${ids.Shop}\\?joined=1$`));
    await expect(them.getByRole("status")).toHaveText("You joined Shop as Editor.");

    // Only Shop: in the dropdown, on the overview; Blog is a 404, as is any page of it.
    await settled(them);
    await them.getByLabel(/Switch project/).click();
    await expect(them.getByRole("list", { name: "Projects" }).getByRole("link")).toContainText(["All projects", "Shop"]);
    await expect(them.getByRole("list", { name: "Projects" })).not.toContainText("Blog");
    await them.goto(`/w/${tenant}`);
    await expect(them.getByRole("main")).toContainText("Shop");
    await expect(them.getByRole("main")).not.toContainText("Blog");
    for (const path of [`/w/${tenant}/p/${ids.Blog}`, `/w/${tenant}/p/${ids.Blog}/settings/people`, `/w/${tenant}/p/${ids.Blog}/incidents`]) {
      const res = await them.goto(path);
      expect(res?.status(), path).toBe(404);
    }

    // An editor changes settings, but does not manage people.
    await them.goto(`/w/${tenant}/p/${ids.Shop}/settings/notifications`);
    await expect(them.getByLabel("Email alerts for Shop")).toBeVisible();
    await them.goto(people);
    await expect(them.getByRole("button", { name: "Send invite" })).toHaveCount(0);
    await expect(them.getByRole("list", { name: "People" })).toContainText(`${invitee}(you)Editor`);

    // The link works once.
    await them.goto(link);
    await expect(them.getByRole("alert")).toHaveText("This invite was already used. Each invite works once.");
    await expect(them.getByRole("button", { name: "Accept invite" })).toHaveCount(0);

    // The owner sees them as Editor; the invite is no longer pending.
    await page.goto(people);
    await expect(page.getByRole("list", { name: "People" })).toContainText(invitee);
    await expect(page.getByText("No pending invites.")).toBeVisible();
    await ctx.close();
  });

  test("UAT-W27 a viewer is refused an admin action, even replaying the owner's form; an admin cannot invite an Owner", async ({ page, browser }) => {
    const { tenant, ids } = await workspaceWith(page, "w27", ["Shop"]);
    const people = `/w/${tenant}/p/${ids.Shop}/settings/people`;
    await page.goto(people);
    const ownerForm = await page.locator("form", { has: page.getByRole("button", { name: "Send invite" }) }).evaluate((f) => f.outerHTML);

    const viewer = await browser.newPage();
    const viewerEmail = uniqueEmail("w27-viewer");
    await signIn(viewer, viewerEmail);
    await addViewer(tenant, await userIdFor(viewerEmail));
    await viewer.goto(people);
    await expect(viewer.getByText("Your role on Shop: Viewer.")).toBeVisible();
    await expect(viewer.getByRole("button", { name: "Send invite" })).toHaveCount(0);
    await expect(viewer.getByRole("list", { name: "Pending invites" })).toHaveCount(0);
    await expect(viewer.getByRole("main")).toContainText("Only the project's owners and admins can invite people or change roles.");

    const replay = async (who: Page, email: string, role: string) => {
      await who.goto(people);
      await settled(who);
      await who.evaluate(([html, e, r]) => {
        document.body.insertAdjacentHTML("beforeend", html);
        const form = document.body.lastElementChild as HTMLFormElement;
        form.querySelector<HTMLInputElement>("input[name=email]")!.value = e;
        // Any role, even one the form does not offer: the server must refuse it on its own.
        form.querySelector("select[name=role]")!.outerHTML = `<input type="hidden" name="role" value="${r}">`;
        form.requestSubmit();
      }, [ownerForm, email, role] as const);
      await expect(who).toHaveURL(/error=role/);
      await expect(who.getByRole("status")).toHaveText("Your role on this project does not allow that.");
    };
    const target = uniqueEmail("w27-target");
    await replay(viewer, target, "viewer");
    expect(await adminQuery("SELECT 1 FROM supahound.project_invites WHERE tenant_id = $1", [tenant])).toEqual([]);
    expect(countMailsTo(target, INVITE_SUBJECT)).toBe(0);

    // A workspace admin is Admin on the project: invites anyone but an Owner.
    const admin = await browser.newPage();
    const adminEmail = uniqueEmail("w27-admin");
    await signIn(admin, adminEmail);
    await adminQuery("INSERT INTO supahound.memberships (tenant_id, user_id, role) VALUES ($1, $2, 'admin')", [tenant, await userIdFor(adminEmail)]);
    await admin.goto(people);
    await expect(admin.getByLabel("Role", { exact: true }).locator("option")).toHaveText(["Admin", "Editor", "Viewer"]);
    await replay(admin, target, "owner");
    expect(await adminQuery("SELECT 1 FROM supahound.project_invites WHERE tenant_id = $1", [tenant])).toEqual([]);
    await invite(admin, people, target, "admin");
    await expect(admin.getByRole("status")).toHaveText("Invite sent. It expires in 7 days.");
    await viewer.close();
    await admin.close();
  });

  test("UAT-W28 an invite is bound to its address, can be canceled, resent (old link dead) and expires", async ({ page, browser }) => {
    const { tenant, ids } = await workspaceWith(page, "w28", ["Shop"]);
    const people = `/w/${tenant}/p/${ids.Shop}/settings/people`;
    const invitee = uniqueEmail("w28-invitee");
    await invite(page, people, invitee, "viewer");
    const first = inviteLinkIn(await lastMailTo(invitee, INVITE_SUBJECT));

    // Someone else, signed in, holding the link: refused, nothing written.
    const other = await browser.newPage();
    const otherEmail = uniqueEmail("w28-other");
    await signIn(other, otherEmail);
    await other.goto(first);
    await expect(other.getByRole("alert")).toContainText("This invite is for a different email address.");
    await expect(other.getByRole("button", { name: "Accept invite" })).toHaveCount(0);
    // A non-member who knows the project URL gets a 404.
    expect((await other.goto(`/w/${tenant}/p/${ids.Shop}`))?.status()).toBe(404);
    expect(await adminQuery("SELECT 1 FROM supahound.memberships WHERE tenant_id = $1 AND user_id = $2", [tenant, await userIdFor(otherEmail)])).toEqual([]);

    // Resend: a new email; the first link is dead, the new one is live.
    await adminQuery("UPDATE supahound.project_invites SET sent_at = sent_at - interval '2 minutes' WHERE tenant_id = $1", [tenant]);
    await page.goto(people);
    await page.getByRole("button", { name: `Resend invite to ${invitee}` }).click();
    await expect(page.getByRole("status")).toContainText("Invite sent again.");
    await expect.poll(() => countMailsTo(invitee, INVITE_SUBJECT)).toBe(2);
    const second = inviteLinkIn(await lastMailTo(invitee, INVITE_SUBJECT));
    expect(second).not.toBe(first);

    const them = await browser.newPage();
    await signIn(them, invitee);
    await them.goto(first);
    await expect(them.getByRole("alert")).toHaveText("This invite link is not valid. Ask for a new invite.");

    // Expired: refused even by the invited address.
    await adminQuery("UPDATE supahound.project_invites SET expires_at = now() - interval '1 minute' WHERE tenant_id = $1", [tenant]);
    await them.goto(second);
    await expect(them.getByRole("alert")).toContainText("This invite has expired.");
    await page.goto(people);
    await expect(page.getByRole("list", { name: "Pending invites" })).toContainText("Expired");

    // Cancel: the link stops working.
    await page.getByRole("button", { name: `Cancel invite to ${invitee}` }).click();
    await expect(page.getByRole("status")).toHaveText("Invite canceled. Its link no longer works.");
    await them.goto(second);
    await expect(them.getByRole("alert")).toContainText("This invite was canceled.");
    expect(await adminQuery("SELECT 1 FROM supahound.memberships WHERE tenant_id = $1 AND user_id = $2", [tenant, await userIdFor(invitee)])).toEqual([]);
    await other.close();
    await them.close();
  });
});
