import { expect, test, type Page } from "@playwright/test";
import { addViewer, adminQuery, pollWithPosture, seedConnection, setPosture, setSupabaseProjects, userIdFor } from "../support/seed";
import { createPaidWorkspace, settled, signIn, tenantFromUrl, uniqueEmail } from "../support/session";

// Posture scan (issue #11, decision 038). The poll runs core's real read-only SQL and Security
// Advisor clients against the fake Management API, so these specs cover the clients, the scan,
// storage and the pages end to end. Synthetic catalog rows and lints only.

const ALL = "anon:DELETE,anon:INSERT,anon:SELECT,anon:UPDATE,authenticated:DELETE,authenticated:INSERT,authenticated:SELECT,authenticated:UPDATE";
const table = (name: string, rls: boolean, policies = 0) => ({
  kind: "table", schema_name: "public", object_name: name, rls_enabled: rls, rls_forced: false, policy_count: policies,
  security_invoker: false, grants: ALL, policy_name: null, permissive: null, roles: null, cmd: null, qual: null, with_check: null,
});
const view = (name: string) => ({ ...table(name, false), kind: "view" });
const policy = (tbl: string, name: string, cmd: string, check: string | null, qual: string | null) => ({
  kind: "policy", schema_name: "public", object_name: tbl, rls_enabled: null, rls_forced: null, policy_count: null,
  security_invoker: null, grants: null, policy_name: name, permissive: "PERMISSIVE", roles: "authenticated", cmd, qual, with_check: check,
});
const lint = (name: string, object: string, level: string, type: string) => ({
  name, title: "Advisor title text", level, facing: "EXTERNAL", categories: ["SECURITY"], description: "Advisor description text",
  detail: "Advisor detail text", remediation: "https://example.test/remediation", metadata: { schema: "public", name: object, type },
  cache_key: `${name}_${object}`,
});

const CATALOG = [
  table("notes", false), table("comments", true, 1), policy("comments", "anyone edits", "UPDATE", null, "true"), view("leaderboard"),
];
const LINTS = [lint("rls_disabled_in_public", "notes", "ERROR", "table"), lint("function_search_path_mutable", "touch", "WARN", "function")];

async function workspaceWithPick(page: Page, tag: string, projects: { ref: string; name: string }[]) {
  const email = uniqueEmail(tag);
  await signIn(page, email);
  await page.getByLabel("Workspace name").fill(`${tag} Co`);
  await createPaidWorkspace(page);
  const tenant = tenantFromUrl(page);
  const token = `e2e-${tag}-${tenant}`;
  await setSupabaseProjects(token, projects);
  await seedConnection(tenant, token);
  await page.goto(`/w/${tenant}/projects`);
  for (const p of projects) await page.getByLabel(new RegExp(p.name)).check();
  await page.getByRole("button", { name: "Watch selected projects" }).click();
  await expect(page.getByRole("status")).toHaveText(new RegExp(`Watching ${projects.length} new project`));
  const ids = Object.fromEntries(
    (await adminQuery<{ id: string; name: string }>("SELECT id, name FROM supahound.projects WHERE tenant_id = $1", [tenant])).map((r) => [r.name, r.id]),
  );
  return { tenant, email, ids };
}

const row = (page: Page, name: string) => page.getByRole("main").getByRole("listitem").filter({ has: page.getByRole("link", { name, exact: true }) });

