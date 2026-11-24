import type { MarkOutcome } from "@supahound/core/db/detectionSettings";
import type { ProjectRole } from "@supahound/core/db/people";
import { projectId, tenantId } from "@supahound/core/tenancy/scope";
import { describe, expect, it } from "vitest";
import {
  canMarkExpected, expectedNoticeFrom, handleMarkExpected, handleUnmarkExpected, markableNetworks,
} from "../lib/detectionSettings";

// Expected networks for the service-role detector (issue #185, decision 050).

const T = tenantId("aaaaaaaa-0000-4000-8000-000000000001");
const P = projectId("bbbbbbbb-0000-4000-8000-000000000002");
const BACK = `/w/${T}/p/${P}/settings/notifications`;
const ROLES: ProjectRole[] = ["owner", "admin", "editor", "viewer"];

describe("expected networks", () => {
  it("lets only owners and admins mark", () => {
    expect(ROLES.filter(canMarkExpected)).toEqual(["owner", "admin"]);
    expect(canMarkExpected(null)).toBe(false);
  });

  const marker = (role: ProjectRole, outcome: MarkOutcome = "marked") => {
    const calls: string[] = [];
    return {
      calls,
      deps: {
        mark: async (n: string) => {
          calls.push(n);
          return canMarkExpected(role) ? { allowed: true, outcome } : { allowed: false, outcome: null };
        },
        unmark: async (n: string) => {
          calls.push(n);
          return canMarkExpected(role) ? { allowed: true, removed: outcome === "marked" } : { allowed: false, removed: false };
        },
      },
    };
  };

  it("marks and unmarks for owners and admins, and lands on the Notifications page", async () => {
    for (const role of ["owner", "admin"] as const) {
      const m = marker(role);
      expect(await handleMarkExpected(T, P, "example telecom ag", m.deps)).toBe(`${BACK}?expected=marked#expected-networks`);
      expect(await handleUnmarkExpected(T, P, "example telecom ag", m.deps)).toBe(`${BACK}?expected=unmarked#expected-networks`);
      expect(m.calls).toEqual(["example telecom ag", "example telecom ag"]);
    }
    expect(await handleMarkExpected(T, P, "railway", marker("owner", "already").deps)).toBe(`${BACK}?expected=already#expected-networks`);
    expect(await handleUnmarkExpected(T, P, "railway", marker("owner", "already").deps)).toBe(`${BACK}?expected=not_marked#expected-networks`);
  });

  it("refuses editors and viewers", async () => {
    for (const role of ["editor", "viewer"] as const) {
      expect(await handleMarkExpected(T, P, "railway", marker(role).deps)).toBe(`${BACK}?expected=role#expected-networks`);
      expect(await handleUnmarkExpected(T, P, "railway", marker(role).deps)).toBe(`${BACK}?expected=role#expected-networks`);
    }
  });

  it("rejects a name that is not normalized, before any database call", async () => {
    for (const bad of ["Railway", "two  spaces", "<script>", "", null, 7]) {
      const m = marker("owner");
      expect(await handleMarkExpected(T, P, bad, m.deps)).toBe(`${BACK}?expected=invalid#expected-networks`);
      expect(await handleUnmarkExpected(T, P, bad, m.deps)).toBe(`${BACK}?expected=invalid#expected-networks`);
      expect(m.calls).toEqual([]);
    }
  });

  it("shows only known notices", () => {
    expect(expectedNoticeFrom({ expected: "marked" })?.tone).toBe("ok");
    expect(expectedNoticeFrom({ expected: "role" })?.tone).toBe("error");
    expect(expectedNoticeFrom({ expected: "<b>hi</b>" })).toBeNull();
    expect(expectedNoticeFrom({ expected: "constructor" })).toBeNull();
    expect(expectedNoticeFrom({})).toBeNull();
  });

  it("offers a network on the incident page only with a network signal, and never a marked one", () => {
    const nets = ["example telecom ag", "railway"];
    expect(markableNetworks({ signals: ["non_hosting_network"] }, nets, new Set())).toEqual(nets);
    expect(markableNetworks({ signals: ["new_network"] }, nets, new Set(["railway"]))).toEqual(["example telecom ag"]);
    expect(markableNetworks({ signals: ["browser_caller"] }, nets, new Set())).toEqual([]);
    expect(markableNetworks({ signals: ["manual_tool"] }, nets, new Set())).toEqual([]);
  });
});
