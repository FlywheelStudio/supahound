import { projectId, tenantId } from "@supahound/core/tenancy/scope";
import { describe, expect, it } from "vitest";
import { ALERT_LEVEL_LABEL, handleAlertSetting } from "../lib/alerts";

const T = tenantId("aaaaaaaa-0000-4000-8000-000000000001");
const P = projectId("bbbbbbbb-0000-4000-8000-000000000002");
const SETTINGS = `/w/${T}/p/${P}/settings/notifications`;

function deps(role: "owner" | "admin" | "editor" | "viewer", updated = true) {
  const applied: string[] = [];
  return {
    applied,
    deps: {
      apply: async (level: string) => {
        applied.push(level);
        const allowed = role !== "viewer";
        return { allowed, updated: allowed ? updated : false };
      },
    },
  };
}

describe("email alert threshold setting", () => {
  it("saves a valid level for owners, admins and editors", async () => {
    for (const role of ["owner", "admin", "editor"] as const) {
      const d = deps(role);
      expect(await handleAlertSetting(T, P, "high", d.deps)).toBe(`${SETTINGS}?alerts=high`);
      expect(d.applied).toEqual(["high"]);
    }
  });

  it("refuses viewers", async () => {
    const d = deps("viewer");
    expect(await handleAlertSetting(T, P, "off", d.deps)).toBe(`${SETTINGS}?error=alerts_role`);
  });

  it("rejects a level that is not on the list, before any database call", async () => {
    for (const bad of ["none", "", null, "HIGH", "low; DROP TABLE"]) {
      const d = deps("owner");
      expect(await handleAlertSetting(T, P, bad, d.deps)).toBe(`${SETTINGS}?error=alerts_level`);
      expect(d.applied).toEqual([]);
    }
  });

  it("reports a project that is not in the workspace", async () => {
    const d = deps("owner", false);
    expect(await handleAlertSetting(T, P, "low", d.deps)).toBe(`/w/${T}/projects?error=alerts_missing`);
  });

  it("labels every level, with every incident as the default", () => {
    expect(Object.keys(ALERT_LEVEL_LABEL)).toEqual(["low", "medium", "high", "critical", "off"]);
    expect(ALERT_LEVEL_LABEL.low).toBe("Every incident");
  });
});
