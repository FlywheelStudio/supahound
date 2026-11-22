import { describe, expect, it } from "vitest";
import { currentStep, onboardingSteps } from "../lib/onboarding";
import {
  contentSecurityPolicy,
  escapeHtml,
  isSafeMethod,
  isSameOrigin,
  newNonce,
  safeNext,
  securityHeaders,
  setSecurityHeaders,
} from "../lib/security";

const APP = "https://app.supahound.example";
const req = (origin?: string) => new Request(`${APP}/x`, { method: "POST", headers: origin ? { origin } : {} });

describe("origin check", () => {
  it("accepts only the app's own origin on state-changing requests", () => {
    expect(isSameOrigin(req(APP), APP)).toBe(true);
    expect(isSameOrigin(req("https://evil.example"), APP)).toBe(false);
    expect(isSameOrigin(req("https://app.supahound.example.evil.example"), APP)).toBe(false);
    expect(isSameOrigin(req("null"), APP)).toBe(false);
    expect(isSameOrigin(req(), APP)).toBe(false);
    expect(["GET", "HEAD", "OPTIONS"].every(isSafeMethod)).toBe(true);
    expect(["POST", "PUT", "PATCH", "DELETE"].some(isSafeMethod)).toBe(false);
  });
});

describe("safeNext", () => {
  it.each([
    ["/w/123", "/w/123"],
    [null, "/app"],
    ["https://evil.example", "/app"],
    ["//evil.example", "/app"],
    ["/\\evil.example", "/app"],
    ["javascript:alert(1)", "/app"],
  ])("maps %s to %s", (input, expected) => {
    expect(safeNext(input)).toBe(expected);
  });
});

// Issue #143. The E2E spec (e2e/specs/public.spec.ts) checks the same headers on the built Worker
// and that the page hydrates with no CSP violation.
describe("security headers", () => {
  const directives = (csp: string) =>
    new Map(csp.split(";").map((d) => d.trim().split(/\s+/)).map(([name, ...values]) => [name!, values]));

  it("sends HSTS, nosniff, no framing, a strict referrer and a minimal Permissions-Policy", () => {
    const h = securityHeaders("n0nce");
    expect(h["Strict-Transport-Security"]).toBe("max-age=31536000; includeSubDomains");
    expect(h["X-Content-Type-Options"]).toBe("nosniff");
    expect(h["X-Frame-Options"]).toBe("DENY");
    expect(h["Referrer-Policy"]).toBe("strict-origin-when-cross-origin");
    for (const feature of ["camera", "microphone", "geolocation", "payment"]) {
      expect(h["Permissions-Policy"]).toContain(`${feature}=()`);
    }
    expect(h["Content-Security-Policy"]).toBe(contentSecurityPolicy("n0nce"));
  });

  it("allows scripts only from this origin or with this response's nonce", () => {
    const csp = directives(contentSecurityPolicy("abc123=="));
    expect(csp.get("script-src")).toEqual(["'self'", "'nonce-abc123=='"]);
    expect(csp.get("default-src")).toEqual(["'self'"]);
    expect(csp.get("frame-ancestors")).toEqual(["'none'"]);
    expect(csp.get("object-src")).toEqual(["'none'"]);
    expect(csp.get("base-uri")).toEqual(["'none'"]);
    expect(csp.get("connect-src")).toEqual(["'self'"]);
    // Nothing anywhere re-opens inline or eval'd script.
    expect(csp.get("script-src")).not.toContain("'unsafe-inline'");
    expect([...csp.values()].flat()).not.toContain("'unsafe-eval'");
  });

  it("allows eval only in vite dev, for React's development build", () => {
    expect(contentSecurityPolicy("n", true)).toContain("script-src 'self' 'nonce-n' 'unsafe-eval';");
    expect(securityHeaders("n")["Content-Security-Policy"]).not.toContain("unsafe-eval");
  });

  it("makes a new 128-bit nonce each time, safe to put in a header and an HTML attribute", () => {
    const nonces = new Set(Array.from({ length: 50 }, newNonce));
    expect(nonces.size).toBe(50);
    for (const n of nonces) {
      expect(n).toMatch(/^[A-Za-z0-9+/]{22}==$/);
      expect(atob(n)).toHaveLength(16);
    }
  });

  it("sets every header on a response, replacing what was there", () => {
    const headers = new Headers({ "X-Frame-Options": "SAMEORIGIN", "Cache-Control": "private, no-store" });
    setSecurityHeaders(headers, "n0nce");
    expect(headers.get("X-Frame-Options")).toBe("DENY");
    expect(headers.get("Cache-Control")).toBe("private, no-store");
    expect(headers.get("Content-Security-Policy")).toContain("'nonce-n0nce'");
  });
});

