import { EDGE_FIELDS, sourceColumn, type EdgeField, type EnvVars } from "../config/fields.js";

// ClickHouse SQL for GET /v1/projects/{ref}/analytics/endpoints/logs. The time window goes in
// iso_timestamp_start/end, not in the SQL. Supabase rejects `SELECT *`, so every column is named.

function quote(value: string): string {
  return `'${value.replace(/\\/g, "\\\\").replace(/'/g, "\\'")}'`;
}

function attr(field: EdgeField): string {
  return `log_attributes[${quote(EDGE_FIELDS[field].key)}]`;
}

// Rolls identical requests up inside ClickHouse so a poll returns templates, not raw rows.
// Only two kinds of traffic can trip the baseline-free detectors, so everything else is
// filtered out before it leaves Supabase: PostgREST calls that carry a user subject, and
// any call (REST, Auth admin, Storage) made with the service-role key.
export function edgeRollupSql(options: { limit?: number; env?: EnvVars } = {}): string {
  const limit = options.limit ?? 5000;
  const fields = Object.keys(EDGE_FIELDS) as EdgeField[];
  const columns = fields.map((f) => `  ${attr(f)} AS ${f}`).join(",\n");
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
    OR ${attr("apiKeyRole")} = 'service_role'
  )
GROUP BY ${fields.join(", ")}
ORDER BY hits DESC
LIMIT ${Math.trunc(limit)}`;
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
