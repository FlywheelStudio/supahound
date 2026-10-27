import { describe, expect, it } from "vitest";
import type { Finding, Severity } from "../src/detectors/finding.js";
import { applyFindings, scoreIncident } from "../src/incidents/engine.js";
import type { Incident } from "../src/incidents/incident.js";
import { projectScope } from "../src/tenancy/scope.js";

const A1 = projectScope("aaaaaaaa-0000-4000-8000-000000000001", "11111111-0000-4000-8000-0000000000aa");
const A2 = projectScope("aaaaaaaa-0000-4000-8000-000000000001", "22222222-0000-4000-8000-0000000000bb");
const B1 = projectScope("bbbbbbbb-0000-4000-8000-000000000002", "11111111-0000-4000-8000-0000000000aa");
const NOW = new Date("2026-10-27T12:30:00Z");
const at = (min: number) => new Date(NOW.getTime() + min * 60_000).toISOString();

function finding(actor: string, severity: Severity, minute: number, detector: Finding["detector"] = "cross_tenant", hits = 1): Finding {
  return {
    detector, severity, actor, signals: [detector === "cross_tenant" ? "other_owner" : "browser_caller"],
    firstSeen: at(minute), lastSeen: at(minute), hits, evidence: {},
  };
}

function openIncident(scope = A1, over: Partial<Incident> = {}): Incident {
  return {
    id: "inc-1", scope, actor: "user:u1", status: "open", severity: "medium", detectors: ["cross_tenant"],
    signals: ["other_owner"], findingCount: 2, hits: 4, openedAt: new Date(at(-20)), lastSeenAt: new Date(at(-5)), ...over,
  };
}

describe("scoreIncident", () => {
  it("takes the worst finding and raises one level when two detectors fire", () => {
    expect(scoreIncident(["medium", "low"], new Set(["cross_tenant"]))).toBe("medium");
    expect(scoreIncident(["medium"], new Set(["cross_tenant", "service_role_misuse"]))).toBe("high");
    expect(scoreIncident(["critical"], new Set(["cross_tenant", "service_role_misuse"]))).toBe("critical");
  });
});

describe("applyFindings", () => {
  it("opens one incident per actor and pages at high or above", () => {
    const r = applyFindings(A1, [], [finding("user:u1", "critical", -2), finding("user:u1", "medium", -1), finding("user:u2", "medium", -1)], NOW);
    const byActor = Object.fromEntries(r.updates.map((u) => [u.incident.actor, u]));
    expect(byActor["user:u1"]!.incident).toMatchObject({ id: null, severity: "critical", findingCount: 2, hits: 2 });
    expect(byActor["user:u1"]!.notify).toBe(true);
    expect(byActor["user:u2"]!.notify).toBe(false);
  });

  it("updates the open incident inside the window instead of paging again", () => {
    const open = openIncident(A1, { severity: "critical" });
    const r = applyFindings(A1, [open], [finding("user:u1", "critical", -1, "cross_tenant", 3)], NOW);
    expect(r.updates[0]).toMatchObject({ notify: false, incident: { id: "inc-1", findingCount: 3, hits: 7 } });
    expect(r.resolved).toEqual([]);
  });

  it("pages once when an open incident escalates to high", () => {
    const r = applyFindings(A1, [openIncident()], [finding("user:u1", "high", -1)], NOW);
    expect(r.updates[0]).toMatchObject({ notify: true, incident: { id: "inc-1", severity: "high" } });
  });

  it("stacks detectors on the same actor", () => {
    const r = applyFindings(A1, [openIncident()], [finding("user:u1", "medium", -1, "service_role_misuse")], NOW);
    expect(r.updates[0]!.incident).toMatchObject({ severity: "high", detectors: ["cross_tenant", "service_role_misuse"] });
  });

  it("resolves a quiet incident and opens a new one when the actor returns after the window", () => {
    const stale = openIncident(A1, { lastSeenAt: new Date(at(-40)) });
    const r = applyFindings(A1, [stale], [finding("user:u1", "high", -1)], NOW);
    expect(r.resolved).toMatchObject([{ id: "inc-1", status: "resolved" }]);
    expect(r.updates[0]!.incident).toMatchObject({ id: null, findingCount: 1, severity: "high" });
    expect(r.updates[0]!.notify).toBe(true);
  });

  it("never merges findings into another project's or tenant's incident", () => {
    // Same actor string, same Supabase project, different tenant: must throw, never merge.
    expect(() => applyFindings(A1, [openIncident(B1)], [finding("user:u1", "high", -1)], NOW)).toThrow(/another project or tenant/);
    expect(() => applyFindings(A1, [openIncident(A2)], [finding("user:u1", "high", -1)], NOW)).toThrow(/another project or tenant/);
    expect(() => applyFindings(A1, [openIncident(A1, { status: "resolved" })], [], NOW)).toThrow(/open incidents/);
  });

  it("keeps every incident in the engine's scope", () => {
    const r = applyFindings(A1, [], [finding("user:u1", "high", -1)], NOW);
    expect(r.updates[0]!.incident.scope).toBe(A1);
  });
});
