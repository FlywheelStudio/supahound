import { describe, expect, it } from "vitest";
import { brandFrom } from "../lib/brand";

// A self-hosted copy shows no one else's terms (decision 025): every link is optional, and a
// bad value is dropped instead of rendered.
describe("brandFrom", () => {
  it("shows nothing when nothing is set", () => {
    expect(brandFrom({})).toEqual({ supportEmail: null, termsUrl: null, privacyUrl: null });
    expect(brandFrom({ SUPPORT_EMAIL: "", TERMS_URL: "", PRIVACY_URL: "" })).toEqual({ supportEmail: null, termsUrl: null, privacyUrl: null });
  });

  it("keeps https links and a plain address", () => {
    const b = brandFrom({ SUPPORT_EMAIL: "help@example.com", TERMS_URL: "https://example.com/terms", PRIVACY_URL: "https://example.com/privacy" });
    expect(b).toEqual({ supportEmail: "help@example.com", termsUrl: "https://example.com/terms", privacyUrl: "https://example.com/privacy" });
  });

  it.each(["javascript:alert(1)", "http://example.com/terms", "data:text/html,x", "/terms", "not a url"])(
    "drops the link %s", (v) => expect(brandFrom({ TERMS_URL: v, PRIVACY_URL: v }).termsUrl).toBeNull());

  it.each(["no-at-sign", "a@b", "x@y.com\" onmouseover=\"x", "<a@b.com>", "a b@c.com"])(
    "drops the address %s", (v) => expect(brandFrom({ SUPPORT_EMAIL: v }).supportEmail).toBeNull());
});