test.describe("UAT: posture scan", () => {
  test("UAT-W29 the first poll after a pick shows posture findings on the overview, the dashboard and the Posture tab, with fix SQL", async ({ page }) => {
    const shop = { ref: "posturew29shopxxxxxx", name: "Shop" };
    const locked = { ref: "posturew29lockedxxxx", name: "Locked" };
    const { tenant, ids } = await workspaceWithPick(page, "w29", [shop, locked]);
    await setPosture(shop.ref, CATALOG, LINTS);
    await setPosture(locked.ref, 403, 403);

    // Before the first poll: pending, never "no findings".
    await page.goto(`/w/${tenant}`);
    await expect(row(page, "Shop")).toContainText("Posture: first scan pending");

    await pollWithPosture(tenant, ids.Shop!);
    await pollWithPosture(tenant, ids.Locked!);
    await page.reload();
    await expect(row(page, "Shop")).toContainText("Posture: 1 critical · 2 high · 1 medium");
    await expect(row(page, "Locked")).toContainText("Posture: unable to assess (Supabase refused access)");

    await page.goto(`/w/${tenant}/p/${ids.Shop}`);
    const posture = page.getByRole("region", { name: "Posture" });
    await expect(posture).toContainText("Last scan");
    await expect(posture).toContainText("1 critical · 2 high · 1 medium");
    await expect(posture.getByRole("listitem").first()).toContainText("critical");
    await expect(posture.getByRole("listitem").first()).toContainText("Row level security is offpublic.notes");

    await settled(page);
    await page.getByRole("navigation", { name: "Main" }).getByRole("link", { name: "Posture" }).click();
    await expect(page).toHaveURL(`/w/${tenant}/p/${ids.Shop}/posture`);
    await expect(page.getByRole("heading", { name: "Posture" })).toBeVisible();
    await expect(page.getByRole("region", { name: "Scan status" })).toContainText("checked 2 tables, 1 views, 1 policies");
    const findings = page.getByRole("list", { name: "Posture findings" }).getByRole("listitem");
    // The Advisor's rls_disabled_in_public on notes duplicates Supahound's own check: shown once.
    await expect(findings).toHaveCount(4);
    await expect(findings.nth(0)).toContainText("critical");
    await expect(findings.nth(0)).toContainText("public.notes");
    await expect(page.getByLabel("Fix SQL for public.notes")).toContainText('ALTER TABLE "public"."notes" ENABLE ROW LEVEL SECURITY;');
    await expect(page.getByLabel("Fix SQL for public.comments")).toContainText('ALTER POLICY "anyone edits" ON "public"."comments"');
    await expect(page.getByLabel("Fix SQL for public.leaderboard")).toContainText('ALTER VIEW "public"."leaderboard" SET (security_invoker = true);');
    await expect(page.getByLabel("Fix SQL for public.touch")).toContainText(`ALTER FUNCTION "public"."touch" SET search_path = '';`);
    await expect(findings.filter({ hasText: "public.touch" })).toContainText("Security Advisor");
    // Supabase's free text never reaches the page.
    await expect(page.getByRole("main")).not.toContainText(/Advisor (title|description|detail) text|example\.test|must not leak/);

    await page.goto(`/w/${tenant}/p/${ids.Locked}/posture`);
    await expect(page.getByRole("region", { name: "Scan status" })).toContainText("Unable to assess: Supabase refused access");
    await expect(page.getByRole("list", { name: "Posture findings" })).toHaveCount(0);
    await expect(page.getByRole("main")).not.toContainText("No posture findings");
  });

  test("UAT-W30 Scan now queues a scan the next poll runs; a viewer gets no button and a replayed owner form is refused", async ({ page, browser }) => {
    const shop = { ref: "posturew30shopxxxxxx", name: "Shop" };
    const { tenant, ids } = await workspaceWithPick(page, "w30", [shop]);
    await setPosture(shop.ref, CATALOG, LINTS);
    await pollWithPosture(tenant, ids.Shop!, new Date(Date.now() - 120_000));

    const postureUrl = `/w/${tenant}/p/${ids.Shop}/posture`;
    await page.goto(postureUrl);
    await expect(page.getByLabel("Fix SQL for public.notes")).toBeVisible();
    const ownerForm = await page.locator("form", { has: page.getByRole("button", { name: "Scan now" }) }).evaluate((f) => f.outerHTML);

    // The customer fixes notes and the comments policy; the Advisor agrees.
    await setPosture(shop.ref, [table("notes", true, 1), table("comments", true, 1)], []);
    await page.getByRole("button", { name: "Scan now" }).click();
    await expect(page).toHaveURL(`${postureUrl}?scan=queued`);
    await expect(page.getByRole("status")).toHaveText("Scan queued. It runs on the next poll, within 2 minutes.");
    await expect(page.getByRole("button", { name: "Scan now" })).toBeDisabled();
    const requested = await adminQuery<{ requested_at: Date }>("SELECT requested_at FROM supahound.posture_scans WHERE tenant_id = $1", [tenant]);

    // A viewer: no button, and the owner's form replayed is refused by the server.
    const member = await browser.newPage();
    const memberEmail = uniqueEmail("w30-viewer");
    await signIn(member, memberEmail);
    await addViewer(tenant, await userIdFor(memberEmail));
    await member.goto(postureUrl);
    await expect(member.getByText("Only the project's owners, admins and editors can start a scan.")).toBeVisible();
    await expect(member.getByRole("button", { name: "Scan now" })).toHaveCount(0);
    await settled(member);
    await member.evaluate((html) => {
      document.body.insertAdjacentHTML("beforeend", html);
      (document.body.lastElementChild as HTMLFormElement).requestSubmit();
    }, ownerForm);
    await expect(member).toHaveURL(/scan=role/);
    await expect(member.getByRole("status")).toHaveText("Only the project's owners, admins and editors can start a scan.");
    expect(await adminQuery("SELECT requested_at FROM supahound.posture_scans WHERE tenant_id = $1", [tenant])).toEqual(requested);
    await member.close();

    // The next poll runs the queued scan, well inside 24 hours of the last one.
    await pollWithPosture(tenant, ids.Shop!);
    await page.goto(postureUrl);
    await expect(page.getByRole("region", { name: "Scan status" })).toContainText("Last scan");
    await expect(page.getByRole("main")).toContainText("No posture findings in the last scan.");
    await expect(page.getByRole("button", { name: "Scan now" })).toBeEnabled();
  });
});