describe("escapeHtml", () => {
  it("escapes markup characters", () => {
    expect(escapeHtml(`<a href="x">'&'</a>`)).toBe("&lt;a href=&quot;x&quot;&gt;&#39;&amp;&#39;&lt;/a&gt;");
  });
});

describe("onboarding steps", () => {
  it("walks the steps in order from data, with the card right after the workspace (decision 028)", () => {
    const at = (st: Parameters<typeof onboardingSteps>[0]) => currentStep(onboardingSteps(st))?.id;
    expect(at({ hasWorkspace: false, hasCard: false, connections: 0, projects: 0 })).toBe("workspace");
    expect(at({ hasWorkspace: true, hasCard: false, connections: 0, projects: 0 })).toBe("card");
    expect(at({ hasWorkspace: true, hasCard: true, connections: 0, projects: 0 })).toBe("connect");
    expect(at({ hasWorkspace: true, hasCard: true, connections: 1, projects: 0 })).toBe("projects");
    expect(at({ hasWorkspace: true, hasCard: true, connections: 1, projects: 2 })).toBe("alerts");
  });

  it("leaves the card step out when billing is off", () => {
    const steps = onboardingSteps({ hasWorkspace: true, hasCard: null, connections: 0, projects: 0 });
    expect(steps.map((s) => s.id)).not.toContain("card");
    expect(currentStep(steps)?.id).toBe("connect");
  });
});

describe("authCopy", () => {
  it("reads as sign-in by default and as sign-up from marketing CTAs", async () => {
    const { authCopy } = await import("../lib/signup");
    expect(authCopy({}, true).heading).toBe("Sign in to Supahound");
    expect(authCopy({ signup: "1" }, true).heading).toBe("Create your Supahound account");
    expect(authCopy({ plan: "builder" }, true).heading).toBe("Create your Supahound account");
  });

  // Decision 028: with billing on, sign-up says a card comes next and never promises "free" or
  // "no credit card". With billing off (self-hosting), it says nothing about cards.
  it("tells a new user a card is required when billing is on, and nothing about cards when off", async () => {
    const { authCopy } = await import("../lib/signup");
    const on = authCopy({ signup: "1" }, true);
    expect(on.plan).toContain("add a card");
    expect(on.plan).toContain("$1 hold");
    for (const text of [on.heading, on.note, on.plan ?? ""]) expect(text).not.toMatch(/no credit card|free account/i);
    const off = authCopy({ signup: "1" }, false);
    expect(off.plan).toBeUndefined();
    expect(`${off.heading} ${off.note}`).not.toMatch(/card/i);
  });

  // Prices and plan names live on the marketing site (decision 025). The app never echoes the
  // plan parameter, so a crafted link cannot put text on the page.
  it("never echoes the plan id and names no price", async () => {
    const { authCopy } = await import("../lib/signup");
    for (const cardRequired of [true, false]) {
      const plan = authCopy({ signup: "1", plan: "<b>free money</b>" }, cardRequired).plan ?? "";
      expect(plan).not.toContain("free money");
      expect(plan).not.toMatch(/\$(?!1 hold)\d/); // the $1 hold is the only amount named
    }
  });
});
