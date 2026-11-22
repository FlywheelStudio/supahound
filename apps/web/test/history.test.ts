import { ENTERPRISE_HISTORY, STANDARD_HISTORY } from "@supahound/core/billing/history";
import { describe, expect, it } from "vitest";
import { ENTERPRISE_DETAIL, historyLine, windowPhrase } from "../lib/history";

// Decision 048: how the pages name a workspace's history window.
describe("history window text", () => {
  it("reads 'the last 30 days' on the standard plan and 'the last year' on Enterprise", () => {
    expect(`the last ${windowPhrase(STANDARD_HISTORY.incidentDays)}`).toBe("the last 30 days");
    expect(`the last ${windowPhrase(STANDARD_HISTORY.securityEventDays)}`).toBe("the last 90 days");
    expect(`the last ${windowPhrase(ENTERPRISE_HISTORY.incidentDays)}`).toBe("the last year");
  });

  it("shows '1-year history' on the plan page for Enterprise only", () => {
    expect(historyLine(ENTERPRISE_HISTORY)).toMatch(/^1-year history/);
    expect(historyLine(STANDARD_HISTORY)).toBe("30-day incident history and a 90-day security log. Enterprise keeps a year.");
    expect(historyLine(STANDARD_HISTORY)).not.toMatch(/1-year/);
  });

  it("lists 1-year history on the Enterprise price card", () => {
    expect(ENTERPRISE_DETAIL).toContain("1-year history");
    expect(ENTERPRISE_DETAIL).toContain("Above 10 million requests");
  });
});
