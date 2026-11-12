import { appendFileSync, existsSync, readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import pg from "pg";
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
import { newMasterKeys } from "./vault/vault.js";
import {
  cloudflareSender, noticeProblems, noticeRecipients, renderSubprocessorNotice, sendNotice,
  type SendFn, type SubprocessorNotice,
} from "./notices/subprocessor.js";

const LOCAL_SCOPE = projectScope("00000000-0000-4000-8000-000000000000", "00000000-0000-4000-8000-000000000001");

const USAGE = `Usage:
  supahound scan --ownership <file> (--file <events.ndjson> | --project <ref> [--minutes 15])
               [--expected-asns 16509,24940]
  supahound discover-keys --project <ref> [--minutes 60]
  supahound print-sql
  supahound master-key [--rotate]
  supahound subprocessor-notice --name <n> --purpose <p> --location <l> --effective YYYY-MM-DD --contact <email>
               [--policy-url <https url>] [--test-to <email> | --send --journal <file>]

--ownership takes a JSON object {"table": ["owner_col", ...]} or a JSON array of pg_policies rows
(run the SQL from print-sql). Live calls read SUPABASE_ACCESS_TOKEN (analytics:read) from the env or .env.
master-key prints a new SUPAHOUND_MASTER_KEYS value. --rotate reads the current value from the
SUPAHOUND_MASTER_KEYS env var and appends a new version; old tokens still open.
subprocessor-notice counts the workspace owners who would get the notice and sends nothing (dry run),
unless --send is given. Reads SUPAHOUND_NOTIFIER_DATABASE_URL; sending also reads CLOUDFLARE_ACCOUNT_ID,
CLOUDFLARE_EMAIL_API_TOKEN, NOTICE_FROM_ADDRESS and NOTICE_FROM_NAME. --test-to sends one copy to one address.`;

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
      { projectRef: values.project!, sql: edgeRollupSql({ env: process.env }), start, end },
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
  const rows = await queryLogs({ projectRef: values.project, sql: discoverKeysSql(process.env), start, end }, { token: token() });
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

export interface NoticeCliDeps {
  env: Record<string, string | undefined>;
  today: Date;
  // A pool that logs in as a member of supahound_notifier.
  notifier: (url: string) => pg.Pool;
  fetch?: typeof fetch;
  readJournal: (path: string) => string[];
  appendJournal: (path: string, line: string) => void;
  out: (line: string) => void;
}

// The subprocessor notice (decision 037). Safe by default: without --send it only counts. Returns
// the exit code.
export async function runSubprocessorNotice(args: string[], deps: NoticeCliDeps): Promise<number> {
  const { values } = parseArgs({
    args,
    options: {
      name: { type: "string" }, purpose: { type: "string" }, location: { type: "string" },
      effective: { type: "string" }, contact: { type: "string" }, "policy-url": { type: "string" },
      send: { type: "boolean" }, journal: { type: "string" }, "test-to": { type: "string" },
    },
  });
  const notice: SubprocessorNotice = {
    name: values.name ?? "", purpose: values.purpose ?? "", location: values.location ?? "",
    effective: values.effective ?? "", contact: values.contact ?? "", policyUrl: values["policy-url"] ?? null,
  };
  const problems = noticeProblems(notice, deps.today);
  if (values.send && values["test-to"]) problems.push("Pass --send or --test-to, not both");
  if (values.send && !values.journal) problems.push("--send needs --journal <file>: it records who already got the notice");
  if (problems.length > 0) {
    for (const p of problems) deps.out(`error: ${p}`);
    return 2;
  }

  const sender = (): { send: SendFn; from: { address: string; name: string } } | null => {
    const { CLOUDFLARE_ACCOUNT_ID: accountId, CLOUDFLARE_EMAIL_API_TOKEN: apiToken, NOTICE_FROM_ADDRESS: address } = deps.env;
    if (!accountId || !apiToken || !address) {
      deps.out("error: sending needs CLOUDFLARE_ACCOUNT_ID, CLOUDFLARE_EMAIL_API_TOKEN and NOTICE_FROM_ADDRESS");
      return null;
    }
    return { send: cloudflareSender({ accountId, apiToken, fetch: deps.fetch }), from: { address, name: deps.env.NOTICE_FROM_NAME || "Supahound" } };
  };

  const testTo = values["test-to"];
  if (testTo) {
    const s = sender();
    if (!s) return 2;
    await s.send({ to: testTo, from: s.from, replyTo: notice.contact, ...renderSubprocessorNotice(notice) });
    deps.out("Sent 1 test copy. No workspace owner was emailed.");
    return 0;
  }

  const url = deps.env.SUPAHOUND_NOTIFIER_DATABASE_URL;
  if (!url) {
    deps.out("error: SUPAHOUND_NOTIFIER_DATABASE_URL is not set (a login in supahound_notifier, supabase/setup/notifier-user.sql)");
    return 2;
  }
  const pool = deps.notifier(url);
  let recipients;
  try {
    recipients = await noticeRecipients(pool);
  } finally {
    await pool.end();
  }
  // Counts only: never an address on screen.
  deps.out(`${recipients.addresses.length} recipients (distinct owner addresses across all workspaces)`);
  if (recipients.ownersWithoutAddress > 0) deps.out(`${recipients.ownersWithoutAddress} owner memberships have no address on file and get no email`);
  if (!values.send) {
    deps.out("Dry run: nothing was sent. Add --send --journal <file> to send.");
    return 0;
  }
  const s = sender();
  if (!s) return 2;
  const journal = values.journal!;
  const result = await sendNotice({
    notice, addresses: recipients.addresses, from: s.from, send: s.send,
    sent: new Set(deps.readJournal(journal)), record: (line) => deps.appendJournal(journal, line),
  });
  deps.out(`Sent ${result.sent}, already sent ${result.skipped}, failed ${result.failed}.`);
  if (result.failed > 0) deps.out("Run the same command again to retry the failed ones; the journal skips the rest.");
  return result.failed > 0 ? 1 : 0;
}

async function main(argv: string[]): Promise<void> {
  const [command, ...rest] = argv;
  switch (command) {
    case "scan":
      return runScan(rest);
    case "discover-keys":
      return runDiscoverKeys(rest);
    case "print-sql":
      process.stdout.write(`-- Edge rollup (Management API logs endpoint)\n${edgeRollupSql({ env: process.env })}\n\n`);
      process.stdout.write(`-- Key discovery (PRD task 1)\n${discoverKeysSql(process.env)}\n\n`);
      process.stdout.write(`-- Ownership from RLS policies (read-only SQL)\n${POLICIES_SQL}\n`);
      return;
    case "master-key": {
      const { values } = parseArgs({ args: rest, options: { rotate: { type: "boolean" } } });
      const current = values.rotate ? process.env.SUPAHOUND_MASTER_KEYS : undefined;
      if (values.rotate && !current) fail("--rotate needs the current value in SUPAHOUND_MASTER_KEYS");
      process.stdout.write(`${newMasterKeys(current)}\n`);
      return;
    }
    case "subprocessor-notice": {
      loadEnv();
      const code = await runSubprocessorNotice(rest, {
        env: process.env,
        today: new Date(),
        notifier: (url) => new pg.Pool({ connectionString: url, max: 1 }),
        readJournal: (path) => (existsSync(path) ? readFileSync(path, "utf8").split("\n").filter((l) => l !== "") : []),
        appendJournal: (path, line) => appendFileSync(path, `${line}\n`, { mode: 0o600 }),
        out: (line) => process.stdout.write(`${line}\n`),
      });
      if (code !== 0) process.exit(code);
      return;
    }
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
