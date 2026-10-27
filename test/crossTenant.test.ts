import { describe, expect, it } from "vitest";
import { detectCrossTenant, outcomeOf } from "../src/detectors/crossTenant.js";
import type { OwnershipMap } from "../src/ownership/ownership.js";
import { ALICE, BOB, CAROL, event, serviceEvent } from "./helpers.js";

const OWNERSHIP: OwnershipMap = {
  notes: ["user_id"],
  orders: ["user_id"],
  profiles: ["id"],
  messages: ["receiver_id", "sender_id"],
};

const run = (search: string, overrides = {}) =>
  detectCrossTenant(event({ search, ...overrides }), OWNERSHIP);

describe("detectCrossTenant: no alert", () => {
  it("passes a user reading their own rows", () => {
    expect(run(`user_id=eq.${ALICE}`)).toBeNull();
    expect(run(`user_id=in.(${ALICE})`)).toBeNull();
  });

  it("compares IDs case-insensitively", () => {
    const hexId = "abcdef12-3456-4789-abcd-ef1234567890";
    expect(run(`user_id=eq.${hexId.toUpperCase()}`, { jwtSubject: hexId })).toBeNull();
  });

  it("ignores filters on columns that are not ownership columns", () => {
    expect(run(`receiver_id=eq.${BOB}`)).toBeNull(); // notes has no receiver_id owner column
    expect(run(`author_id=eq.${BOB}`, { path: "/rest/v1/posts" })).toBeNull(); // posts not owned
  });

  it("skips the service role, which bypasses RLS by design", () => {
    expect(detectCrossTenant(serviceEvent({ search: `user_id=eq.${BOB}` }), OWNERSHIP)).toBeNull();
  });

  it("skips anon callers, which carry no subject", () => {
    expect(run(`user_id=eq.${BOB}`, { jwtSubject: null, jwtRole: "anon" })).toBeNull();
  });

  it("skips RPC calls, whose parameters are not in the query string", () => {
    expect(run(`user_id=eq.${BOB}`, { path: "/rest/v1/rpc/get_notes" })).toBeNull();
  });

  it("allows filtering by the other party once the caller is pinned on a multi-party table", () => {
    expect(run(`sender_id=eq.${ALICE}&receiver_id=eq.${BOB}`, { path: "/rest/v1/messages" })).toBeNull();
    expect(run(`and=(sender_id.eq.${ALICE},receiver_id.eq.${BOB})`, { path: "/rest/v1/messages" })).toBeNull();
  });
});

describe("detectCrossTenant: alerts", () => {
  it("flags another user's ID on a single-owner table as critical", () => {
    const f = run(`user_id=eq.${BOB}`);
    expect(f).toMatchObject({
      detector: "cross_tenant",
      severity: "critical",
      actor: `user:${ALICE}`,
      signals: ["other_owner"],
      evidence: { table: "notes", column: "user_id", tableShape: "single_owner", foreignIdCount: 1 },
    });
  });

  it("never echoes the foreign ID, only its fingerprint", () => {
    const f = run(`user_id=eq.${BOB}`)!;
    expect(JSON.stringify(f.evidence)).not.toContain(BOB);
    expect(f.evidence.foreignIdFingerprint).toMatch(/^[0-9a-f]{12}$/);
  });

  it("flags an in list that mixes the caller with others", () => {
    const f = run(`user_id=in.(${ALICE},${BOB},${CAROL})`)!;
    expect(f.signals).toEqual(["other_owner"]);
    expect(f.evidence.foreignIdCount).toBe(2);
  });

  it("flags neq on the caller's own ID as all_but_self", () => {
    expect(run(`user_id=neq.${ALICE}`)!.signals).toEqual(["all_but_self"]);
    expect(run(`user_id=not.eq.${ALICE}`)!.signals).toEqual(["all_but_self"]);
    expect(run(`user_id=not.in.(${ALICE})`)!.signals).toEqual(["all_but_self"]);
  });

  it("flags neq on another ID as excludes_other", () => {
    expect(run(`user_id=neq.${BOB}`)!.signals).toEqual(["excludes_other"]);
  });

  it("reads not.neq as eq", () => {
    expect(run(`user_id=not.neq.${ALICE}`)).toBeNull();
    expect(run(`user_id=not.neq.${BOB}`)!.signals).toEqual(["other_owner"]);
  });

  it("flags pattern, range and not-null sweeps over the owner column", () => {
    expect(run("user_id=like.2222*")!.signals).toEqual(["pattern"]);
    expect(run(`user_id=gt.${ALICE}`)!.signals).toEqual(["range"]);
    expect(run("user_id=not.is.null")!.signals).toEqual(["any_owner"]);
  });

  it("flags a foreign ID hidden in an or group even when the caller's ID is beside it", () => {
    expect(run(`or=(user_id.eq.${ALICE},user_id.eq.${BOB})`)!.signals).toEqual(["other_owner"]);
  });

  it("flags URL-encoded foreign IDs", () => {
    expect(run(`user_id=eq.${encodeURIComponent(BOB)}`)).not.toBeNull();
    expect(run(`user%5Fid=eq.${BOB}`)).not.toBeNull();
    expect(run(`or=%28user_id.eq.${BOB}%29`)).not.toBeNull();
  });

  it("flags foreign IDs on an embedded resource", () => {
    const f = run(`select=*,orders(*)&orders.user_id=eq.${BOB}`, { path: "/rest/v1/profiles" })!;
    expect(f.evidence).toMatchObject({ table: "orders", column: "user_id" });
  });

  it("flags a profile lookup by another user's id", () => {
    expect(run(`id=eq.${BOB}`, { path: "/rest/v1/profiles" })!.severity).toBe("critical");
  });

  it("flags writes too", () => {
    const f = run(`user_id=eq.${BOB}`, { method: "PATCH" })!;
    expect(f.evidence.method).toBe("PATCH");
  });

  it("rates the other party without a self pin on a multi-party table as medium", () => {
    const f = run(`receiver_id=eq.${BOB}`, { path: "/rest/v1/messages" })!;
    expect(f).toMatchObject({ severity: "medium", evidence: { tableShape: "multi_party" } });
  });

  it("does not count a self filter inside or as a pin", () => {
    const f = run(`or=(sender_id.eq.${ALICE},receiver_id.eq.${CAROL})&receiver_id=eq.${BOB}`, {
      path: "/rest/v1/messages",
    });
    expect(f).not.toBeNull();
  });

  it("rates broad sweeps on a multi-party table as high", () => {
    expect(run(`sender_id=neq.${ALICE}`, { path: "/rest/v1/messages" })!.severity).toBe("high");
  });
});

describe("outcomeOf", () => {
  it("separates a blocked probe from rows returned", () => {
    expect(outcomeOf(event({ status: 200, contentRange: "*/0" }))).toBe("empty");
    expect(outcomeOf(event({ status: 200, contentRange: "*/*" }))).toBe("empty");
    expect(outcomeOf(event({ status: 200, contentRange: "0-49/*" }))).toBe("rows_returned");
    expect(outcomeOf(event({ status: 401, contentRange: null }))).toBe("rejected");
    expect(outcomeOf(event({ status: 200, contentRange: null }))).toBe("unknown");
  });

  it("puts the outcome and row count in the evidence", () => {
    const f = run(`user_id=eq.${BOB}`, { contentRange: "0-49/*" })!;
    expect(f.evidence).toMatchObject({ outcome: "rows_returned", rowsReturned: 50 });
  });
});
