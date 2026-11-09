import { expect, test } from "@playwright/test";

// Signed-out behaviour of the built Worker. These checks were manual steps in the web-app WIP
// doc's verification log; they now run on every PR.

test.describe("signed out", () => {
  test("the home and sign-in pages load", async ({ page }) => {
    expect((await page.goto("/"))?.status()).toBe(200);
    expect((await page.goto("/login"))?.status()).toBe(200);
    await expect(page.getByRole("heading", { name: "Sign in to Supahound" })).toBeVisible();
    await expect(page.getByLabel("Work email")).toBeVisible();
  });

  for (const path of ["/app", "/onboarding", "/w/00000000-0000-4000-8000-000000000000"]) {
    test(`${path} redirects to /login and is never cached`, async ({ request }) => {
      const res = await request.get(path, { maxRedirects: 0 });
      expect(res.status()).toBe(307);
      expect(new URL(res.headers().location!, "http://x").pathname).toBe("/login");
      expect(res.headers()["cache-control"]).toBe("private, no-store");
    });
  }

  test("a cross-origin POST is rejected (CSRF)", async ({ request }) => {
    const res = await request.post("/login", { headers: { origin: "https://evil.example" }, form: { email: "a@b.co" } });
    expect(res.status()).toBe(403);
  });

  test("a POST with no Origin header is rejected", async ({ request }) => {
    const res = await request.post("/auth/signout", { headers: { origin: "" } });
    expect(res.status()).toBe(403);
  });

  test("the Send Email Hook rejects an unsigned call", async ({ request }) => {
    const res = await request.post("/api/auth/send-email-hook", {
      data: { user: { email: "a@b.co" }, email_data: { token_hash: "x", email_action_type: "magiclink" } },
    });
    expect(res.status()).toBe(401);
  });

  test("a bad sign-in link lands on /login with an error", async ({ page }) => {
    await page.goto("/auth/confirm?token_hash=not-a-real-hash&type=magiclink");
    await expect(page).toHaveURL(/\/login\?error=link$/);
    await expect(page.getByRole("alert")).toHaveText("That sign-in link is invalid or expired. Ask for a new one.");
  });

  test("a sign-in link with an unsupported type is refused", async ({ page }) => {
    await page.goto("/auth/confirm?token_hash=abc&type=recovery");
    await expect(page).toHaveURL(/\/login\?error=link$/);
  });

  test("an invalid email address shows a validation error", async ({ page }) => {
    await page.goto("/login");
    await page.getByLabel("Work email").fill("not-an-email@x");
    await page.getByRole("button", { name: "Email me a sign-in link" }).click();
    await expect(page).toHaveURL(/error=email/);
    await expect(page.getByRole("alert")).toHaveText("Enter a valid email address.");
  });
});
