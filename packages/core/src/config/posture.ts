// The only module that knows the posture scan's Supabase endpoints, catalog SQL and Advisor
// fields (issue #11, decision 038). A fix after a live check lands here alone, as fields.ts does
// for the logs.
//
// Sources (fetched 2026-11-12):
//   Advisor: https://supabase.com/docs/reference/api/v1-get-security-advisors
//     GET /v1/projects/{ref}/advisors/security. Experimental ("subject to change or removal").
//     OAuth scope database:read; fine-grained token permission advisors_read.
//     200 body: { lints: [{ name, title, level, facing, categories, description, detail,
//     remediation, metadata?: { schema, name, entity, type, ... }, cache_key, observed_at? }] }
//   Catalog: POST /v1/projects/{ref}/database/query/read-only (decision 024), run by Supabase as
//     supabase_read_only_user. Not verified live: that this role may call has_table_privilege for
//     anon and authenticated (any role may, in stock Postgres).

// Only `public` is checked: the schema PostgREST exposes by default, and the one ownership reads.
export const POSTURE_SCHEMAS = ["public"] as const;

export const ADVISOR_PATH = (ref: string) => `/v1/projects/${ref}/advisors/security`;

// The roles the Data API uses for client requests. `public` in a policy's role list means every
// role, so it counts as anon.
export const API_ROLES = ["anon", "authenticated"] as const;
export type ApiRole = (typeof API_ROLES)[number];
export const PRIVILEGES = ["SELECT", "INSERT", "UPDATE", "DELETE"] as const;
export type Privilege = (typeof PRIVILEGES)[number];

// One read-only query over the system catalog: no table data. One row per table or view in the
// checked schemas (kind 'table' | 'view'), and one per RLS policy (kind 'policy'). Every column
// is a scalar, so the Management API's JSON encoding of arrays cannot change the result.
//   grants: "anon:SELECT,authenticated:INSERT,..." from has_table_privilege (grants via PUBLIC included).
//   security_invoker: the view's reloptions set security_invoker to a true value (any case).
export const POSTURE_SQL = `WITH api_roles AS (
  SELECT r.rolname::text AS rolname FROM pg_catalog.pg_roles r WHERE r.rolname IN ('anon', 'authenticated')
), rels AS (
  SELECT c.oid, n.nspname::text AS nspname, c.relname::text AS relname, c.relkind::text AS relkind,
         c.relrowsecurity, c.relforcerowsecurity, c.reloptions
  FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
  WHERE n.nspname = 'public' AND c.relkind IN ('r', 'p', 'v')
)
SELECT CASE WHEN r.relkind = 'v' THEN 'view' ELSE 'table' END AS kind,
       r.nspname AS schema_name, r.relname AS object_name,
       r.relrowsecurity AS rls_enabled, r.relforcerowsecurity AS rls_forced,
       (SELECT count(*) FROM pg_catalog.pg_policy p WHERE p.polrelid = r.oid)::int AS policy_count,
       EXISTS (SELECT 1 FROM unnest(coalesce(r.reloptions, '{}'::text[])) AS o(opt)
               WHERE lower(split_part(o.opt, '=', 1)) = 'security_invoker'
                 AND lower(split_part(o.opt, '=', 2)) IN ('true', 'on', '1', 'yes')) AS security_invoker,
       array_to_string(ARRAY(
         SELECT a.rolname || ':' || pr.priv
         FROM api_roles a CROSS JOIN unnest(ARRAY['SELECT', 'INSERT', 'UPDATE', 'DELETE']) AS pr(priv)
         WHERE has_table_privilege(a.rolname, r.oid, pr.priv)
         ORDER BY 1), ',') AS grants,
       NULL::text AS policy_name, NULL::text AS permissive, NULL::text AS roles, NULL::text AS cmd,
       NULL::text AS qual, NULL::text AS with_check
FROM rels r
UNION ALL
SELECT 'policy', p.schemaname::text, p.tablename::text, NULL, NULL, NULL, NULL, NULL,
       p.policyname::text, p.permissive, array_to_string(p.roles, ','), p.cmd, p.qual, p.with_check
FROM pg_catalog.pg_policies p
WHERE p.schemaname = 'public'
ORDER BY 1, 2, 3`;

// A project with more catalog rows than this fails: a cut-off result would under-report.
export const MAX_CATALOG_ROWS = 10_000;
// The Advisor answer is cut at this many lints; more fail the same way.
export const MAX_ADVISOR_LINTS = 2_000;

// The Advisor response fields Supahound reads. Nothing else in a lint is read.
export const ADVISOR_FIELDS = {
  lints: "lints",
  name: "name",
  level: "level",
  categories: "categories",
  metadata: "metadata",
  schema: "schema",
  object: "name",
  type: "type",
} as const;

export type AdvisorLevel = "ERROR" | "WARN" | "INFO";
export const ADVISOR_LEVELS: readonly AdvisorLevel[] = ["ERROR", "WARN", "INFO"];

// Advisor `metadata.type` values (the reference's enum). Anything else is stored as null.
export const ADVISOR_OBJECT_TYPES = [
  "table", "view", "materialized view", "foreign table", "auth", "function", "extension", "compliance", "health",
] as const;
export type AdvisorObjectType = (typeof ADVISOR_OBJECT_TYPES)[number];

// The lint `name` enum in the reference (45 values, 2026-11-12). A name outside this list is
// still kept when it is a plain snake_case word (Supabase adds lints), with a generic fix prompt.
export const ADVISOR_LINTS = [
  "unindexed_foreign_keys", "auth_users_exposed", "auth_rls_initplan", "no_primary_key", "unused_index",
  "multiple_permissive_policies", "policy_exists_rls_disabled", "rls_enabled_no_policy", "duplicate_index",
  "security_definer_view", "function_search_path_mutable", "rls_disabled_in_public", "extension_in_public",
  "rls_references_user_metadata", "materialized_view_in_api", "foreign_table_in_api", "unsupported_reg_types",
  "auth_otp_long_expiry", "auth_otp_short_length", "ssl_not_enforced", "log_connections_not_enabled",
  "network_restrictions_not_set", "password_requirements_min_length", "pitr_not_enabled",
  "auth_leaked_password_protection", "auth_insufficient_mfa_options", "auth_password_policy_missing",
  "leaked_service_key", "no_backup_admin", "vulnerable_postgres_version", "db_not_reachable",
  "db_connection_failing", "db_connection_limit_reached", "instance_telemetry_lost", "instance_db_down",
  "instance_alert_firing", "log_data_api_error_rate_high", "log_auth_error_rate_high",
  "log_storage_error_rate_high", "log_edge_function_error_rate_high", "realtime_authorization_timeouts",
  "realtime_postgres_changes_spike", "realtime_concurrent_users_near_limit", "project_not_active",
  "advisor_check_unavailable",
] as const;

export const LINT_NAME_RE = /^[a-z0-9_]{1,64}$/;

// The Advisor says it could not run its checks. The scan records "unable to assess", never zero findings.
export const ADVISOR_UNAVAILABLE_LINT = "advisor_check_unavailable";

// The Advisor's own category for these lints; others (PERFORMANCE, HEALTH) are dropped.
export const ADVISOR_SECURITY_CATEGORY = "SECURITY";
