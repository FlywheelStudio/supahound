import { describe, expect, it, vi } from "vitest";
import { EDGE_FIELDS, sourceColumn, unverifiedFields } from "../src/config/fields.js";
import { buildLogsUrl, LogsApiError, pollWindow, queryLogs } from "../src/logs/client.js";
import { effectiveRole, normalizeRow, rowsReturned } from "../src/logs/event.js";
import { discoverKeysSql, edgeRollupSql } from "../src/logs/sql.js";
import { event } from "./helpers.js";

const REF = "abcdefghijklmnopqrst";
const start = new Date("2026-10-27T12:00:00Z");
const end = new Date("2026-10-27T12:15:00Z");

describe("fields", () => {
  it("lists the JWT and API-key paths as unverified until the live check", () => {
    expect(unverifiedFields().sort()).toEqual(["apiKeyRole", "jwtRole", "jwtSubject"]);
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
});
