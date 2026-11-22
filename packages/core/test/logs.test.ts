import { describe, expect, it, vi } from "vitest";
import { EDGE_FIELDS, KEY_PREFIX_FIELDS, sourceColumn, unverifiedFields } from "../src/config/fields.js";
import { buildLogsUrl, LogsApiError, pollWindow, queryLogs } from "../src/logs/client.js";
import { effectiveRole, normalizeRow, rowsReturned } from "../src/logs/event.js";
import { authCoverageSql, discoverKeysSql, edgeRollupSql, keyKindCountsSql, keyKindSql, pollCountSql } from "../src/logs/sql.js";
import { event } from "./helpers.js";

const REF = "abcdefghijklmnopqrst";
const start = new Date("2026-10-27T12:00:00Z");
const end = new Date("2026-10-27T12:15:00Z");

describe("fields", () => {
  it("lists only the JWT subject as unverified after the live check (#154)", () => {
    expect(unverifiedFields()).toEqual(["jwtSubject"]);
  });

  it("accepts only the two documented source columns", () => {
    expect(sourceColumn({})).toBe("source");
    expect(sourceColumn({ SUPAHOUND_SOURCE_COLUMN: "source_name" })).toBe("source_name");
    expect(() => sourceColumn({ SUPAHOUND_SOURCE_COLUMN: "1=1; --" })).toThrow();
  });
});

describe("edgeRollupSql", () => {
  const sql = edgeRollupSql({ env: {} });

  it("names every column instead of SELECT *", () => {
    expect(sql).not.toMatch(/select\s+\*/i);
    for (const { key } of Object.values(EDGE_FIELDS)) expect(sql).toContain(`log_attributes['${key}']`);
  });

  it("rolls requests up in ClickHouse and filters to edge logs", () => {
    expect(sql).toContain("count() AS hits");
    expect(sql).toMatch(/GROUP BY method, path, search/);
    expect(sql).toContain("source = 'edge_logs'");
    expect(sql).toMatch(/LIMIT 5000$/);
  });

  it("uses the configured source column", () => {
    expect(edgeRollupSql({ env: { SUPAHOUND_SOURCE_COLUMN: "source_name" } })).toContain("source_name = 'edge_logs'");
  });
});

// Issue #154: the key-prefix fields hold key material after the type marker. The SQL may read them
// only inside keyKindSql, which maps them to an enum in ClickHouse; nothing else may name them.
describe("key kinds (#154)", () => {
  const prefixKeys = Object.values(KEY_PREFIX_FIELDS).map(({ key }) => `log_attributes['${key}']`);
  const withoutKindExpressions = (sql: string) =>
    sql.replaceAll(keyKindSql("apiKeyKind"), "<apiKeyKind>").replaceAll(keyKindSql("authorizationKind"), "<authorizationKind>");
  const allSql = [
    edgeRollupSql({ env: {}, anonReadTables: ["customers"], anonRpcFunctions: ["grant_credits"] }),
    authCoverageSql({}), pollCountSql({}), keyKindCountsSql({}),
  ];

  it("maps each prefix to a kind inside ClickHouse, reading the prefix only in startsWith and an empty check", () => {
    expect(keyKindSql("apiKeyKind")).toBe(
      "multiIf(startsWith(log_attributes['request.sb.apikey.apikey.prefix'], 'sb_secret_'), 'secret', "
      + "startsWith(log_attributes['request.sb.apikey.apikey.prefix'], 'sb_publishable_'), 'publishable', "
      + "startsWith(log_attributes['request.sb.apikey.apikey.prefix'], 'eyJ'), 'jwt', "
      + "log_attributes['request.sb.apikey.apikey.prefix'] = '', 'none', 'other')",
    );
    expect(keyKindSql("authorizationKind")).toContain("log_attributes['request.sb.apikey.authorization.prefix']");
  });

  it("never projects, groups on or otherwise names a raw prefix", () => {
    for (const sql of allSql) {
      const rest = withoutKindExpressions(sql);
      for (const key of prefixKeys) expect(rest).not.toContain(key);
      expect(rest).not.toMatch(/prefix/i);
    }
  });

  it("selects and groups the rollup by the kinds, not the prefixes", () => {
    const rest = withoutKindExpressions(edgeRollupSql({ env: {} }));
    expect(rest).toContain("<apiKeyKind> AS apiKeyKind");
    expect(rest).toContain("<authorizationKind> AS authorizationKind");
    expect(rest).toMatch(/GROUP BY .*, apiKeyRole, apiKeyKind, authorizationKind\n/);
  });

  it("keeps sb_secret_ traffic as service traffic and sb_publishable_ traffic as anon", () => {
    const rest = withoutKindExpressions(edgeRollupSql({ env: {}, anonReadTables: ["customers"], anonRpcFunctions: ["grant_credits"] }));
    expect(rest).toContain("OR <apiKeyKind> = 'secret'");
    const anon = "(log_attributes['request.sb.jwt.authorization.payload.role'] = 'anon' "
      + "OR (log_attributes['request.sb.jwt.authorization.payload.role'] = '' AND log_attributes['request.sb.jwt.apikey.payload.role'] = 'anon') "
      + "OR (log_attributes['request.sb.jwt.authorization.payload.role'] = '' AND log_attributes['request.sb.jwt.apikey.payload.role'] = '' AND <apiKeyKind> = 'publishable'))";
    // The anon-read, anon-RPC and Storage branches all read anon the same way.
    expect(rest.split(anon)).toHaveLength(4);
    // GraphQL counts too; authenticated never comes from a key kind.
    const counts = withoutKindExpressions(pollCountSql({}));
    expect(counts).toContain(anon);
    expect(counts).not.toMatch(/<apiKeyKind> = '(secret|publishable)'\) AS graphql_authenticated/);
  });

  it("counts key kinds for discover-keys from kinds only", () => {
    const rest = withoutKindExpressions(keyKindCountsSql({}));
    expect(rest).toMatch(/^SELECT\n {2}<apiKeyKind> AS apiKeyKind,\n {2}<authorizationKind> AS authorizationKind,\n {2}count\(\) AS hits\nFROM logs/);
    expect(rest).toContain("GROUP BY apiKeyKind, authorizationKind");
  });
});

