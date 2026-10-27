import { existsSync, readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import { EDGE_FIELDS, type EdgeField } from "./config/fields.js";
import { pollWindow, queryLogs } from "./logs/client.js";
import { normalizeRow, type EdgeEvent } from "./logs/event.js";
import { discoverKeysSql, edgeRollupSql } from "./logs/sql.js";
import {
  ownershipFromColumns,
  ownershipFromPolicies,
  POLICIES_SQL,
  type OwnershipMap,
  type PolicyRow,
} from "./ownership/ownership.js";
import { ServiceRoleNetworks } from "./detectors/serviceRole.js";
import { scan } from "./scan.js";
import { projectScope } from "./tenancy/scope.js";

const LOCAL_SCOPE = projectScope("00000000-0000-4000-8000-000000000000", "00000000-0000-4000-8000-000000000001");

const USAGE = `Usage:
  supadog scan --ownership <file> (--file <events.ndjson> | --project <ref> [--minutes 15])
               [--expected-asns 16509,24940]
  supadog discover-keys --project <ref> [--minutes 60]
  supadog print-sql

--ownership takes a JSON object {"table": ["owner_col", ...]} or a JSON array of pg_policies rows
(run the SQL from print-sql). Live calls read SUPABASE_ACCESS_TOKEN (analytics:read) from the env or .env.`;

function fail(message: string): never {
  process.stderr.write(`${message}\n\n${USAGE}\n`);
  process.exit(2);
}

function loadEnv(): void {
  if (existsSync(".env")) process.loadEnvFile(".env");
}

function token(): string {
  loadEnv();
  const t = process.env.SUPABASE_ACCESS_TOKEN;
  if (!t) fail("SUPABASE_ACCESS_TOKEN is not set");
  return t;
}

function readJson(path: string): unknown {
  return JSON.parse(readFileSync(path, "utf8"));
}

export function loadOwnership(data: unknown): OwnershipMap {
  if (Array.isArray(data)) return ownershipFromPolicies(data as PolicyRow[]);
  if (data !== null && typeof data === "object") {
    const columns: Record<string, string[]> = {};
    for (const [table, cols] of Object.entries(data)) {
      if (!Array.isArray(cols) || !cols.every((c) => typeof c === "string")) {
        throw new Error(`Ownership for "${table}" must be an array of column names`);
      }
      columns[table] = cols;
    }
    return ownershipFromColumns(columns);
  }
  throw new Error("Ownership file must be a JSON object or an array of pg_policies rows");
}

export function readEventsFile(path: string): EdgeEvent[] {
  return readFileSync(path, "utf8")
    .split("\n")
    .filter((line) => line.trim() !== "")
    .map((line) => normalizeRow(JSON.parse(line) as Record<string, unknown>));
}

function parseAsns(list: string | undefined): Set<number> {
  if (!list) return new Set();
  return new Set(list.split(",").map((s) => {
    const n = Number(s.trim());
    if (!Number.isInteger(n) || n <= 0) fail(`Not an ASN: "${s}"`);
    return n;
  }));
}

async function runScan(args: string[]): Promise<void> {
  const { values } = parseArgs({
    args,
    options: {
      ownership: { type: "string" },
      file: { type: "string" },
      project: { type: "string" },
      minutes: { type: "string", default: "15" },
      "expected-asns": { type: "string" },
    },
  });
  if (!values.ownership) fail("--ownership is required");
  if (!values.file === !values.project) fail("Pass exactly one of --file or --project");

  const ownership = loadOwnership(readJson(values.ownership));
  let events: EdgeEvent[];
  if (values.file) {
    events = readEventsFile(values.file);
  } else {
    const { start, end } = pollWindow(new Date(), Number(values.minutes));
    const rows = await queryLogs(
      { projectRef: values.project!, sql: edgeRollupSql(), start, end },
      { token: token() },
    );
    events = rows.map(normalizeRow);
  }

  const findings = scan(events, {
    // The CLI scans one project at a time, outside any tenant's storage.
    scope: LOCAL_SCOPE,
    networks: new ServiceRoleNetworks(),
    ownership,
    expectedAsns: parseAsns(values["expected-asns"]),
  });
  for (const f of findings) process.stdout.write(`${JSON.stringify(f)}\n`);
  process.stderr.write(
    `${events.length} request templates, ${Object.keys(ownership).length} owned tables, ${findings.length} findings\n`,
  );
}

async function runDiscoverKeys(args: string[]): Promise<void> {
  const { values } = parseArgs({
    args,
    options: { project: { type: "string" }, minutes: { type: "string", default: "60" } },
  });
  if (!values.project) fail("--project is required");
  const { start, end } = pollWindow(new Date(), Number(values.minutes));
  const rows = await queryLogs({ projectRef: values.project, sql: discoverKeysSql(), start, end }, { token: token() });
  const present = new Map(rows.map((r) => [String(r.key), Number(r.hits)]));

  process.stdout.write("Configured field paths:\n");
  for (const field of Object.keys(EDGE_FIELDS) as EdgeField[]) {
    const { key, verified } = EDGE_FIELDS[field];
    const hits = present.get(key);
    const status = hits === undefined ? "MISSING" : `present (${hits} rows)`;
    process.stdout.write(`  ${field.padEnd(15)} ${key.padEnd(48)} ${verified ? "docs" : "unverified"}  ${status}\n`);
  }
  process.stdout.write("\nAuth-related keys in edge_logs:\n");
  for (const [key, hits] of present) process.stdout.write(`  ${key}  (${hits})\n`);
}

async function main(argv: string[]): Promise<void> {
  const [command, ...rest] = argv;
  switch (command) {
    case "scan":
      return runScan(rest);
    case "discover-keys":
      return runDiscoverKeys(rest);
    case "print-sql":
      process.stdout.write(`-- Edge rollup (Management API logs endpoint)\n${edgeRollupSql()}\n\n`);
      process.stdout.write(`-- Key discovery (PRD task 1)\n${discoverKeysSql()}\n\n`);
      process.stdout.write(`-- Ownership from RLS policies (read-only SQL)\n${POLICIES_SQL}\n`);
      return;
    default:
      fail(command ? `Unknown command "${command}"` : "No command given");
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main(process.argv.slice(2)).catch((err: unknown) => {
    process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`);
    process.exit(1);
  });
}
