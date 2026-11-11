import { expect, test } from "@playwright/test";
import { adminQuery, pollAttack, sha256Hex } from "../support/seed";
import { WORKSPACE_URL, createPaidWorkspace, requestMagicLink, signIn, tenantFromUrl, uniqueEmail } from "../support/session";

// User acceptance scenarios for the web app (docs/testing.md, UAT-W*). Each runs the real
// Worker, real Postgres with forced RLS, and Supabase Auth's token checks against a fake server.

test.describe("UAT: from email to a watched workspace", () => {
  test("UAT-W1 a new user signs in with a magic link and lands on onboarding", async ({ page }) => {
    const email = uniqueEmail("w1");
    const link = await signIn(page, email);
    expect(link.hookStatus).toBe(200); // our hook accepted Supabase's signed call and sent the email
    await expect(page).toHaveURL(/\/onboarding$/);
    await expect(page.getByRole("heading", { name: "Create your workspace" })).toBeVisible();
    await expect(page.getByText(`Signed in as ${email}`)).toBeVisible();
  });

  test("UAT-W2 a sign-in link works once", async ({ page, context }) => {
    const link = await signIn(page, uniqueEmail("w2"));
    await expect(page).toHaveURL(/\/onboarding$/);
    await context.clearCookies();
    await page.goto(`/auth/confirm?token_hash=${link.tokenHash}&type=${link.type}`);
    await expect(page).toHaveURL(/\/login\?error=link$/);
  });

  test("UAT-W3 a signed-in user who opens /login goes straight to the app", async ({ page }) => {
    await signIn(page, uniqueEmail("w3"));
    await page.goto("/login");
    await expect(page).toHaveURL(/\/onboarding$/);
  });

  test("UAT-W4 a new user creates a workspace and sees the setup checklist", async ({ page }) => {
    await signIn(page, uniqueEmail("w4"));
    await page.getByLabel("Workspace name").fill("Acme Studio");
    await createPaidWorkspace(page);
    await expect(page.getByRole("heading", { name: "Overview" })).toBeVisible();
    await expect(page.getByRole("heading", { name: "Finish setup" })).toBeVisible();
    await expect(page.getByRole("button", { name: "Connect Supabase" })).toBeVisible();
    await expect(page.getByText("No open incidents.")).toBeVisible();

    // A second visit to onboarding does not create a second workspace.
    await page.goto("/onboarding");
    await expect(page).toHaveURL(WORKSPACE_URL);
    const tenant = tenantFromUrl(page);
    const rows = await adminQuery<{ n: string }>("SELECT count(*) AS n FROM supahound.memberships WHERE tenant_id = $1", [tenant]);
    expect(rows[0]!.n).toBe("1");
  });

  test("UAT-W5 Connect Supabase sends the owner to Supabase consent with PKCE and a bound state", async ({ page }) => {
    await signIn(page, uniqueEmail("w5"));
    await page.getByLabel("Workspace name").fill("Connect Co");
    await createPaidWorkspace(page);
    const tenant = tenantFromUrl(page);

    // Stop at Supabase's door: never call the real Management API from a test.
    let consent: URL | null = null;
    await page.route("https://api.supabase.com/**", async (route) => {
      consent = new URL(route.request().url());
      await route.fulfill({ status: 200, contentType: "text/html", body: "<h1>Supabase consent (stub)</h1>" });
    });
    await page.getByRole("button", { name: "Connect Supabase" }).click();
    await expect(page.getByRole("heading", { name: "Supabase consent (stub)" })).toBeVisible();

    const url = consent as URL | null;
    expect(url?.pathname).toBe("/v1/oauth/authorize");
    const q = url!.searchParams;
    expect(q.get("client_id")).toBe("e2e-oauth-client");
    expect(q.get("redirect_uri")).toBe(`${process.env.E2E_APP_URL}/api/supabase/callback`);
    expect(q.get("response_type")).toBe("code");
    expect(q.get("code_challenge_method")).toBe("S256");
    expect(q.get("code_challenge")).toMatch(/^[A-Za-z0-9_-]{43}$/);

    // The state is stored only as a hash, bound to this workspace, single-use and short-lived.
    const state = q.get("state")!;
    const rows = await adminQuery<{ tenant_id: string; used_at: Date | null; ttl: number }>(
      "SELECT tenant_id, used_at, extract(epoch FROM expires_at - created_at)::int AS ttl FROM supahound.oauth_states WHERE state_hash = $1",
      [sha256Hex(state)],
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ tenant_id: tenant, used_at: null });
    expect(rows[0]!.ttl).toBeLessThanOrEqual(600);
    const plain = await adminQuery("SELECT 1 FROM supahound.oauth_states WHERE state_hash = $1", [state]);
    expect(plain).toHaveLength(0);
  });

  test("UAT-W6 a callback with a forged state does not connect anything", async ({ page }) => {
    await signIn(page, uniqueEmail("w6"));
    await page.getByLabel("Workspace name").fill("Forged Co");
    await createPaidWorkspace(page);
    const tenant = tenantFromUrl(page);
    await page.goto(`/api/supabase/callback?code=abc&state=${tenant}.${"f".repeat(43)}`);
    await expect(page.getByRole("status")).toHaveText(/failed or the link expired|Connecting Supabase failed/);
    const conns = await adminQuery("SELECT 1 FROM supahound.connections WHERE tenant_id = $1", [tenant]);
    expect(conns).toHaveLength(0);
  });

  test("UAT-W7 another user cannot open my workspace (same 404 as a missing one)", async ({ page, browser }) => {
    await signIn(page, uniqueEmail("w7-owner"));
    await page.getByLabel("Workspace name").fill("Private Co");
    await createPaidWorkspace(page);
    const tenant = tenantFromUrl(page);

    const intruder = await browser.newPage();
    await signIn(intruder, uniqueEmail("w7-intruder"));
    const mine = await intruder.goto(`/w/${tenant}`);
    const missing = await intruder.goto("/w/00000000-0000-4000-8000-000000000000");
    expect(mine?.status()).toBe(404);
    expect(missing?.status()).toBe(404);
    await expect(intruder.getByText("Private Co")).toHaveCount(0);
    await intruder.close();
  });

  test("UAT-W8 the owner sees a critical incident after the poller catches a scrape", async ({ page }) => {
    await signIn(page, uniqueEmail("w8"));
    await page.getByLabel("Workspace name").fill("Agency One");
    await createPaidWorkspace(page);
    const tenant = tenantFromUrl(page);

    await pollAttack(tenant, "Client app");
    await page.reload();

    const incident = page.getByRole("listitem").filter({ hasText: "Client app" }).filter({ hasText: "critical" });
    await expect(incident).toHaveCount(1);
    await expect(incident).toContainText("37 requests");
    // The summary is built from structured features only: no raw IDs or user agents reach the page.
    const html = await page.content();
    for (const banned of ["11111111-1111-4111-8111-111111111111", "22222222-2222-4222-8222-222222222222", "python-httpx"]) {
      expect(html).not.toContain(banned);
    }
    await expect(page.getByRole("listitem").filter({ hasText: "Client app" }).filter({ hasText: "1 open" })).toBeVisible();
  });

  test("UAT-W9 signing out ends the session", async ({ page }) => {
    await signIn(page, uniqueEmail("w9"));
    await page.getByLabel("Workspace name").fill("Bye Co");
    await createPaidWorkspace(page);
    await page.getByRole("button", { name: "Sign out" }).click();
    await page.goto("/app");
    await expect(page).toHaveURL(/\/login$/);
  });

  test("UAT-W10 the magic-link form gives the same answer for any address", async ({ page }) => {
    // Account discovery: a new address and a known one both see "check your email".
    const known = uniqueEmail("w10");
    await signIn(page, known);
    await page.context().clearCookies();
    await requestMagicLink(page, known);
    await requestMagicLink(page, uniqueEmail("w10-new"));
  });
});