describe("authCoverageSql (#130)", () => {
  const sql = authCoverageSql({});

  it("counts REST requests and those with an auth field, from fields.ts paths, and returns no log values", () => {
    expect(sql).toMatch(/^SELECT\n {2}countIf\(.*\) AS rest_requests,\n {2}countIf\(.*\) AS rest_with_auth,\n {2}countIf\(.*\) AS rest_with_key_kind\nFROM logs/);
    // #154: a JWT field (detector 2) and a known key kind (detector 4) are counted apart.
    expect(sql).toContain(`${keyKindSql("apiKeyKind")} IN ('secret', 'publishable', 'jwt')) AS rest_with_key_kind`);
    for (const f of ["path", "jwtSubject", "jwtRole", "apiKeyRole"] as const) {
      expect(sql).toContain(`log_attributes['${EDGE_FIELDS[f].key}']`);
    }
    expect(sql).not.toMatch(/GROUP BY/);
    expect(sql).toContain("source = 'edge_logs'");
    expect(authCoverageSql({ SUPAHOUND_SOURCE_COLUMN: "source_name" })).toContain("source_name = 'edge_logs'");
  });
});

describe("discoverKeysSql", () => {
  it("returns map keys only, never values", () => {
    const sql = discoverKeysSql({});
    expect(sql).toContain("mapKeys(log_attributes)");
    expect(sql).not.toMatch(/log_attributes\[/);
  });
});

describe("buildLogsUrl", () => {
  it("puts the SQL and window in query parameters", () => {
    const url = buildLogsUrl({ projectRef: REF, sql: "SELECT 1", start, end });
    expect(url.pathname).toBe(`/v1/projects/${REF}/analytics/endpoints/logs`);
    expect(url.searchParams.get("sql")).toBe("SELECT 1");
    expect(url.searchParams.get("iso_timestamp_start")).toBe("2026-10-27T12:00:00.000Z");
    expect(url.searchParams.get("iso_timestamp_end")).toBe("2026-10-27T12:15:00.000Z");
  });

  it("rejects a bad ref, an empty window and a window over 24 hours", () => {
    expect(() => buildLogsUrl({ projectRef: "../admin", sql: "", start, end })).toThrow(/project ref/);
    expect(() => buildLogsUrl({ projectRef: REF, sql: "", start: end, end: start })).toThrow(/after/);
    const late = new Date(start.getTime() + 25 * 3600_000);
    expect(() => buildLogsUrl({ projectRef: REF, sql: "", start, end: late })).toThrow(/24 hours/);
  });
});

describe("queryLogs", () => {
  const query = { projectRef: REF, sql: "SELECT 1", start, end };
  const respond = (status: number, body: unknown) =>
    vi.fn(async () => new Response(JSON.stringify(body), { status })) as unknown as typeof fetch;

  it("returns result rows and sends the bearer token", async () => {
    const fetchMock = respond(200, { result: [{ hits: 2 }, null] });
    const rows = await queryLogs(query, { token: "tok", fetch: fetchMock });
    expect(rows).toEqual([{ hits: 2 }]);
    const init = vi.mocked(fetchMock).mock.calls[0]![1]!;
    expect((init.headers as Record<string, string>).Authorization).toBe("Bearer tok");
  });

  it("treats an error inside an HTTP 200 as a failure", async () => {
    await expect(queryLogs(query, { token: "t", fetch: respond(200, { result: [], error: "syntax error" }) }))
      .rejects.toThrow(/syntax error/);
    await expect(queryLogs(query, { token: "t", fetch: respond(200, { error: { message: "bad column" } }) }))
      .rejects.toThrow(/bad column/);
  });

  it("raises auth and rate-limit failures with their status", async () => {
    const err = await queryLogs(query, { token: "t", fetch: respond(429, {}) }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(LogsApiError);
    expect((err as LogsApiError).status).toBe(429);
    await expect(queryLogs(query, { token: "t", fetch: respond(401, {}) })).rejects.toThrow(/401/);
  });

  it("rejects a body with no result array", async () => {
    await expect(queryLogs(query, { token: "t", fetch: respond(200, {}) })).rejects.toThrow(/no result/);
  });
});

describe("pollWindow", () => {
  it("ends the window behind now to allow for late logs", () => {
    const w = pollWindow(new Date("2026-10-27T12:30:00Z"), 15, 90);
    expect(w.end.toISOString()).toBe("2026-10-27T12:28:30.000Z");
    expect(w.start.toISOString()).toBe("2026-10-27T12:13:30.000Z");
  });
});

describe("normalizeRow", () => {
  it("maps aliased columns and treats empty map values as missing", () => {
    const e = normalizeRow({
      method: "get", path: "/rest/v1/notes", search: "?a=eq.1", status: "200", contentRange: "",
      asn: "16509", jwtSubject: "", jwtRole: "authenticated", hits: "3", first_seen: "t0", last_seen: "t1",
    });
    expect(e).toMatchObject({ method: "GET", status: 200, contentRange: null, asn: 16509, jwtSubject: null, hits: 3 });
  });

  it("keeps a key kind only when it is one of the known enums (#154)", () => {
    expect(normalizeRow({ apiKeyKind: "secret", authorizationKind: "none" })).toMatchObject({ apiKeyKind: "secret", authorizationKind: "none" });
    expect(normalizeRow({ apiKeyKind: "sb_secret_abcde", authorizationKind: "" })).toMatchObject({ apiKeyKind: null, authorizationKind: null });
    expect(normalizeRow({})).toMatchObject({ apiKeyKind: null, authorizationKind: null });
  });
});

describe("rowsReturned", () => {
  it.each([
    ["0-24/*", 25],
    ["0-24/3573", 25],
    ["10-10/11", 1],
    ["*/0", 0],
    ["*/*", 0],
    [null, null],
    ["garbage", null],
  ])("reads %s as %s", (header, rows) => {
    expect(rowsReturned(header)).toBe(rows);
  });
});

describe("effectiveRole", () => {
  it("prefers the user JWT role over the API key role", () => {
    expect(effectiveRole(event({ jwtRole: "authenticated", apiKeyRole: "anon" }))).toBe("authenticated");
    expect(effectiveRole(event({ jwtRole: null, apiKeyRole: "service_role" }))).toBe("service_role");
    expect(effectiveRole(event({ jwtRole: null, apiKeyRole: null }))).toBe("unknown");
    expect(effectiveRole(event({ jwtRole: "supabase_admin" }))).toBe("other");
  });

  it("reads the role of a new API key from its kind when no JWT says (#154)", () => {
    const noJwt = { jwtSubject: null, jwtRole: null, apiKeyRole: null };
    expect(effectiveRole(event({ ...noJwt, apiKeyKind: "secret", authorizationKind: "secret" }))).toBe("service_role");
    expect(effectiveRole(event({ ...noJwt, apiKeyKind: "publishable", authorizationKind: "publishable" }))).toBe("anon");
    expect(effectiveRole(event({ ...noJwt, apiKeyKind: "jwt" }))).toBe("unknown");
    expect(effectiveRole(event({ ...noJwt, apiKeyKind: "none" }))).toBe("unknown");
    expect(effectiveRole(event({ ...noJwt, apiKeyKind: "other" }))).toBe("unknown");
    expect(effectiveRole(event({ ...noJwt, apiKeyKind: null }))).toBe("unknown");
    // The Authorization header alone never decides the role.
    expect(effectiveRole(event({ ...noJwt, apiKeyKind: "none", authorizationKind: "secret" }))).toBe("unknown");
    // A user JWT still wins: a signed-in user calling with a publishable key is authenticated.
    expect(effectiveRole(event({ jwtRole: "authenticated", apiKeyRole: null, apiKeyKind: "publishable", authorizationKind: "jwt" }))).toBe("authenticated");
  });
});
