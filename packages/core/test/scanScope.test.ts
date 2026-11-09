import { describe, expect, it } from "vitest";
import {
  assertInScope,
  assertScannableApex,
  hostInScope,
  isDeniedApex,
  registrableApex,
  ScopeError,
} from "../src/scan/scope.js";

describe("registrableApex", () => {
  it.each([
    ["example.com", "example.com"],
    ["https://example.com/path?q=1", "example.com"],
    ["https://App.Example.COM", "example.com"],
    ["api.staging.example.com", "example.com"],
    ["example.co.uk", "example.co.uk"],
    ["shop.example.co.uk", "example.co.uk"],
    ["example.com.", "example.com"],
    ["example.com:8443", "example.com"],
  ])("reads the registrable apex of %s", (input, apex) => {
    expect(registrableApex(input)).toBe(apex);
  });

  it.each([
    ["", "empty"],
    ["   ", "blank"],
    ["localhost", "no public suffix"],
    ["192.168.0.1", "IPv4"],
    ["https://10.0.0.5:3000", "IPv4 URL"],
    ["[2001:db8::1]", "IPv6"],
    ["com", "bare suffix"],
    ["co.uk", "bare multi-part suffix"],
  ])("returns null for %s (%s)", (input) => {
    expect(registrableApex(input)).toBeNull();
  });
});

describe("isDeniedApex", () => {
  it.each(["google.com", "amazonaws.com", "supabase.co", "vercel.app", "github.com"])(
    "denies the major platform %s",
    (apex) => expect(isDeniedApex(apex)).toBe(true),
  );

  it.each(["whitehouse.gov", "army.mil", "service.gov.uk", "example.gouv.fr", "city.go.jp"])(
    "denies the public-sector domain %s",
    (apex) => expect(isDeniedApex(apex)).toBe(true),
  );

  it.each(["example.com", "acme.io", "my-startup.dev", "example.co.uk"])(
    "allows the ordinary domain %s",
    (apex) => expect(isDeniedApex(apex)).toBe(false),
  );
});

describe("assertScannableApex", () => {
  it("normalizes a URL to its apex", () => {
    expect(assertScannableApex("https://App.Example.com/login")).toBe("example.com");
  });

  it("refuses an IP address", () => {
    expect(() => assertScannableApex("https://203.0.113.9")).toThrow(ScopeError);
  });

  it("refuses a protected domain even though the shape is valid", () => {
    expect(() => assertScannableApex("https://login.microsoft.com")).toThrow(/protected/);
  });
});

describe("hostInScope", () => {
  it.each([
    ["example.com", "example.com", true],
    ["api.example.com", "example.com", true],
    ["a.b.example.com", "example.com", true],
    ["example.com.", "example.com", true],
    ["API.Example.com", "example.com", true],
    ["notexample.com", "example.com", false],
    ["example.com.evil.test", "example.com", false],
    ["example.org", "example.com", false],
    ["evil-example.com", "example.com", false],
  ])("%s under %s → %s", (host, apex, expected) => {
    expect(hostInScope(host, apex)).toBe(expected);
  });

  it("throws for an out-of-scope target", () => {
    expect(() => assertInScope("example.com.evil.test", "example.com")).toThrow(ScopeError);
  });

  it("does not throw for an in-scope target", () => {
    expect(() => assertInScope("api.example.com", "example.com")).not.toThrow();
  });
});
