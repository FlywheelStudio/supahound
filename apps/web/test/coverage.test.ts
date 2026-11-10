import { describe, expect, it } from "vitest";
import { crossTenantNote } from "../lib/coverage";

describe("crossTenantNote", () => {
  it("warns when detector 2 could not assess the project", () => {
    expect(crossTenantNote("unable_to_assess")).toMatchObject({ tone: "warn", text: expect.stringContaining("unable to assess") });
  });

  it("says plainly when there are no owner-scoped tables, without calling the project clean", () => {
    const note = crossTenantNote("no_owned_tables");
    expect(note).toMatchObject({ tone: "info", text: expect.stringContaining("no owner-scoped tables") });
    expect(note!.text).not.toMatch(/clean|no issues|all clear/i);
  });

  it.each(["assessed", null] as const)("adds nothing for %s", (coverage) => {
    expect(crossTenantNote(coverage)).toBeNull();
  });
});
