import { randomBytes } from "node:crypto";
import { expect, type Page } from "@playwright/test";

// Signs a user in through the real UI: the login form → Supabase (fake) → our signed Send Email
// Hook → the link in the email → /auth/confirm. Returns the token hash so a test can try it again.

interface SentLink {
  email: string;
  tokenHash: string;
  type: string;
  hookStatus: number;
}

export async function requestMagicLink(page: Page, email: string): Promise<SentLink> {
  await page.goto("/login");
  await page.getByLabel("Work email").fill(email);
  await page.getByRole("button", { name: "Email me a sign-in link" }).click();
  await expect(page.getByText("Check your email for a sign-in link.")).toBeVisible();
  const sent = (await (await fetch(`${process.env.E2E_AUTH_URL}/__test/sent`)).json()) as SentLink[];
  const link = sent.filter((s) => s.email === email).at(-1);
  if (!link) throw new Error(`No magic link was sent to ${email}`);
  return link;
}

export async function signIn(page: Page, email: string): Promise<SentLink> {
  const link = await requestMagicLink(page, email);
  await page.goto(`/auth/confirm?token_hash=${link.tokenHash}&type=${link.type}`);
  return link;
}

export function uniqueEmail(tag: string): string {
  return `${tag}-${Date.now()}-${Math.floor(Math.random() * 1e6)}@example.com`;
}

export const WORKSPACE_URL = /\/w\/([0-9a-f-]{36})$/;

export function tenantFromUrl(page: Page): string {
  const m = WORKSPACE_URL.exec(new URL(page.url()).pathname);
  if (!m) throw new Error(`Not on a workspace page: ${page.url()}`);
  return m[1]!;
}

// Wait until a freshly loaded page can take a client-side link click (#70). `goto` and `reload`
// return at the load event, but vinext's <Link> imports its navigation module on the first click;
// a click in that window was lost once (UAT-W14). After network idle, every chunk has loaded.
export async function settled(page: Page): Promise<void> {
  await page.waitForLoadState("networkidle");
}

// Decision 028: a new workspace lands on its billing page. Specs that are not about billing click
// "Create workspace" through this helper: it checks the gate sent them to billing, then marks the
// workspace as trialing in the database (the billing specs go through the fake Checkout instead).
export async function createPaidWorkspace(page: Page): Promise<string> {
  await page.getByRole("button", { name: "Create workspace" }).click();
  await expect(page).toHaveURL(/\/w\/[0-9a-f-]{36}\/billing$/);
  const tenant = /\/w\/([0-9a-f-]{36})\//.exec(new URL(page.url()).pathname)![1]!;
  const { adminQuery } = await import("./seed");
  const suffix = randomBytes(8).toString("hex");
  await adminQuery(
    `INSERT INTO supahound.billing_accounts (tenant_id, stripe_customer_id, status, subscription_id, starter_seats, pro_seats, trial_end, card_verified_at, terms_version, terms_accepted_at)
     VALUES ($1, $2, 'trialing', $3, 1, 0, now() + interval '7 days', now(), 'e2e', now())`,
    [tenant, `cus_seed${suffix}`, `sub_seed${suffix}`],
  );
  await page.goto(`/w/${tenant}`);
  await expect(page).toHaveURL(WORKSPACE_URL);
  return tenant;
}
