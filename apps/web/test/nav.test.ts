import { projectId, tenantId } from "@supahound/core/tenancy/scope";
import { describe, expect, it } from "vitest";
import { canAddProjects, initialOf, projectNav, projectPath, SOON, utc, workspaceNav, workspacePath } from "../lib/nav";

const T = tenantId("aaaaaaaa-0000-4000-8000-000000000001");
const P = projectId("bbbbbbbb-0000-4000-8000-000000000002");
const base = `/w/${T}/p/${P}`;

describe("project navigation (issue #98)", () => {
  it("puts the project in the URL for every project page", () => {
    expect(projectPath(T, P)).toBe(base);
    expect(projectPath(T, P, "incidents")).toBe(`${base}/incidents`);
    expect(projectPath(T, P, "posture")).toBe(`${base}/posture`);
    expect(projectPath(T, P, "findings")).toBe(`${base}/findings`);
    expect(projectPath(T, P, "general")).toBe(`${base}/settings`);
    expect(projectPath(T, P, "notifications")).toBe(`${base}/settings/notifications`);
    expect(projectPath(T, P, "plan")).toBe(`${base}/settings/plan`);
    expect(projectPath(T, P, "people")).toBe(`${base}/settings/people`);
  });

  it("lists the project pages in order, with settings in their own group", () => {
    const [main, settings] = projectNav(T, P, "dashboard");
    expect(main!.label).toBeNull();
    expect(main!.items.map((i) => i.label)).toEqual(["Dashboard", "Incidents", "Posture", "Security scan"]);
    expect(settings!.label).toBe("Settings");
    expect(settings!.items.map((i) => i.label)).toEqual(["General", "Notifications", "Plan & billing", "People"]);
  });

  it("marks exactly one item current", () => {
    for (const page of ["dashboard", "incidents", "posture", "findings", "general", "notifications", "plan", "people"] as const) {
      const current = projectNav(T, P, page).flatMap((g) => g.items).filter((i) => i.current);
      expect(current.map((i) => i.href)).toEqual([projectPath(T, P, page)]);
    }
  });

  it("badges only the placeholder pages as Soon", () => {
    const soon = projectNav(T, P, "dashboard").flatMap((g) => g.items).filter((i) => i.soon).map((i) => i.label);
    // People shipped with issue #24.
    expect(soon).toEqual(["Security scan"]);
    expect([...SOON].sort()).toEqual(["findings"]);
  });

  it("shows workspace billing only when billing is on", () => {
    expect(workspaceNav(T, "overview", true).items.map((i) => i.label)).toEqual(["Overview", "Projects", "Billing"]);
    expect(workspaceNav(T, "overview", false).items.map((i) => i.label)).toEqual(["Overview", "Projects"]);
    expect(workspaceNav(T, null, true).items.some((i) => i.current)).toBe(false);
    expect(workspacePath(T)).toBe(`/w/${T}`);
    expect(workspacePath(T, "billing")).toBe(`/w/${T}/billing`);
  });

  it("offers Add project to owners and admins only", () => {
    expect(canAddProjects("owner")).toBe(true);
    expect(canAddProjects("admin")).toBe(true);
    expect(canAddProjects("member")).toBe(false);
  });

  it("draws the tile letter from the first letter or digit", () => {
    expect(initialOf("shop")).toBe("S");
    expect(initialOf("  -my app")).toBe("M");
    expect(initialOf("9lives")).toBe("9");
    expect(initialOf("élan")).toBe("É");
    expect(initialOf("---")).toBe("?");
  });

  it("formats times in UTC to the minute", () => {
    expect(utc(new Date("2026-11-11T17:03:59.999Z"))).toBe("2026-11-11 17:03 UTC");
  });
});
