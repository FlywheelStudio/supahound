import { describe, expect, it, vi } from "vitest";
import { MAX_POLICY_ROWS, parsePolicyRows, queryReadOnly, SqlQueryError } from "../src/ownership/client.js";
import { ownershipFromPolicies, POLICIES_SQL } from "../src/ownership/ownership.js";

const REF = "abcdefghijklmnopqrst";

// pg_policies rows as Postgres returns them: the Supabase quickstart profiles table plus a notes
// table owned by user_id. Synthetic.
const POLICY_ROWS = [
  { schemaname: "public", tablename: "profiles", policyname: "read", permissive: "PERMISSIVE", roles: ["public"], cmd: "SELECT", qual: "true", with_check: null },
  { schemaname: "public", tablename: "profiles", policyname: "upd", permissive: "PERMISSIVE", roles: ["authenticated"], cmd: "UPDATE", qual: "(( SELECT auth.uid() AS uid) = id)", with_check: null },
  { schemaname: "public", tablename: "notes", policyname: "own", permissive: "PERMISSIVE", roles: "{authenticated}", cmd: "ALL", qual: "(auth.uid() = user_id)", with_check: "(auth.uid() = user_id)" },
];

function fakeFetch(status: number, body: unknown) {
  return vi.fn<(url: URL | string, init?: RequestInit) => Promise<Response>>(async () =>
    new Response(typeof body === "string" ? body : JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } }));
}

describe("queryReadOnly", () => {
  it("POSTs the SQL to the read-only endpoint with the bearer token", async () => {
    const f = fakeFetch(201, POLICY_ROWS);
    await queryReadOnly({ projectRef: REF, sql: POLICIES_SQL }, { token: "tok", fetch: f as unknown as typeof fetch });
    const [url, init] = f.mock.calls[0]!;
    expect(String(url)).toBe(`https://api.supabase.com/v1/projects/${REF}/database/query/read-only`);
    expect(init!.method).toBe("POST");
    expect((init!.headers as Record<string, string>).Authorization).toBe("Bearer tok");
    expect(JSON.parse(init!.body as string)).toEqual({ query: POLICIES_SQL });
    expect(init!.signal).toBeInstanceOf(AbortSignal);
  });

  it("accepts Supabase's 201 with a bare row array", async () => {
    const rows = await queryReadOnly({ projectRef: REF, sql: "select 1" }, { token: "t", fetch: fakeFetch(201, POLICY_ROWS) as unknown as typeof fetch });
    expect(rows).toHaveLength(3);
  });

  it("accepts a { result: [...] } wrapper", async () => {
    const rows = await queryReadOnly({ projectRef: REF, sql: "select 1" }, { token: "t", fetch: fakeFetch(200, { result: POLICY_ROWS }) as unknown as typeof fetch });
    expect(rows).toHaveLength(3);
  });

  it("reports the HTTP status and never the error body", async () => {
    const f = fakeFetch(403, { message: "permission denied for table secrets_of_customer" });
    const err = await queryReadOnly({ projectRef: REF, sql: "select 1" }, { token: "t", fetch: f as unknown as typeof fetch }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(SqlQueryError);
    expect((err as SqlQueryError).status).toBe(403);
    expect((err as Error).message).not.toContain("secrets_of_customer");
  });

  it.each([
    ["an object without rows", { message: "ok" }],
    ["null", null],
    ["text that is not JSON", "<html>"],
  ])("fails on %s instead of reading it as 'no policies'", async (_name, body) => {
    await expect(
      queryReadOnly({ projectRef: REF, sql: "select 1" }, { token: "t", fetch: fakeFetch(201, body) as unknown as typeof fetch }),
    ).rejects.toBeInstanceOf(SqlQueryError);
  });

  it("refuses a malformed project ref before any request", async () => {
    const f = fakeFetch(201, []);
    await expect(queryReadOnly({ projectRef: "../../v1/organizations", sql: "select 1" }, { token: "t", fetch: f as unknown as typeof fetch })).rejects.toThrow(/project ref/);
    expect(f).not.toHaveBeenCalled();
  });
});

describe("parsePolicyRows", () => {
  it("keeps the fields ownership needs and accepts roles as an array or a Postgres array literal", () => {
    const parsed = parsePolicyRows(POLICY_ROWS);
    expect(parsed).toHaveLength(3);
    expect(parsed[0]).toEqual({ schemaname: "public", tablename: "profiles", permissive: "PERMISSIVE", roles: ["public"], cmd: "SELECT", qual: "true", with_check: null });
    expect(parsed[2]!.roles).toBe("{authenticated}");
  });

  it("drops rows without a schema or table name", () => {
    expect(parsePolicyRows([{ tablename: "notes", qual: "true" }, { schemaname: "public", tablename: 7 }])).toEqual([]);
  });

  it("fails on more rows than it can hold, because a cut-off map under-reports ownership", () => {
    const rows = Array.from({ length: MAX_POLICY_ROWS + 1 }, () => POLICY_ROWS[0]!);
    expect(() => parsePolicyRows(rows)).toThrow(SqlQueryError);
  });

  it("feeds ownershipFromPolicies: public-read profiles get UPDATE only, notes get every command", () => {
    expect(ownershipFromPolicies(parsePolicyRows(POLICY_ROWS))).toEqual({
      profiles: { UPDATE: ["id"] },
      notes: { SELECT: ["user_id"], UPDATE: ["user_id"], DELETE: ["user_id"] },
    });
  });
});
