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
