import { describe, expect, it } from "vitest";
import {
  commandForMethod,
  ownershipColumns,
  ownershipFromColumns,
  ownershipFromPolicies,
  requiredOwnerColumns,
} from "../src/ownership/ownership.js";

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

describe("requiredOwnerColumns", () => {
  it.each([
    ["(auth.uid() = user_id)", ["user_id"]],
    ["((auth.uid() = sender_id) OR (auth.uid() = receiver_id))", ["receiver_id", "sender_id"]],
    ["((is_public = true) OR (auth.uid() = user_id))", []],
    ["((auth.uid() = user_id) AND (deleted_at IS NULL))", ["user_id"]],
    ["(((auth.uid() = user_id) OR is_public) AND (status = 'live'))", []],
    ["(team_id IN ( SELECT tm.team_id FROM tm WHERE (tm.user_id = auth.uid())))", []],
    ["true", []],
  ])("requires %s -> %j", (qual, expected) => {
    expect(requiredOwnerColumns(qual).sort()).toEqual([...expected].sort());
  });
});

const policy = (tablename: string, cmd: string, qual: string | null, extra: Record<string, unknown> = {}) => ({
  schemaname: "public", tablename, permissive: "PERMISSIVE", roles: "{authenticated}", cmd, qual, ...extra,
});

describe("ownershipFromPolicies", () => {
  it("scopes each command by its own policies", () => {
    const map = ownershipFromPolicies([
      policy("profiles", "SELECT", "true"),
      policy("profiles", "UPDATE", "(( SELECT auth.uid() AS uid) = id)"),
      policy("notes", "ALL", "(auth.uid() = user_id)"),
      policy("messages", "SELECT", "((auth.uid() = sender_id) OR (auth.uid() = receiver_id))"),
    ]);
    expect(map).toEqual({
      profiles: { UPDATE: ["id"] },
      notes: { SELECT: ["user_id"], UPDATE: ["user_id"], DELETE: ["user_id"] },
      messages: { SELECT: ["receiver_id", "sender_id"] },
    });
  });

  it("drops a command when any permissive policy lets rows through without an owner", () => {
    const map = ownershipFromPolicies([
      policy("docs", "SELECT", "(auth.uid() = owner_id)"),
      policy("docs", "SELECT", "(org_id IN ( SELECT m.org_id FROM m WHERE (m.user_id = auth.uid())))"),
    ]);
    expect(map).toEqual({});
  });

  it("lets a restrictive owner policy scope a command beside a permissive true", () => {
    const map = ownershipFromPolicies([
      policy("notes", "SELECT", "true"),
      policy("notes", "SELECT", "(auth.uid() = user_id)", { permissive: "RESTRICTIVE" }),
    ]);
    expect(map).toEqual({ notes: { SELECT: ["user_id"] } });
  });

  it("ignores INSERT policies and with_check", () => {
    const map = ownershipFromPolicies([policy("notes", "INSERT", null, { with_check: "(auth.uid() = user_id)" })]);
    expect(map).toEqual({});
  });

  it("skips other schemas and anon-only policies", () => {
    const map = ownershipFromPolicies([
      policy("objects", "ALL", "(auth.uid() = owner)", { schemaname: "storage" }),
      policy("posts", "ALL", "(auth.uid() = user_id)", { roles: ["anon"] }),
    ]);
    expect(map).toEqual({});
  });
});

describe("ownershipFromColumns", () => {
  it("scopes every command", () => {
    expect(ownershipFromColumns({ notes: ["user_id"] })).toEqual({
      notes: { SELECT: ["user_id"], UPDATE: ["user_id"], DELETE: ["user_id"] },
    });
  });
});

describe("commandForMethod", () => {
  it("maps PostgREST methods to RLS commands", () => {
    expect(["GET", "HEAD", "PATCH", "PUT", "DELETE", "POST"].map(commandForMethod)).toEqual([
      "SELECT", "SELECT", "UPDATE", "UPDATE", "DELETE", null,
    ]);
  });
});
