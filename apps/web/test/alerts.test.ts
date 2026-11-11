import { tenantId } from "@supahound/core/tenancy/scope";
import { describe, expect, it } from "vitest";
import { ALERT_LEVEL_LABEL, handleAlertSetting } from "../lib/alerts";

const T = tenantId("aaaaaaaa-0000-4000-8000-000000000001");

function deps(role: "owner" | "admin" | "member", updated = true) {
  const applied: string[] = [];
  return {
    applied,
    deps: {
      apply: async (level: string) => {
        applied.push(level);
        return { role, updated: role === "member" ? false : updated };
      },
    },
  };
}

describe("email alert threshold setting", () => {
  it("saves a valid level for owners and admins", async () => {
    for (const role of ["owner", "admin"] as const) {
      const d = deps(role);
      expect(await handleAlertSetting(T, "high", d.deps)).toBe(`/w/${T}/projects?alerts=high`);
      expect(d.applied).toEqual(["high"]);
    }
  });

  it("refuses members", async () => {
    const d = deps("member");
    expect(await handleAlertSetting(T, "off", d.deps)).toBe(`/w/${T}/projects?error=alerts_role`);
  });

  it("rejects a level that is not on the list, before any database call", async () => {
    for (const bad of ["none", "", null, "HIGH", "low; DROP TABLE"]) {
      const d = deps("owner");
      expect(await handleAlertSetting(T, bad, d.deps)).toBe(`/w/${T}/projects?error=alerts_level`);
      expect(d.applied).toEqual([]);
    }
  });

  it("reports a project that is not in the workspace", async () => {
    const d = deps("owner", false);
    expect(await handleAlertSetting(T, "low", d.deps)).toBe(`/w/${T}/projects?error=alerts_missing`);
  });

  it("labels every level, with every incident as the default", () => {
    expect(Object.keys(ALERT_LEVEL_LABEL)).toEqual(["low", "medium", "high", "critical", "off"]);
    expect(ALERT_LEVEL_LABEL.low).toBe("Every incident");
  });
});
