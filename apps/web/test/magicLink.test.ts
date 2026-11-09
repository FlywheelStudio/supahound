import { describe, expect, it } from "vitest";
import { confirmUrl, isSignInType, renderSignInEmail, SIGN_IN_TYPES } from "../lib/email/magicLink";

// The sign-in email: only sign-in types, a link to OUR /auth/confirm, and HTML that cannot be
// broken out of. Covered end to end by E2E UAT-W1; these pin the rules at unit level.

describe("isSignInType", () => {
  it("accepts exactly the sign-in types", () => {
    for (const t of SIGN_IN_TYPES) expect(isSignInType(t)).toBe(true);
  });

  it("rejects every other Supabase email type", () => {
    for (const t of ["recovery", "invite", "email_change", "reauthentication", "", "MAGICLINK"]) {
      expect(isSignInType(t)).toBe(false);
    }
  });
});

describe("confirmUrl", () => {
  it("points at the app's own /auth/confirm with the token hash and type", () => {
    const url = new URL(confirmUrl("https://app.supahound.test", "abc123", "magiclink"));
    expect(url.origin).toBe("https://app.supahound.test");
    expect(url.pathname).toBe("/auth/confirm");
    expect(url.searchParams.get("token_hash")).toBe("abc123");
    expect(url.searchParams.get("type")).toBe("magiclink");
    expect([...url.searchParams.keys()].sort()).toEqual(["token_hash", "type"]);
  });

  it("ignores any path on the app URL and encodes the token hash", () => {
    const url = new URL(confirmUrl("https://app.supahound.test/some/path?x=1", "a&b=c#d", "email"));
    expect(url.pathname).toBe("/auth/confirm");
    expect(url.searchParams.get("token_hash")).toBe("a&b=c#d");
    expect(url.searchParams.has("x")).toBe(false);
    expect(url.hash).toBe("");
  });
});

describe("renderSignInEmail", () => {
  it("puts the link in both the text and the HTML body", () => {
    const link = confirmUrl("https://app.supahound.test", "abc", "magiclink");
    const email = renderSignInEmail(link);
    expect(email.subject).toBe("Your Supahound sign-in link");
    expect(email.text).toContain(link);
    expect(email.html).toContain(link.replace(/&/g, "&amp;"));
  });

  it("escapes the link so it cannot break out of the href", () => {
    const email = renderSignInEmail('https://x.test/"><script>alert(1)</script>');
    expect(email.html).not.toContain("<script>");
    expect(email.html).toContain("&quot;&gt;&lt;script&gt;");
  });
});
