import { describe, expect, it } from "vitest";
import { parseRequest, tableFromPath } from "../src/postgrest/query.js";

describe("tableFromPath", () => {
  it("reads the table from a PostgREST path", () => {
    expect(tableFromPath("/rest/v1/orders")).toBe("orders");
    expect(tableFromPath("/rest/v1/orders/")).toBe("orders");
    expect(tableFromPath("/rest/v1/user%20notes")).toBe("user notes");
  });

  it("ignores RPC calls and non-PostgREST paths", () => {
    expect(tableFromPath("/rest/v1/rpc/get_feed")).toBeNull();
    expect(tableFromPath("/rest/v1/rpc")).toBeNull();
    expect(tableFromPath("/auth/v1/user")).toBeNull();
  });
});

describe("parseRequest", () => {
  it("parses a plain eq filter and skips reserved keys", () => {
    const r = parseRequest("/rest/v1/orders", "?select=*&user_id=eq.abc&order=created_at.desc&limit=10");
    expect(r.table).toBe("orders");
    expect(r.conditions).toEqual([
      { embed: null, column: "user_id", op: "eq", values: ["abc"], negated: false, conjunctive: true },
    ]);
    expect(r.unparsed).toEqual([]);
  });

  it("URL-decodes keys and values, and keeps + literal", () => {
    const r = parseRequest("/rest/v1/orders", "user_id=eq.ABC%2Ddef&note=eq.a+b");
    expect(r.conditions[0]!.values).toEqual(["ABC-def"]);
    expect(r.conditions[1]!.values).toEqual(["a+b"]);
  });

  it("parses in lists, including quoted values with commas", () => {
    const r = parseRequest("/rest/v1/orders", 'user_id=in.(a,b,"c,d")');
    expect(r.conditions[0]).toMatchObject({ op: "in", values: ["a", "b", "c,d"] });
  });

  it("reads not. as a negation", () => {
    const r = parseRequest("/rest/v1/orders", "user_id=not.eq.abc&deleted_at=not.is.null");
    expect(r.conditions[0]).toMatchObject({ op: "eq", negated: true });
    expect(r.conditions[1]).toMatchObject({ op: "is", values: ["null"], negated: true });
  });

  it("marks conditions inside or= as not conjunctive", () => {
    const r = parseRequest("/rest/v1/messages", "or=(sender_id.eq.a,receiver_id.eq.b)");
    expect(r.conditions).toEqual([
      { embed: null, column: "sender_id", op: "eq", values: ["a"], negated: false, conjunctive: false },
      { embed: null, column: "receiver_id", op: "eq", values: ["b"], negated: false, conjunctive: false },
    ]);
  });

  it("keeps and= groups conjunctive and walks nested groups", () => {
    const r = parseRequest("/rest/v1/t", "and=(a.eq.1,or(b.eq.2,c.eq.3))");
    expect(r.conditions.map((c) => [c.column, c.conjunctive])).toEqual([
      ["a", true],
      ["b", false],
      ["c", false],
    ]);
  });

  it("applies De Morgan to not.or and not.and", () => {
    const notOr = parseRequest("/rest/v1/t", "not.or=(a.eq.1,b.eq.2)");
    expect(notOr.conditions.map((c) => [c.column, c.negated, c.conjunctive])).toEqual([
      ["a", true, true],
      ["b", true, true],
    ]);
    const notAnd = parseRequest("/rest/v1/t", "not.and=(a.eq.1,b.not.eq.2)");
    expect(notAnd.conditions.map((c) => [c.column, c.negated, c.conjunctive])).toEqual([
      ["a", true, false],
      ["b", false, false],
    ]);
  });

  it("attributes embedded-resource filters to the embedded table", () => {
    const r = parseRequest("/rest/v1/profiles", "select=*,orders(*)&orders.user_id=eq.x&orders.or=(status.eq.paid,user_id.eq.y)");
    expect(r.conditions.map((c) => [c.embed, c.column, c.values[0], c.conjunctive])).toEqual([
      ["orders", "user_id", "x", true],
      ["orders", "status", "paid", false],
      ["orders", "user_id", "y", false],
    ]);
  });

  it("reads embedded columns written inside a group", () => {
    const r = parseRequest("/rest/v1/profiles", "or=(orders.user_id.eq.x,id.eq.y)");
    expect(r.conditions[0]).toMatchObject({ embed: "orders", column: "user_id", values: ["x"] });
    expect(r.conditions[1]).toMatchObject({ embed: null, column: "id" });
  });

  it("keeps dots inside values", () => {
    const r = parseRequest("/rest/v1/t", "email=eq.a.b@example.com");
    expect(r.conditions[0]!.values).toEqual(["a.b@example.com"]);
  });

  it("parses any/all modifiers as lists", () => {
    const r = parseRequest("/rest/v1/t", "name=like(any).{a*,b*}");
    expect(r.conditions[0]).toMatchObject({ op: "like", values: ["a*", "b*"] });
  });

  it("reports filters it cannot read instead of dropping them", () => {
    const r = parseRequest("/rest/v1/t", "user_id=bogus.x&or=notagroup");
    expect(r.conditions).toEqual([]);
    expect(r.unparsed).toEqual(["user_id=bogus.x", "notagroup"]);
  });
});
