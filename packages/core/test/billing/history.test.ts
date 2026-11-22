import { describe, expect, it } from "vitest";
import { checkWindowDays, ENTERPRISE_HISTORY, historyWindowFor, STANDARD_HISTORY } from "../../src/billing/history.js";
import { INCIDENT_HISTORY_DAYS } from "../../src/db/repo.js";
import { RETENTION_DAYS } from "../../src/db/retention.js";
import { SECURITY_EVENT_DAYS } from "../../src/db/securityEvents.js";

// Decision 048: the history window per plan.
describe("historyWindowFor", () => {
  it("keeps today's windows for every workspace that is neither Enterprise nor staff-exempt", () => {
    expect(historyWindowFor({ enterpriseAt: null, exempt: false })).toEqual({ plan: "standard", incidentDays: 30, securityEventDays: 90 });
    // The standard window is the one decisions 035, 037 and 044 already use.
    expect([INCIDENT_HISTORY_DAYS, RETENTION_DAYS, SECURITY_EVENT_DAYS])
      .toEqual([STANDARD_HISTORY.incidentDays, STANDARD_HISTORY.incidentDays, STANDARD_HISTORY.securityEventDays]);
  });

  it("gives a year of incidents, findings and security events to Enterprise and to staff-exempt workspaces", () => {
    expect(historyWindowFor({ enterpriseAt: new Date(), exempt: false })).toEqual({ plan: "enterprise", incidentDays: 365, securityEventDays: 365 });
    expect(historyWindowFor({ enterpriseAt: null, exempt: true })).toBe(ENTERPRISE_HISTORY);
  });

  it("lets only a small whole number of days reach SQL", () => {
    expect(checkWindowDays(365)).toBe(365);
    for (const bad of [0, -1, 1.5, Number.NaN, 3661, Number.POSITIVE_INFINITY]) expect(() => checkWindowDays(bad)).toThrow(/out of range/);
  });
});
