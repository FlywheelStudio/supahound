import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { loadOwnership } from "../src/cli.js";
import type { Finding } from "../src/detectors/finding.js";

const root = fileURLToPath(new URL("..", import.meta.url));

function cli(...args: string[]) {
  const r = spawnSync(process.execPath, ["--import", "tsx", "src/cli.ts", ...args], {
    cwd: root,
    encoding: "utf8",
    env: { ...process.env, SUPABASE_ACCESS_TOKEN: "" },
  });
  return { code: r.status, stdout: r.stdout, stderr: r.stderr };
}

describe("loadOwnership", () => {
  it("accepts a static map or pg_policies rows", () => {
    const all = { SELECT: ["user_id"], UPDATE: ["user_id"], DELETE: ["user_id"] };
    expect(loadOwnership({ notes: ["user_id"] })).toEqual({ notes: all });
    expect(
      loadOwnership([{ schemaname: "public", tablename: "notes", roles: "{authenticated}", qual: "(auth.uid() = user_id)" }]),
    ).toEqual({ notes: all });
    expect(() => loadOwnership({ notes: "user_id" })).toThrow(/array of column names/);
  });
});

describe("supahound scan --file (happy path, end to end)", () => {
  const r = cli("scan", "--file", "test/fixtures/events.ndjson", "--ownership", "test/fixtures/policies.json");
  const findings = r.stdout.trim().split("\n").map((l) => JSON.parse(l) as Finding);

  it("exits 0 and reports a summary", () => {
    expect(r.code).toBe(0);
    expect(r.stderr).toContain("7 request templates, 3 owned tables, 2 findings");
  });

  it("finds the cross-tenant read and the browser holding the service key, most severe first", () => {
    expect(findings.map((f) => [f.detector, f.severity, f.signals])).toEqual([
      ["cross_tenant", "critical", ["other_owner"]],
      ["service_role_misuse", "critical", ["browser_caller", "non_hosting_network"]],
    ]);
    expect(findings[0]!.evidence).toMatchObject({ table: "notes", outcome: "rows_returned", rowsReturned: 50 });
    expect(findings[0]!.hits).toBe(37);
  });

  it("stays quiet on own-row reads, membership tables and a server-side service key", () => {
    expect(findings.some((f) => ["projects", "messages", "profiles"].includes(String(f.evidence.table)))).toBe(false);
    expect(findings.some((f) => f.evidence.asn === 16509)).toBe(false);
  });
});

describe("supahound CLI errors", () => {
  it("exits 2 with usage on a bad command line", () => {
    expect(cli("scan").code).toBe(2);
    expect(cli("nope").stderr).toContain("Unknown command");
  });

  it("refuses a live scan without a token", () => {
    const r = cli("scan", "--project", "abcdefghijklmnopqrst", "--ownership", "test/fixtures/policies.json");
    expect(r.code).toBe(2);
    expect(r.stderr).toContain("SUPABASE_ACCESS_TOKEN is not set");
  });

  it("prints the SQL it would run", () => {
    const r = cli("print-sql");
    expect(r.code).toBe(0);
    expect(r.stdout).toContain("FROM pg_catalog.pg_policies");
    expect(r.stdout).toContain("mapKeys(log_attributes)");
    expect(r.stdout).toContain("has_table_privilege");
  });
});
