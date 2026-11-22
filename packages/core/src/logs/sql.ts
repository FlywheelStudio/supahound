import { EDGE_FIELDS, sourceColumn, type EdgeField, type EnvVars } from "../config/fields.js";
import { safeIdentifier } from "../detectors/finding.js";
import { safeName } from "../posture/catalog.js";

// ClickHouse SQL for GET /v1/projects/{ref}/analytics/endpoints/logs. The time window goes in
// iso_timestamp_start/end, not in the SQL. Supabase rejects `SELECT *`, so every column is named.

function quote(value: string): string {
  return `'${value.replace(/\\/g, "\\\\").replace(/'/g, "\\'")}'`;
}

function attr(field: EdgeField): string {
  return `log_attributes[${quote(EDGE_FIELDS[field].key)}]`;
}

// The most templates one poll reads. The rollup keeps the busiest, so a window with more would drop
// its quietest ones: often the single probe detector 2 looks for. The poller asks for one more and
// treats a full answer as saturated (issue #129).
export const ROLLUP_LIMIT = 5000;

// At most this many exposed tables go into one query (issue #132), so the SQL stays short.
export const MAX_ANON_READ_TABLES = 200;

// The exposed tables the anon-read branch watches: plain identifiers only (a name that is not one
// never reaches the SQL, and could not be matched to a URL path without decoding), sorted so the
// audited SQL hash is stable, capped.
export function anonReadTables(tables: Iterable<string>): string[] {
  return [...new Set(tables)]
    .filter((t) => safeName(t) !== null && safeIdentifier(t) !== null)
    .sort()
    .slice(0, MAX_ANON_READ_TABLES);
}

// At most this many functions go into one query (issue #131), so the SQL stays short.
export const MAX_ANON_RPC_FUNCTIONS = 200;

// The exposed functions the anon-RPC branch watches: plain identifiers only (a name that is not one
// never reaches the SQL, and could not be matched to a URL path without decoding), sorted so the
// audited SQL hash is stable, capped.
export function anonRpcFunctions(functions: Iterable<string>): string[] {
  return [...new Set(functions)]
    .filter((f) => safeName(f) !== null && safeIdentifier(f) !== null)
    .sort()
    .slice(0, MAX_ANON_RPC_FUNCTIONS);
}

// Anon calls (the role as effectiveRole reads it: the user JWT's, else the API key's) to the given
// RPC functions. Empty when there are none, so the SQL is unchanged.
function anonRpcBranch(functions: string[]): string {
  if (functions.length === 0) return "";
  return `
    OR (
      (${attr("jwtRole")} = 'anon' OR (${attr("jwtRole")} = '' AND ${attr("apiKeyRole")} = 'anon'))
      AND ${attr("path")} IN (${functions.map((f) => quote(`/rest/v1/rpc/${f}`)).join(", ")})
    )`;
}

// Rolls identical requests up inside ClickHouse so a poll returns templates, not raw rows.
// Only three kinds of traffic can trip the baseline-free detectors, so everything else is
// filtered out before it leaves Supabase: PostgREST calls that carry a user subject, any call
// (REST, Auth admin, Storage) made with the service-role key, anon-key reads of the tables the
// posture scan shows readable by anon (`anonReadTables`, issue #132), and anon calls to the RPC
// functions posture shows as SECURITY DEFINER and anon-executable (`anonRpcFunctions`, #131).
export function edgeRollupSql(options: { limit?: number; env?: EnvVars; anonReadTables?: Iterable<string>; anonRpcFunctions?: Iterable<string> } = {}): string {
  const limit = options.limit ?? ROLLUP_LIMIT;
  const fields = Object.keys(EDGE_FIELDS) as EdgeField[];
  const columns = fields.map((f) => `  ${attr(f)} AS ${f}`).join(",\n");
  const rpcBranch = anonRpcBranch(anonRpcFunctions(options.anonRpcFunctions ?? []));
  const watched = anonReadTables(options.anonReadTables ?? []);
  // The role as effectiveRole reads it: the user JWT's role, else the API key's.
  const anonBranch = watched.length === 0 ? "" : `
    OR (
      ${attr("method")} IN ('GET', 'HEAD')
      AND (${attr("jwtRole")} = 'anon' OR (${attr("jwtRole")} = '' AND ${attr("apiKeyRole")} = 'anon'))
      AND ${attr("path")} IN (${watched.map((t) => quote(`/rest/v1/${t}`)).join(", ")})
    )`;
  return `SELECT
${columns},
  count() AS hits,
  min(timestamp) AS first_seen,
  max(timestamp) AS last_seen
FROM logs
WHERE ${sourceColumn(options.env)} = 'edge_logs'
  AND (
    (match(${attr("path")}, '^/rest/v1/') AND ${attr("jwtSubject")} != '')
    OR ${attr("jwtRole")} = 'service_role'
    OR ${attr("apiKeyRole")} = 'service_role'${anonBranch}${rpcBranch}
  )
GROUP BY ${fields.join(", ")}
ORDER BY hits DESC
LIMIT ${Math.trunc(limit)}`;
}

// Billing (decision 028): every edge-log request in the window, counted inside ClickHouse. Returns
// one number, never a log row.
export function edgeRequestCountSql(env?: EnvVars): string {
  return `SELECT count() AS requests
FROM logs
WHERE ${sourceColumn(env)} = 'edge_logs'`;
}

// Issue #130: the rollup keeps only traffic with a user subject or a service-role key, so if
// Supabase leaves those fields empty (sb_secret_ keys are not JWTs) it returns nothing and both
// detectors would read as clean. This counts the window's PostgREST requests, and those with any
// auth field filled. Two numbers, never a log row.
export function authCoverageSql(env?: EnvVars): string {
  const rest = `match(${attr("path")}, '^/rest/v1/')`;
  return `SELECT
  countIf(${rest}) AS rest_requests,
  countIf(${rest} AND (${attr("jwtSubject")} != '' OR ${attr("jwtRole")} != '' OR ${attr("apiKeyRole")} != '')) AS rest_with_auth
FROM logs
WHERE ${sourceColumn(env)} = 'edge_logs'`;
}

// PRD task 1: lists which auth-related keys exist in edge logs, never their values,
// so the check pulls no user IDs, emails or tokens into a terminal.
export function discoverKeysSql(env?: EnvVars): string {
  return `SELECT
  arrayJoin(mapKeys(log_attributes)) AS key,
  count() AS hits
FROM logs
WHERE ${sourceColumn(env)} = 'edge_logs'
GROUP BY key
HAVING match(key, '(sb|jwt|apikey|role|auth|subject|client_info|user_agent|content_range|search)')
ORDER BY hits DESC
LIMIT 200`;
}
