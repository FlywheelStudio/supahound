import type { MarkOutcome } from "@supahound/core/db/detectionSettings";
import type { ProjectRole } from "@supahound/core/db/people";
import type { PostureFinding } from "@supahound/core/posture/types";
import { projectId, tenantId } from "@supahound/core/tenancy/scope";
import { describe, expect, it } from "vitest";
import {
  canMarkPublic, canSetBurst, handleBurstSetting, handleMarkPublic, handleUnmarkPublic, parseBurstHits, publicNoticeFrom,
  publicStatus, savedBurstFrom,
} from "../lib/detectionSettings";

// Per-project detection settings (issue #160, decision 045).

const T = tenantId("aaaaaaaa-0000-4000-8000-000000000001");
const P = projectId("bbbbbbbb-0000-4000-8000-000000000002");
const POSTURE = `/w/${T}/p/${P}/posture`;
const NOTIFICATIONS = `/w/${T}/p/${P}/settings/notifications`;
const ROLES: ProjectRole[] = ["owner", "admin", "editor", "viewer"];

describe("who may change what", () => {
  it("lets owners and admins mark tables, and owners, admins and editors set the burst threshold", () => {
    expect(ROLES.filter(canMarkPublic)).toEqual(["owner", "admin"]);
    expect(ROLES.filter(canSetBurst)).toEqual(["owner", "admin", "editor"]);
    expect([canMarkPublic(null), canSetBurst(null)]).toEqual([false, false]);
  });
});

describe("marking a table intentionally public", () => {
  function deps(role: ProjectRole, outcome: MarkOutcome = "marked", removed = true) {
    const calls: string[] = [];
    return {
      calls,
      mark: {
        mark: async (table: string) => {
          calls.push(table);
          return canMarkPublic(role) ? { allowed: true, outcome } : { allowed: false, outcome: null };
        },
      },
      unmark: {
        unmark: async (table: string) => {
          calls.push(table);
          return canMarkPublic(role) ? { allowed: true, removed } : { allowed: false, removed: false };
        },
      },
    };
  }

  it("marks and unmarks for owners and admins", async () => {
    for (const role of ["owner", "admin"] as const) {
      const d = deps(role);
      expect(await handleMarkPublic(T, P, "prices", d.mark)).toBe(`${POSTURE}?public=marked#public-tables`);
      expect(await handleUnmarkPublic(T, P, "prices", d.unmark)).toBe(`${POSTURE}?public=unmarked#public-tables`);
      expect(d.calls).toEqual(["prices", "prices"]);
    }
    expect(await handleMarkPublic(T, P, "prices", deps("owner", "already").mark)).toBe(`${POSTURE}?public=already#public-tables`);
    expect(await handleUnmarkPublic(T, P, "prices", deps("owner", "marked", false).unmark)).toBe(`${POSTURE}?public=not_marked#public-tables`);
  });

  it("refuses editors and viewers", async () => {
    for (const role of ["editor", "viewer"] as const) {
      expect(await handleMarkPublic(T, P, "prices", deps(role).mark)).toBe(`${POSTURE}?public=role#public-tables`);
      expect(await handleUnmarkPublic(T, P, "prices", deps(role).unmark)).toBe(`${POSTURE}?public=role#public-tables`);
    }
  });

  it("rejects a name that is not a plain identifier, before any database call", async () => {
    for (const bad of ["Prices", "with space", "x'); DROP TABLE y; --", "", "a".repeat(64), null, undefined]) {
      const d = deps("owner");
      expect(await handleMarkPublic(T, P, bad, d.mark)).toBe(`${POSTURE}?public=invalid#public-tables`);
      expect(await handleUnmarkPublic(T, P, bad, d.unmark)).toBe(`${POSTURE}?public=invalid#public-tables`);
      expect(d.calls).toEqual([]);
    }
  });

  it("shows only known notices", () => {
    expect(publicNoticeFrom({ public: "marked" })?.tone).toBe("ok");
    expect(publicNoticeFrom({ public: "role" })?.tone).toBe("error");
    expect(publicNoticeFrom({ public: "<script>" })).toBeNull();
    expect(publicNoticeFrom({ public: "toString" })).toBeNull();
  });
});

describe("how a finding reads on the Posture page", () => {
  const MARKED = new Set(["prices"]);
  const f = (o: Partial<PostureFinding>): PostureFinding => ({
    source: "catalog", check: "rls_disabled", severity: "critical", schema: "public", object: "prices", objectType: "table",
    evidence: { anonPrivileges: ["SELECT"], authenticatedPrivileges: [] }, ...o,
  });

  it("accepts read findings on a marked table, keeps write findings open with a note, and leaves others alone", () => {
    expect(publicStatus(f({}), MARKED)).toBe("accepted");
    expect(publicStatus(f({ evidence: { anonPrivileges: ["SELECT", "DELETE"] } }), MARKED)).toBe("writes_open");
    expect(publicStatus(f({ check: "permissive_policy", evidence: { openCommands: ["SELECT", "UPDATE"] } }), MARKED)).toBe("writes_open");
    expect(publicStatus(f({ check: "graphql_table_exposed", evidence: {} }), MARKED)).toBe("open");
    expect(publicStatus(f({ object: "customers" }), MARKED)).toBe("open");
    expect(publicStatus(f({}), new Set())).toBe("open");
  });
});

describe("the RPC burst threshold", () => {
  function deps(role: ProjectRole, updated = true) {
    const applied: number[] = [];
    return {
      applied,
      deps: {
        apply: async (hits: number) => {
          applied.push(hits);
          const allowed = canSetBurst(role);
          return { allowed, updated: allowed ? updated : false };
        },
      },
    };
  }

  it("parses whole numbers from 10 to 10,000 only", () => {
    expect(["10", " 250 ", "10000", "1,000"].map(parseBurstHits)).toEqual([10, 250, 10_000, 1000]);
    for (const bad of ["9", "10001", "0", "-50", "12.5", "1e3", "abc", "", "0x10", null, 100]) {
      expect(parseBurstHits(bad), String(bad)).toBeNull();
    }
  });

  it("saves for owners, admins and editors", async () => {
    for (const role of ["owner", "admin", "editor"] as const) {
      const d = deps(role);
      expect(await handleBurstSetting(T, P, "300", d.deps)).toBe(`${NOTIFICATIONS}?burst=300#rpc-burst`);
      expect(d.applied).toEqual([300]);
    }
  });

  it("refuses viewers, rejects out-of-range values before any database call, and reports a missing project", async () => {
    expect(await handleBurstSetting(T, P, "300", deps("viewer").deps)).toBe(`${NOTIFICATIONS}?error=burst_role#rpc-burst`);
    const d = deps("owner");
    expect(await handleBurstSetting(T, P, "5", d.deps)).toBe(`${NOTIFICATIONS}?error=burst_range#rpc-burst`);
    expect(await handleBurstSetting(T, P, "20000", d.deps)).toBe(`${NOTIFICATIONS}?error=burst_range#rpc-burst`);
    expect(d.applied).toEqual([]);
    expect(await handleBurstSetting(T, P, "300", deps("owner", false).deps)).toBe(`/w/${T}/projects?error=burst_missing`);
  });

  it("reads the saved value back only when it is in range", () => {
    expect(savedBurstFrom({ burst: "300" })).toBe(300);
    expect(savedBurstFrom({ burst: "99999" })).toBeNull();
    expect(savedBurstFrom({})).toBeNull();
  });
});
