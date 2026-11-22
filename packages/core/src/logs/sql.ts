import {
  EDGE_FIELDS, KEY_KIND_COLUMNS, KEY_KIND_MARKERS, KEY_PREFIX_FIELDS, sourceColumn,
  type EdgeField, type EnvVars, type KeyKindColumn,
} from "../config/fields.js";
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

// Issue #154: the key kind, worked out inside ClickHouse from a key-prefix field. The prefix holds
// key material after the type marker, so it is only ever read here, inside startsWith, and never
// selected or grouped on: only the enum leaves Supabase.
export function keyKindSql(column: KeyKindColumn): string {
  const prefix = `log_attributes[${quote(KEY_PREFIX_FIELDS[KEY_KIND_COLUMNS[column]].key)}]`;
  const branches = KEY_KIND_MARKERS.map(([kind, marker]) => `startsWith(${prefix}, ${quote(marker)}), '${kind}'`);
  return `multiIf(${branches.join(", ")}, ${prefix} = '', 'none', 'other')`;
}

const KIND_COLUMNS = Object.keys(KEY_KIND_COLUMNS) as KeyKindColumn[];

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

// The role as effectiveRole reads it: the user JWT's role, else the legacy API key's, else the
// new key's kind (#154: a publishable key is anon; authenticated always needs a user JWT).
function roleIs(role: "anon" | "authenticated"): string {
  const jwt = `${attr("jwtRole")} = '${role}' OR (${attr("jwtRole")} = '' AND ${attr("apiKeyRole")} = '${role}')`;
  if (role === "authenticated") return `(${jwt})`;
  return `(${jwt} OR (${attr("jwtRole")} = '' AND ${attr("apiKeyRole")} = '' AND ${keyKindSql("apiKeyKind")} = 'publishable'))`;
}

// Service-role traffic: a legacy JWT with the service_role role, or a new sb_secret_ key (#154).
function serviceRole(): string {
  return `${attr("jwtRole")} = 'service_role'
    OR ${attr("apiKeyRole")} = 'service_role'
    OR ${keyKindSql("apiKeyKind")} = 'secret'`;
}

// Anon calls to the given RPC functions. Empty when there are none, so the SQL is unchanged.
function anonRpcBranch(functions: string[]): string {
  if (functions.length === 0) return "";
  return `
    OR (
      ${roleIs("anon")}
      AND ${attr("path")} IN (${functions.map((f) => quote(`/rest/v1/rpc/${f}`)).join(", ")})
    )`;
}

// Storage's list endpoint (issue #157): POST /storage/v1/object/list/<bucket>. One fixed prefix
// for every bucket, so the branch never grows; the detector names only the buckets posture knows.
export const STORAGE_LIST_PREFIX = "/storage/v1/object/list/";

// Rolls identical requests up inside ClickHouse so a poll returns templates, not raw rows.
// Only these kinds of traffic can trip the baseline-free detectors, so everything else is
// filtered out before it leaves Supabase: PostgREST calls that carry a user subject (signed-in
// calls to SECURITY DEFINER functions among them, #157), any call (REST, Auth admin, Storage) made
// with the service-role key, anon-key reads of the tables the posture scan shows readable by anon
// (`anonReadTables`, issue #132), anon calls to the RPC functions posture shows as SECURITY DEFINER
// and anon-executable (`anonRpcFunctions`, #131), and anon calls to Storage's list endpoint (#157).
// Service role and anon include the new sb_secret_ and sb_publishable_ keys (#154): the rollup
// selects their key kinds, never their prefixes.
export function edgeRollupSql(options: { limit?: number; env?: EnvVars; anonReadTables?: Iterable<string>; anonRpcFunctions?: Iterable<string> } = {}): string {
  const limit = options.limit ?? ROLLUP_LIMIT;
  const fields = Object.keys(EDGE_FIELDS) as EdgeField[];
  const columns = [
    ...fields.map((f) => `  ${attr(f)} AS ${f}`),
    ...KIND_COLUMNS.map((k) => `  ${keyKindSql(k)} AS ${k}`),
  ].join(",\n");
  const rpcBranch = anonRpcBranch(anonRpcFunctions(options.anonRpcFunctions ?? []));
  const watched = anonReadTables(options.anonReadTables ?? []);
  const anonBranch = watched.length === 0 ? "" : `
    OR (
      ${attr("method")} IN ('GET', 'HEAD')
      AND ${roleIs("anon")}
      AND ${attr("path")} IN (${watched.map((t) => quote(`/rest/v1/${t}`)).join(", ")})
    )`;
  const storageBranch = `
    OR (${roleIs("anon")} AND match(${attr("path")}, ${quote(`^${STORAGE_LIST_PREFIX}`)}))`;
  return `SELECT
${columns},
  count() AS hits,
  min(timestamp) AS first_seen,
  max(timestamp) AS last_seen
FROM logs
WHERE ${sourceColumn(options.env)} = 'edge_logs'
  AND (
    (match(${attr("path")}, '^/rest/v1/') AND ${attr("jwtSubject")} != '')
    OR ${serviceRole()}${anonBranch}${rpcBranch}${storageBranch}
  )
GROUP BY ${[...fields, ...KIND_COLUMNS].join(", ")}
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

// pg_graphql's endpoint. Request bodies are not in edge logs, so a poll only counts its calls.
const GRAPHQL_PATH = "^/graphql/v1(/|$)";

// The poll's counts (issues #133 and #157), counted inside ClickHouse: every edge-log request in
// the window (as edgeRequestCountSql), and the GraphQL calls made with the anon role and with the
// authenticated role. Three numbers, never a log row.
export function pollCountSql(env?: EnvVars): string {
  const graphql = `match(${attr("path")}, ${quote(GRAPHQL_PATH)})`;
  return `SELECT
  count() AS requests,
  countIf(${graphql} AND ${roleIs("anon")}) AS graphql_anon,
  countIf(${graphql} AND ${roleIs("authenticated")}) AS graphql_authenticated
FROM logs
WHERE ${sourceColumn(env)} = 'edge_logs'`;
}

// Issue #130: the rollup keeps only traffic with a user subject or a service-role key, so if
// Supabase leaves those fields empty it returns nothing and both detectors would read as clean.
// This counts the window's PostgREST requests, those with a JWT field filled (a user subject can
// only come from a JWT: detector 2), and those whose API key is of a known kind (#154: an
// sb_secret_ or sb_publishable_ key fills no JWT field, but its kind gives the role: detector 4).
// Three numbers, never a log row.
export function authCoverageSql(env?: EnvVars): string {
  const rest = `match(${attr("path")}, '^/rest/v1/')`;
  return `SELECT
  countIf(${rest}) AS rest_requests,
  countIf(${rest} AND (${attr("jwtSubject")} != '' OR ${attr("jwtRole")} != '' OR ${attr("apiKeyRole")} != '')) AS rest_with_auth,
  countIf(${rest} AND ${keyKindSql("apiKeyKind")} IN ('secret', 'publishable', 'jwt')) AS rest_with_key_kind
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

// Issue #154: how many edge-log requests carried each kind of API key and Authorization header.
// Kinds are worked out inside ClickHouse; the prefixes themselves never leave Supabase.
export function keyKindCountsSql(env?: EnvVars): string {
  return `SELECT
${KIND_COLUMNS.map((k) => `  ${keyKindSql(k)} AS ${k}`).join(",\n")},
  count() AS hits
FROM logs
WHERE ${sourceColumn(env)} = 'edge_logs'
GROUP BY ${KIND_COLUMNS.join(", ")}
ORDER BY hits DESC`;
}
