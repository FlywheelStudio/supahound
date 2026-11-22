import { describe, expect, it } from "vitest";
import { fingerprint } from "../src/detectors/finding.js";
import type { Incident } from "../src/incidents/incident.js";
import { incidentToOcsf } from "../src/incidents/ocsf.js";
import { projectScope } from "../src/tenancy/scope.js";
import { BOB } from "./helpers.js";

const TENANT = "aaaaaaaa-0000-4000-8000-000000000001";
const PROJECT = "11111111-0000-4000-8000-0000000000aa";
const USER = "99999999-9999-4999-8999-999999999999";

function incident(over: Partial<Incident> = {}): Incident {
  return {
    id: "cccccccc-0000-4000-8000-000000000003",
    scope: projectScope(TENANT, PROJECT),
    actor: `user:${USER}`,
    status: "open",
    severity: "critical",
    detectors: ["cross_tenant"],
    signals: ["other_owner", "range"],
    findingCount: 3,
    hits: 42,
    openedAt: new Date("2026-10-27T12:00:00Z"),
    lastSeenAt: new Date("2026-10-27T12:10:00Z"),
    ...over,
  };
}

describe("incidentToOcsf", () => {
  it("builds an OCSF 1.5 Detection Finding", () => {
    const o = incidentToOcsf(incident());
    expect(o).toMatchObject({
      class_uid: 2004, category_uid: 2, activity_id: 1, type_uid: 200401,
      severity_id: 5, severity: "Critical", status_id: 1, confidence_id: 3,
      time: Date.parse("2026-10-27T12:10:00Z"), start_time: Date.parse("2026-10-27T12:00:00Z"), count: 42,
      metadata: { version: "1.5.0", product: { name: "Supahound" }, tenant_uid: TENANT },
      cloud: { provider: "Supabase", project_uid: PROJECT },
      osint: [],
    });
    expect(o.finding_info).toMatchObject({
      uid: "cccccccc-0000-4000-8000-000000000003",
      analytic: { uid: "SH-D2-001", type_id: 1, type: "Rule" },
      related_analytics: [{ uid: "SH-D2-005" }],
      types: ["cross_tenant"],
    });
    expect(o.unmapped.rule_ids).toEqual(["SH-D2-001", "SH-D2-005"]);
    expect(o.unmapped.owasp_api).toEqual(["API1:2023"]);
    expect(o.finding_info.tags).toEqual([{ name: "owasp_api_2023", value: "API1:2023 Broken Object Level Authorization" }]);
    expect(o.attacks.map((a) => a.technique?.uid)).toEqual(["T1078", "T1213"]);
    expect(o.finding_info.attacks).toEqual(o.attacks);
  });

  it("splits a sub-technique from its parent and closes a resolved incident", () => {
    const o = incidentToOcsf(incident({
      status: "resolved", severity: "high", actor: "service_role:asn:16509",
      detectors: ["service_role_misuse"], signals: ["browser_caller"],
    }));
    expect(o).toMatchObject({ activity_id: 3, type_uid: 200403, status_id: 4, severity_id: 4 });
    const sub = o.attacks.find((a) => a.sub_technique?.uid === "T1552.001");
    expect(sub).toMatchObject({ technique: { uid: "T1552" }, tactic: { uid: "TA0006" } });
    expect(sub?.sub_technique?.src_url).toBe("https://attack.mitre.org/techniques/T1552/001/");
    expect(o.unmapped).toMatchObject({ actor_kind: "service_role_key", asn: 16509 });
  });

  it("carries no user ID, only a fingerprint, and no free-text signals", () => {
    const o = incidentToOcsf(incident({ signals: ["other_owner", `<script>${BOB}`] }));
    const json = JSON.stringify(o);
    expect(json).not.toContain(USER);
    expect(json).not.toContain(BOB);
    expect(json).not.toContain("<script>");
    expect(o.unmapped).toMatchObject({ actor_kind: "signed_in_user", actor_fingerprint: fingerprint(`user:${USER}`), asn: null });
    expect(o.unmapped.signals).toEqual(["other_owner"]);
  });

  it("names only the incident's own tenant and project", () => {
    const json = JSON.stringify(incidentToOcsf(incident()));
    const uuids = new Set(json.match(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g));
    expect([...uuids].sort()).toEqual([TENANT, PROJECT, "cccccccc-0000-4000-8000-000000000003"].sort());
  });

  it("is deterministic and refuses an unsaved incident", () => {
    expect(incidentToOcsf(incident())).toEqual(incidentToOcsf(incident()));
    expect(incidentToOcsf(incident(), { activity: "update", time: new Date(0) })).toMatchObject({ activity_id: 2, time: 0 });
    expect(() => incidentToOcsf(incident({ id: null }))).toThrow(/saved incident/);
  });
});
