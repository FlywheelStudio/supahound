import { escapeHtml } from "../security";

// Sign-in emails sent for the Supabase Send Email Hook (decision 009).
// The link goes to our own /auth/confirm route, which verifies the token hash server-side
// and sets the session cookie. Supabase's redirect_to is ignored: the destination is ours.

export const SIGN_IN_TYPES = ["magiclink", "signup", "email"] as const;
export type SignInType = (typeof SIGN_IN_TYPES)[number];

export function isSignInType(t: string): t is SignInType {
  return (SIGN_IN_TYPES as readonly string[]).includes(t);
}

export function confirmUrl(appUrl: string, tokenHash: string, type: SignInType): string {
  const url = new URL("/auth/confirm", appUrl);
  url.searchParams.set("token_hash", tokenHash);
  url.searchParams.set("type", type);
  return url.toString();
}

export interface RenderedEmail {
  subject: string;
  text: string;
  html: string;
}

export function renderSignInEmail(link: string): RenderedEmail {
  const safe = escapeHtml(link);
  return {
    subject: "Your Guardbase sign-in link",
    text: `Sign in to Guardbase:\n\n${link}\n\nThe link works once and expires in 1 hour. If you did not ask for it, ignore this email.`,
    html: `<!doctype html><html><body style="font-family:system-ui,sans-serif;color:#0f172a">
<p>Sign in to Guardbase:</p>
<p><a href="${safe}" style="display:inline-block;padding:10px 16px;background:#0f172a;color:#fff;border-radius:6px;text-decoration:none">Sign in</a></p>
<p style="color:#475569;font-size:13px">The link works once and expires in 1 hour. If you did not ask for it, ignore this email.</p>
</body></html>`,
  };
}
