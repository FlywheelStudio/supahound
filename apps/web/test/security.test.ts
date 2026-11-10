import { describe, expect, it } from "vitest";
import { currentStep, onboardingSteps } from "../lib/onboarding";
import { escapeHtml, isSafeMethod, isSameOrigin, safeNext } from "../lib/security";

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

describe("escapeHtml", () => {
  it("escapes markup characters", () => {
    expect(escapeHtml(`<a href="x">'&'</a>`)).toBe("&lt;a href=&quot;x&quot;&gt;&#39;&amp;&#39;&lt;/a&gt;");
  });
});

describe("onboarding steps", () => {
  it("walks the steps in order from data", () => {
    expect(currentStep(onboardingSteps({ hasWorkspace: false, connections: 0, projects: 0 }))?.id).toBe("workspace");
    expect(currentStep(onboardingSteps({ hasWorkspace: true, connections: 0, projects: 0 }))?.id).toBe("connect");
    expect(currentStep(onboardingSteps({ hasWorkspace: true, connections: 1, projects: 0 }))?.id).toBe("projects");
    expect(currentStep(onboardingSteps({ hasWorkspace: true, connections: 1, projects: 2 }))?.id).toBe("plan");
  });
});

describe("authCopy", () => {
  it("reads as sign-in by default and as sign-up from marketing CTAs", async () => {
    const { authCopy } = await import("../lib/signup");
    expect(authCopy({}).heading).toBe("Sign in to Supahound");
    expect(authCopy({ signup: "1" }).heading).toBe("Create your free Supahound account");
    expect(authCopy({ signup: "1", plan: "builder" }).plan).toContain("paid plan");
    expect(authCopy({ signup: "1", plan: "free" }).plan).toBeUndefined();
    expect(authCopy({ plan: "builder" }).heading).toBe("Create your free Supahound account");
  });

  // Prices and plan names live on the marketing site (decision 025). The app never echoes the
  // plan parameter, so a crafted link cannot put text on the page.
  it("never echoes the plan id and names no price", async () => {
    const { authCopy } = await import("../lib/signup");
    const plan = authCopy({ signup: "1", plan: "<b>free money</b>" }).plan ?? "";
    expect(plan).not.toContain("free money");
    expect(plan).not.toMatch(/\$\d/);
  });
});
