// What the app shows about who runs this copy of Supahound (decision 025). The marketing site,
// prices and legal pages live elsewhere: Flywheel's in a private repo, a self-hoster's wherever
// they like. Every link here is optional, so a self-hosted copy shows no one else's terms.

export const PRODUCT_NAME = "Supahound";
export const PRODUCT_DESCRIPTION =
  "Supahound watches your Supabase logs for cross-tenant reads, leaked service keys and scraping. Read-only.";

export interface BrandEnv {
  SUPPORT_EMAIL?: string;
  TERMS_URL?: string;
  PRIVACY_URL?: string;
}

export interface Brand {
  supportEmail: string | null;
  termsUrl: string | null;
  privacyUrl: string | null;
}

// Only https URLs and plain addresses pass, so a bad var never becomes a javascript: link.
function httpsUrl(v: string | undefined): string | null {
  if (!v) return null;
  try {
    const u = new URL(v);
    return u.protocol === "https:" ? u.toString() : null;
  } catch {
    return null;
  }
}

function email(v: string | undefined): string | null {
  return v && /^[^\s@<>"]+@[^\s@<>"]+\.[a-z]{2,}$/i.test(v) ? v : null;
}

export function brandFrom(env: BrandEnv): Brand {
  return { supportEmail: email(env.SUPPORT_EMAIL), termsUrl: httpsUrl(env.TERMS_URL), privacyUrl: httpsUrl(env.PRIVACY_URL) };
}
