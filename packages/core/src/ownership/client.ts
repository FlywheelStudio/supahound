import { MANAGEMENT_API } from "../logs/client.js";
import type { PolicyRow } from "./ownership.js";

// Read-only SQL on a customer's project, for the RLS policies only (issue #10, decision 024).
// Endpoint: POST /v1/projects/{ref}/database/query/read-only. Scope `database:read`; Supabase runs
// the query as `supabase_read_only_user`. The only SQL Supahound sends is POLICIES_SQL, which reads
// the pg_catalog.pg_policies view: policy definitions, never table data.

export const QUERY_TIMEOUT_MS = 20_000;
// A project with more policies than this is cut off: the map would be incomplete, so it fails.
export const MAX_POLICY_ROWS = 10_000;

export class SqlQueryError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = "SqlQueryError";
  }
}

export interface ReadOnlyQuery {
  projectRef: string;
  sql: string;
}

export interface SqlClientOptions {
  token: string;
  fetch?: typeof fetch;
  baseUrl?: string;
  timeoutMs?: number;
}

// The OpenAPI spec documents no response body. Supabase's SQL endpoints return a bare row array;
// a `{ result: [...] }` wrapper is accepted too. Anything else is an error, never "no policies".
export async function queryReadOnly(query: ReadOnlyQuery, options: SqlClientOptions): Promise<Record<string, unknown>[]> {
  if (!/^[a-z0-9]{20}$/.test(query.projectRef)) {
    throw new Error(`Not a Supabase project ref: "${query.projectRef}"`);
  }
  const doFetch = options.fetch ?? fetch;
  const url = new URL(`/v1/projects/${query.projectRef}/database/query/read-only`, options.baseUrl ?? MANAGEMENT_API);
  const res = await doFetch(url, {
    method: "POST",
    headers: { Authorization: `Bearer ${options.token}`, Accept: "application/json", "Content-Type": "application/json" },
    body: JSON.stringify({ query: query.sql }),
    signal: AbortSignal.timeout(options.timeoutMs ?? QUERY_TIMEOUT_MS),
  });
  // The error body can echo SQL or database text; only the status leaves this function.
  if (!res.ok) throw new SqlQueryError(`Read-only SQL endpoint returned HTTP ${res.status}`, res.status);
  let body: unknown;
  try {
    body = await res.json();
  } catch {
    throw new SqlQueryError("Read-only SQL response is not JSON", res.status);
  }
  const rows = Array.isArray(body)
    ? body
    : body !== null && typeof body === "object" && "result" in body && Array.isArray(body.result)
      ? body.result
      : null;
  if (rows === null) throw new SqlQueryError("Read-only SQL response has no row array", res.status);
  return rows.filter((r): r is Record<string, unknown> => r !== null && typeof r === "object" && !Array.isArray(r));
}

const text = (v: unknown): string | null => (typeof v === "string" ? v : null);

// Checks each pg_policies row's shape. A row without a schema or table name is dropped; a project
// with more than MAX_POLICY_ROWS rows fails, because a cut-off map would under-report ownership.
export function parsePolicyRows(rows: Record<string, unknown>[]): PolicyRow[] {
  if (rows.length > MAX_POLICY_ROWS) throw new SqlQueryError(`More than ${MAX_POLICY_ROWS} policies`, 200);
  const out: PolicyRow[] = [];
  for (const r of rows) {
    const schemaname = text(r.schemaname);
    const tablename = text(r.tablename);
    if (!schemaname || !tablename) continue;
    const roles = Array.isArray(r.roles) ? r.roles.filter((x): x is string => typeof x === "string") : text(r.roles);
    out.push({
      schemaname,
      tablename,
      permissive: text(r.permissive),
      roles,
      cmd: text(r.cmd),
      qual: text(r.qual),
      with_check: text(r.with_check),
    });
  }
  return out;
}
