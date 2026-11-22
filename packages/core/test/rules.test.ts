import { describe, expect, it } from "vitest";
import { detectCrossTenant } from "../src/detectors/crossTenant.js";
import {
  ATTACK_TECHNIQUES, DETECTION_RULES, DETECTOR_SIGNALS, findingRuleIds, incidentRuleIds, OWASP_API_2023, ruleFor,
} from "../src/detectors/rules.js";
import { detectServiceRoleMisuse, ServiceRoleNetworks } from "../src/detectors/serviceRole.js";
import { ownershipFromColumns } from "../src/ownership/ownership.js";
import { raiseForPosture } from "../src/posture/findings.js";
import { projectScope } from "../src/tenancy/scope.js";
import { BOB, CHROME_UA, event, serviceEvent } from "./helpers.js";

const SCOPE = projectScope("aaaaaaaa-0000-4000-8000-000000000001", "11111111-0000-4000-8000-0000000000aa");

describe("detection rules", () => {
  it("has a rule for every signal of every detector", () => {
    const missing = Object.entries(DETECTOR_SIGNALS).flatMap(([detector, signals]) =>
      signals.filter((s) => ruleFor(detector, s) === null).map((s) => `${detector}/${s}`));
    expect(missing).toEqual([]);
    // And no rule for a signal no detector emits.
    const known = new Set(Object.entries(DETECTOR_SIGNALS).flatMap(([d, signals]) => signals.map((s) => `${d}|${s}`)));
    expect(DETECTION_RULES.filter((r) => !known.has(`${r.detector}|${r.signal}`))).toEqual([]);
  });

  it("gives every rule a unique, well-formed ID", () => {
    const ids = DETECTION_RULES.map((r) => r.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const id of ids) expect(id).toMatch(/^SH-D\d+-\d{3}$/);
  });

  it("keeps signal names unique across detectors, so incident signals map to one rule", () => {
    const signals = DETECTION_RULES.map((r) => r.signal);
    expect(new Set(signals).size).toBe(signals.length);
  });

  it("tags every rule with known ATT&CK techniques and OWASP API 2023 categories", () => {
    for (const r of DETECTION_RULES) {
      expect(r.attack.length, r.id).toBeGreaterThan(0);
      expect(r.owaspApi.length, r.id).toBeGreaterThan(0);
      for (const t of r.attack) {
        expect(ATTACK_TECHNIQUES[t], `${r.id} ${t}`).toBeDefined();
        expect(t).toMatch(/^T\d{4}(\.\d{3})?$/);
        // A sub-technique's parent is in the catalog too, for the OCSF technique object.
        if (t.includes(".")) expect(ATTACK_TECHNIQUES[t.split(".")[0] as keyof typeof ATTACK_TECHNIQUES]).toBeDefined();
      }
      for (const o of r.owaspApi) expect(OWASP_API_2023[o], `${r.id} ${o}`).toBeDefined();
      expect(r.title.length).toBeGreaterThan(0);
      expect(r.falsePositives.length).toBeGreaterThan(0);
    }
  });

  it("maps the issue's examples", () => {
    expect(ruleFor("cross_tenant", "other_owner")).toMatchObject({ id: "SH-D2-001", attack: ["T1078"], owaspApi: ["API1:2023"] });
    expect(ruleFor("service_role_misuse", "browser_caller")?.attack).toContain("T1552.001");
    expect(ruleFor("service_role_misuse", "new_network")?.attack).toContain("T1078.004");
  });

  it("derives rule IDs from real detector output, without a stored field", () => {
    const ownership = ownershipFromColumns({ notes: ["user_id"] });
    const cross = detectCrossTenant(event({ search: `user_id=eq.${BOB}` }), ownership)!;
    expect(findingRuleIds(cross)).toEqual(["SH-D2-001"]);
    const [raised] = raiseForPosture([cross], new Map([["notes", "rls_disabled"]]));
    expect(findingRuleIds(raised!)).toEqual(["SH-D2-001", "SH-D2-007"]);

    const [service] = detectServiceRoleMisuse([serviceEvent({ userAgent: CHROME_UA, clientInfo: null })], {
      scope: SCOPE, networks: new ServiceRoleNetworks(),
    });
    expect(findingRuleIds(service!)).toEqual(["SH-D4-001"]);

    expect(incidentRuleIds({ detectors: ["cross_tenant", "service_role_misuse"], signals: ["browser_caller", "other_owner"] }))
      .toEqual(["SH-D2-001", "SH-D4-001"]);
  });

  it("skips unknown signals and signals under the wrong detector", () => {
    expect(incidentRuleIds({ detectors: ["cross_tenant"], signals: ["browser_caller", "retired_signal"] })).toEqual([]);
  });
});
