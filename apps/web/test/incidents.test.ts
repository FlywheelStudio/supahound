import { projectId, tenantId } from "@supahound/core/tenancy/scope";
import { describe, expect, it } from "vitest";
import {
  codeSegments, durationLabel, encodeCursor, explanationOf, fallbackSummary, parseCursor, parseIncidentId,
} from "../lib/incidents";
import { incidentPath } from "../lib/nav";

const ID = "0f8fad5b-d9cb-469f-a165-70867728950e";

describe("incident history helpers (issue #44)", () => {
  it("builds the detail path under the project's incidents page", () => {
    const t = tenantId("aaaaaaaa-0000-4000-8000-000000000001");
    const p = projectId("bbbbbbbb-0000-4000-8000-000000000002");
    expect(incidentPath(t, p, ID)).toBe(`/w/${t}/p/${p}/incidents/${ID}`);
  });

  it("accepts only a UUID as an incident ID", () => {
    expect(parseIncidentId(ID)).toBe(ID);
    expect(parseIncidentId(ID.toUpperCase())).toBe(ID);
    for (const bad of ["", "not-a-uuid", `${ID}x`, `${ID}' OR 1=1`, "0f8fad5b-d9cb-469f-a165-70867728950"]) {
      expect(parseIncidentId(bad), bad).toBeNull();
    }
  });

  it("round-trips a cursor and keeps the microseconds", () => {
    const c = { lastSeenUs: "1794571200123456", id: ID };
    expect(parseCursor(encodeCursor(c))).toEqual(c);
  });

  it("reads no cursor as the first page and a malformed one as invalid", () => {
    expect(parseCursor(undefined)).toBeNull();
    for (const bad of ["", "_", "123", `abc_${ID}`, `0123_${ID}`, `1_${ID}_x`, `1_not-a-uuid`, `${"9".repeat(18)}_${ID}`, `-5_${ID}`]) {
      expect(parseCursor(bad), bad).toBe("invalid");
    }
    expect(parseCursor([`1_${ID}`, `2_${ID}`])).toBe("invalid");
  });

  it("keeps a stored explanation's shape and cleans its text", () => {
    const e = explanationOf({
      summary: "A user read rows in `notes`. See https://evil.example/x",
      likelyImpact: "Other users'\u0000 data may be exposed.",
      nextSteps: ["Check the RLS policy on `notes`.", 42, "", "b", "c", "d", "e", "f"],
    });
    expect(e?.summary).toBe("A user read rows in `notes`. See");
    expect(e?.likelyImpact).toBe("Other users' data may be exposed.");
    expect(e?.nextSteps).toEqual(["Check the RLS policy on `notes`.", "b", "c", "d"]);
    expect(explanationOf({ summary: "x".repeat(700) })?.summary.length).toBe(600);
  });

  it("treats a missing or malformed explanation as none", () => {
    for (const bad of [null, undefined, "text", 3, [], {}, { summary: 1 }, { summary: "   " }]) {
      expect(explanationOf(bad), JSON.stringify(bad)).toBeNull();
    }
    expect(explanationOf({ summary: "Only a summary." })).toEqual({ summary: "Only a summary.", likelyImpact: "", nextSteps: [] });
  });

  it("splits backticked identifiers into code segments", () => {
    expect(codeSegments("Compare `user_id` to `auth.uid()` now")).toEqual([
      { text: "Compare ", code: false }, { text: "user_id", code: true }, { text: " to ", code: false },
      { text: "auth.uid()", code: true }, { text: " now", code: false },
    ]);
    expect(codeSegments("no code")).toEqual([{ text: "no code", code: false }]);
    expect(codeSegments("`a`")).toEqual([{ text: "a", code: true }]);
    expect(codeSegments("an ` unmatched tick")).toEqual([{ text: "an ` unmatched tick", code: false }]);
  });

  it("labels durations", () => {
    const t = new Date("2026-11-12T10:00:00Z");
    const plus = (min: number) => new Date(t.getTime() + min * 60_000);
    expect(durationLabel(t, t)).toBe("under a minute");
    expect(durationLabel(t, plus(1))).toBe("1 minute");
    expect(durationLabel(t, plus(12))).toBe("12 minutes");
    expect(durationLabel(t, plus(120))).toBe("2 h");
    expect(durationLabel(t, plus(185))).toBe("3 h 5 min");
    expect(durationLabel(plus(5), t)).toBe("under a minute");
  });

  it("builds a fallback summary from counts only", () => {
    expect(fallbackSummary({ hits: 1, findingCount: 1 })).toMatch(/^1 request in 1 finding\./);
    expect(fallbackSummary({ hits: 1200, findingCount: 3 })).toMatch(/^1,200 requests in 3 findings\./);
  });
});
