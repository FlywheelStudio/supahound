import { describe, expect, it } from "vitest";
import { ownershipColumns, ownershipFromPolicies } from "../src/ownership/ownership.js";

// Expressions as Postgres deparses them into pg_policies.qual.
describe("ownershipColumns", () => {
  it.each([
    ["(auth.uid() = user_id)", ["user_id"]],
    ["(user_id = auth.uid())", ["user_id"]],
    ["(( SELECT auth.uid() AS uid) = user_id)", ["user_id"]],
    ["((auth.uid())::text = (owner_id)::text)", ["owner_id"]],
    ["((auth.jwt() ->> 'sub'::text) = (user_id)::text)", ["user_id"]],
    ["(( SELECT (auth.jwt() ->> 'sub'::text) AS sub) = (author_id)::text)", ["author_id"]],
    ["(id = ( SELECT auth.uid() AS uid))", ["id"]],
    ["((auth.uid() = sender_id) OR (auth.uid() = receiver_id))", ["sender_id", "receiver_id"]],
    ["((is_public = true) OR (auth.uid() = user_id))", ["user_id"]],
  ])("finds the owner column in %s", (qual, expected) => {
    expect(ownershipColumns(qual).sort()).toEqual([...expected].sort());
  });

  it("keeps a column qualified by its own table and skips another table's", () => {
    expect(ownershipColumns("(notes.user_id = auth.uid())", "notes")).toEqual(["user_id"]);
    expect(ownershipColumns("(m.user_id = auth.uid())", "notes")).toEqual([]);
  });

  it("treats membership subqueries as not ownership", () => {
    expect(
      ownershipColumns(
        "(team_id IN ( SELECT team_members.team_id FROM team_members WHERE (team_members.user_id = auth.uid())))",
        "projects",
      ),
    ).toEqual([]);
    expect(
      ownershipColumns(
        "(EXISTS ( SELECT 1 FROM members WHERE ((members.org_id = projects.org_id) AND (user_id = ( SELECT auth.uid() AS uid)))))",
        "projects",
      ),
    ).toEqual([]);
  });

  it("returns nothing for open or empty policies", () => {
    expect(ownershipColumns("true")).toEqual([]);
    expect(ownershipColumns(null)).toEqual([]);
    expect(ownershipColumns("(auth.role() = 'authenticated'::text)")).toEqual([]);
  });
});

describe("ownershipFromPolicies", () => {
  it("merges qual and with_check across policies per table", () => {
    const map = ownershipFromPolicies([
      { schemaname: "public", tablename: "notes", roles: ["authenticated"], cmd: "SELECT", qual: "(auth.uid() = user_id)" },
      { schemaname: "public", tablename: "notes", roles: "{authenticated}", cmd: "INSERT", qual: null, with_check: "(auth.uid() = user_id)" },
      { schemaname: "public", tablename: "messages", roles: ["public"], cmd: "ALL", qual: "((auth.uid() = sender_id) OR (auth.uid() = receiver_id))" },
    ]);
    expect(map).toEqual({ notes: ["user_id"], messages: ["receiver_id", "sender_id"] });
  });

  it("skips other schemas, anon-only policies and tables without owner columns", () => {
    const map = ownershipFromPolicies([
      { schemaname: "storage", tablename: "objects", roles: ["authenticated"], qual: "(auth.uid() = owner)" },
      { schemaname: "public", tablename: "posts", roles: ["anon"], qual: "(auth.uid() = user_id)" },
      { schemaname: "public", tablename: "pages", roles: ["authenticated"], qual: "true" },
    ]);
    expect(map).toEqual({});
  });
});
