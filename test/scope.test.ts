import { describe, expect, it } from "vitest";
import { projectScope, scopeKey, tenantId } from "../src/tenancy/scope.js";

describe("tenancy scope", () => {
  it("accepts UUIDs only and normalizes case", () => {
    expect(tenantId("AAAAAAAA-0000-4000-8000-000000000001")).toBe("aaaaaaaa-0000-4000-8000-000000000001");
    expect(() => tenantId("tenant-a")).toThrow(/UUID/);
    expect(() => tenantId("aaaaaaaa-0000-4000-8000-000000000001' OR '1'='1")).toThrow(/UUID/);
  });

  it("builds a key that includes the tenant", () => {
    const p = "11111111-0000-4000-8000-0000000000aa";
    const a = projectScope("aaaaaaaa-0000-4000-8000-000000000001", p);
    const b = projectScope("bbbbbbbb-0000-4000-8000-000000000002", p);
    expect(scopeKey(a)).not.toBe(scopeKey(b));
    expect(Object.isFrozen(a)).toBe(true);
  });
});
