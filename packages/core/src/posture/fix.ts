import type { PostureFinding } from "./types.js";

// Fix prompts (issue #11, decision 038): built from templates and the finding's structured
// fields only (check, object identifiers, enums, counts). Never from log text, Supabase's free
// text or a model. Every identifier is double-quoted; safeName (catalog.ts) already refused
// control characters, so no name can end a SQL comment line.

export interface FixPrompt {
  title: string;
  explanation: string;
  // Copyable SQL, or null when the fix is in the Supabase dashboard, not in SQL.
  sql: string | null;
}

export function quoteIdent(name: string): string {
  return `"${name.replace(/"/g, '""')}"`;
}

const str = (v: unknown): string | null => (typeof v === "string" ? v : null);
const strs = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : []);
const num = (v: unknown): number => (typeof v === "number" && Number.isInteger(v) && v >= 0 ? v : 0);

const REACH: Record<string, string> = {
  anon: "Anyone with the project's anon key (it ships in your app) can reach it through the Data API.",
  authenticated: "Every signed-in user can reach it through the Data API.",
  none: "The anon and authenticated roles have no grant on it today, so the Data API cannot reach it. A later GRANT would expose it at once.",
};

const OWNER_EXAMPLE = (target: string) => [
  "-- Example: each signed-in user reads only their own rows. Replace user_id with the owner column.",
  `CREATE POLICY "Owners read their rows" ON ${target}`,
  "  FOR SELECT TO authenticated",
  "  USING ((select auth.uid()) = user_id);",
];

function enableRls(target: string, display: string, policyCount: number): string {
  const lines = [`-- Turn on row level security for ${display}.`];
  if (policyCount > 0) {
    lines.push(`-- Its ${policyCount} existing ${policyCount === 1 ? "policy takes" : "policies take"} effect at once. Review ${policyCount === 1 ? "it" : "them"} first.`);
    lines.push(`ALTER TABLE ${target} ENABLE ROW LEVEL SECURITY;`);
  } else {
    lines.push("-- With RLS on and no policy, the Data API returns no rows, so add the policies your app needs.");
    lines.push(`ALTER TABLE ${target} ENABLE ROW LEVEL SECURITY;`, "", ...OWNER_EXAMPLE(target));
  }
  return lines.join("\n");
}

const securityInvoker = (target: string, display: string) =>
  [`-- Make ${display} apply the caller's RLS policies (Postgres 15 and later).`, `ALTER VIEW ${target} SET (security_invoker = true);`].join("\n");

const revokeApi = (target: string, display: string) =>
  [`-- Remove ${display} from the Data API.`, `REVOKE SELECT ON ${target} FROM anon, authenticated;`].join("\n");

// Titles for the Advisor lints Supahound knows. Others get the lint name in words.
export const LINT_TITLE: Readonly<Record<string, string>> = {
  rls_disabled_in_public: "Row level security is off",
  policy_exists_rls_disabled: "Policies exist, but row level security is off",
  rls_enabled_no_policy: "RLS is on, but no policy exists",
  security_definer_view: "View runs with its owner's rights",
  function_search_path_mutable: "Function has a mutable search_path",
  extension_in_public: "Extension installed in the public schema",
  auth_users_exposed: "auth.users is exposed through the Data API",
  materialized_view_in_api: "Materialized view is exposed through the Data API",
  foreign_table_in_api: "Foreign table is exposed through the Data API",
  rls_references_user_metadata: "A policy trusts user_metadata",
  unsupported_reg_types: "Column uses an unsupported reg* type",
  auth_otp_long_expiry: "Email OTP expiry is too long",
  auth_otp_short_length: "Email OTP is too short",
  auth_leaked_password_protection: "Leaked password protection is off",
  auth_insufficient_mfa_options: "Too few MFA options are enabled",
  auth_password_policy_missing: "No password policy is set",
  password_requirements_min_length: "Minimum password length is too short",
  leaked_service_key: "A service-role key has leaked",
  ssl_not_enforced: "SSL is not enforced for database connections",
  network_restrictions_not_set: "No network restrictions are set",
  vulnerable_postgres_version: "Postgres version has security patches available",
  // splinter 0019 to 0032 (issue #134).
  insecure_queue_exposed_in_api: "Queue table is exposed through the Data API without RLS",
  fkey_to_auth_unique: "Foreign key points at an auth unique constraint",
  extension_versions_outdated: "Extension is not on its current version",
  sensitive_columns_exposed: "Sensitive columns are readable without RLS",
  rls_policy_always_true: "A policy lets any row be changed",
  public_bucket_allows_listing: "Anyone can list the files in a public bucket",
  pg_graphql_anon_table_exposed: "Signed-out visitors can see this object in the GraphQL schema",
  pg_graphql_authenticated_table_exposed: "Signed-in users can see this object in the GraphQL schema",
  anon_security_definer_function_executable: "Signed-out visitors can run a SECURITY DEFINER function",
  authenticated_security_definer_function_executable: "Signed-in users can run a SECURITY DEFINER function",
  anon_dynamic_sql_function_executable: "Signed-out visitors can run a function that executes their SQL",
  authenticated_dynamic_sql_function_executable: "Signed-in users can run a function that executes their SQL",
};

export const CHECK_TITLE: Readonly<Record<string, string>> = {
  rls_disabled: "Row level security is off",
  rls_no_policies: "RLS is on, but no policy exists",
  view_not_invoker: "View runs with its owner's rights",
};

export function checkTitle(f: Pick<PostureFinding, "source" | "check" | "evidence">): string {
  if (f.source === "advisor") {
    const t = LINT_TITLE[f.check];
    return t ?? `${f.check.charAt(0).toUpperCase()}${f.check.slice(1).replace(/_/g, " ")}`;
  }
  if (f.check === "function_definer_exposed") {
    return f.evidence.exposure === "anon" ? "Signed-out visitors can run a SECURITY DEFINER function" : "Signed-in users can run a SECURITY DEFINER function";
  }
  if (f.check === "graphql_table_exposed") {
    return f.evidence.exposure === "anon" ? "Signed-out visitors can see this object in the GraphQL schema" : "Signed-in users can see this object in the GraphQL schema";
  }
  if (f.check === "permissive_policy") {
    return strs(f.evidence.openCommands).some((c) => c !== "SELECT") ? "A policy lets any row be changed" : "A policy lets every row be read";
  }
  return CHECK_TITLE[f.check] ?? f.check;
}

function permissive(f: PostureFinding, target: string, display: string): FixPrompt {
  const policy = str(f.evidence.policy) ?? "policy";
  const command = str(f.evidence.command) ?? "ALL";
  const open = strs(f.evidence.openCommands);
  const roles = strs(f.evidence.roles);
  const exposure = str(f.evidence.exposure) ?? "none";
  const writes = open.some((c) => c !== "SELECT");
  const clause = command === "INSERT" ? "WITH CHECK" : command === "SELECT" || command === "DELETE" ? "USING" : "USING and WITH CHECK";
  const scoped = "((select auth.uid()) = user_id)";
  const alter = [`ALTER POLICY ${quoteIdent(policy)} ON ${target}`];
  if (command !== "INSERT") alter.push(`  USING ${scoped}`);
  if (command === "INSERT" || command === "UPDATE" || command === "ALL") alter.push(`  WITH CHECK ${scoped}`);
  alter[alter.length - 1] += ";";
  const sql = [
    `-- Policy ${quoteIdent(policy)} on ${display} passes every row (${clause} true) for ${open.join(", ")} by ${roles.join(", ") || "every role"}.`,
    "-- Scope it to the row's owner. Replace user_id with the owner column.",
    ...alter,
  ];
  if (!writes) sql.push("", "-- If every row is meant to be public, keep the policy and check the table holds no private columns.");
  return {
    title: checkTitle(f),
    explanation: `Policy ${policy} on ${display} allows ${open.join(", ")} on every row. ${REACH[exposure] ?? ""}`.trim(),
    sql: sql.join("\n"),
  };
}

// Catalog checks of issue #135 (ported from splinter 0026 to 0029; remediation per splinter's docs).
const roleList = (v: unknown): ("anon" | "authenticated")[] =>
  strs(v).filter((r): r is "anon" | "authenticated" => r === "anon" || r === "authenticated");

function definerExposed(f: PostureFinding, title: string, target: string, display: string): FixPrompt {
  const roles = roleList(f.evidence.executableBy);
  const args = str(f.evidence.arguments);
  const sig = args === null ? target : `${target}(${args})`;
  const exposure = str(f.evidence.exposure) ?? "none";
  const lines = [
    `-- ${display} is SECURITY DEFINER: it runs as its owner, past every RLS policy. ${roles.join(" and ") || "An API role"} can EXECUTE it.`,
    ...(args === null ? ["-- Add the argument types after the name if the function is overloaded."] : []),
    "-- If callers should not run it, revoke EXECUTE. Postgres grants it to PUBLIC by default, so revoke that too; service_role keeps its own grant.",
    `REVOKE EXECUTE ON FUNCTION ${sig} FROM ${["PUBLIC", ...roles].join(", ")};`,
    "",
    "-- If it must stay callable, run it with the caller's rights so RLS applies:",
    `-- ALTER FUNCTION ${sig} SECURITY INVOKER;`,
  ];
  if (f.evidence.searchPathSet === false) {
    lines.push("", "-- It also resolves names through the caller's search_path. Pin it:", `ALTER FUNCTION ${sig} SET search_path = '';`);
  }
  return {
    title,
    explanation: `${display} runs with its owner's rights, past every RLS policy, and ${exposure === "anon" ? "anyone with the project's anon key" : "every signed-in user"} can call it at /rest/v1/rpc/${f.object}.`,
    sql: lines.join("\n"),
  };
}

function graphqlTable(f: PostureFinding, title: string, target: string, display: string): FixPrompt {
  const roles = roleList(f.evidence.roles);
  const who = roles.join(", ") || "anon, authenticated";
  return {
    title,
    explanation: `pg_graphql is installed and ${who} can SELECT ${display}, so its name, columns and relationships show in the GraphQL schema at /graphql/v1. RLS still filters its rows.`,
    sql: [
      `-- Hide ${display} from GraphQL for ${who}. This also stops ${roles.length === 1 ? "that role" : "those roles"} reading it through the REST API.`,
      `REVOKE SELECT ON ${target} FROM ${who};`,
      "",
      "-- If the app does not use GraphQL, block the endpoint for the API roles instead:",
      "-- REVOKE ALL ON FUNCTION graphql.resolve FROM anon, authenticated;",
    ].join("\n"),
  };
}

// The newer splinter lints (issue #134). Their remediation follows splinter's own docs
// (https://github.com/supabase/splinter/tree/main/docs), written as templates over structured fields.

type ApiRoleName = "anon" | "authenticated";
const lintRole = (check: string): ApiRoleName => (check.startsWith("anon_") ? "anon" : "authenticated");
const WHO: Record<ApiRoleName, string> = { anon: "anyone with the project's anon key", authenticated: "every signed-in user" };

// A function's signature for REVOKE and ALTER FUNCTION: with its identity arguments when known.
function functionSignature(target: string, f: PostureFinding): { sig: string; lines: string[] } {
  const args = str(f.evidence.arguments);
  return args === null
    ? { sig: target, lines: ["-- Add the argument types after the name if the function is overloaded."] }
    : { sig: `${target}(${args})`, lines: [] };
}

function definerFunction(f: PostureFinding, title: string, target: string, display: string): FixPrompt {
  const role = lintRole(f.check);
  const { sig, lines } = functionSignature(target, f);
  return {
    title,
    explanation: `${display} runs with its owner's rights, past every RLS policy, and ${WHO[role]} can call it at /rest/v1/rpc/${f.object}.`,
    sql: [
      `-- ${display} is SECURITY DEFINER and ${role} can EXECUTE it.`,
      ...lines,
      "-- If it is not meant for them, revoke EXECUTE. Postgres grants it to PUBLIC by default, so revoke that too; service_role keeps its own grant.",
      `REVOKE EXECUTE ON FUNCTION ${sig} FROM PUBLIC, ${role};`,
      "",
      "-- If it must stay callable, run it with the caller's rights so RLS applies:",
      `-- ALTER FUNCTION ${sig} SECURITY INVOKER;`,
    ].join("\n"),
  };
}

function dynamicSqlFunction(f: PostureFinding, title: string, target: string, display: string): FixPrompt {
  const role = lintRole(f.check);
  const { sig, lines } = functionSignature(target, f);
  const definer = f.evidence.securityDefiner === true;
  return {
    title,
    explanation: `${display} appears to run SQL text passed in by the caller${definer ? ", with its owner's rights" : ""}, and ${WHO[role]} can call it at /rest/v1/rpc/${f.object}.`,
    sql: [
      `-- ${display} appears to EXECUTE text from its arguments, and ${role} can call it.`,
      ...lines,
      `REVOKE EXECUTE ON FUNCTION ${sig} FROM PUBLIC, ${role};`,
      "",
      "-- Then replace it with one function per operation that runs a fixed statement. If SQL must be",
      "-- built, pass values with EXECUTE ... USING and quote names with quote_ident().",
    ].join("\n"),
  };
}

function graphqlExposed(f: PostureFinding, title: string, target: string, display: string): FixPrompt {
  const role = lintRole(f.check.replace(/^pg_graphql_/, ""));
  return {
    title,
    explanation: `${role} can SELECT ${display}, so its name, columns and relationships show in the GraphQL schema at /graphql/v1 to ${WHO[role]}. RLS still filters its rows.`,
    sql: [
      `-- Hide ${display} from ${role}. This also stops ${role} reading it through the REST API.`,
      `REVOKE SELECT ON ${target} FROM ${role};`,
      "",
      `-- If ${role} needs no GraphQL at all, block the endpoint for it instead:`,
      `-- REVOKE ALL ON FUNCTION graphql.resolve FROM ${role};`,
    ].join("\n"),
  };
}

function alwaysTruePolicy(f: PostureFinding, title: string, target: string, display: string): FixPrompt {
  const policy = str(f.evidence.policy);
  if (policy === null) {
    return {
      title,
      explanation: `A policy on ${display} lets every row be changed. Scope its USING and WITH CHECK to the row's owner.`,
      sql: null,
    };
  }
  const command = str(f.evidence.command) ?? "ALL";
  const scoped = "((select auth.uid()) = user_id)";
  const alter = [`ALTER POLICY ${quoteIdent(policy)} ON ${target}`];
  if (command !== "INSERT") alter.push(`  USING ${scoped}`);
  if (command === "INSERT" || command === "UPDATE" || command === "ALL") alter.push(`  WITH CHECK ${scoped}`);
  alter[alter.length - 1] += ";";
  return {
    title,
    explanation: `Policy ${policy} on ${display} lets ${command} change any row: its expression is always true.`,
    sql: [`-- Scope policy ${quoteIdent(policy)} on ${display} to the row's owner. Replace user_id with the owner column.`, ...alter].join("\n"),
  };
}

function newerLint(f: PostureFinding, title: string, target: string, display: string): FixPrompt | null {
  switch (f.check) {
    case "insecure_queue_exposed_in_api":
      return {
        title,
        explanation: `Queue table ${display} has row level security off, so anyone with the project URL and anon key can read, change and delete its messages through pgmq_public.`,
        sql: [
          `-- Turn on RLS for queue table ${display}. The Data API then reaches no message until you add policies.`,
          `ALTER TABLE ${target} ENABLE ROW LEVEL SECURITY;`,
          "",
          "-- If no client uses queues through the Data API, remove pgmq_public from the exposed schemas",
          "-- in the project's Data API settings instead.",
        ].join("\n"),
      };
    case "fkey_to_auth_unique": {
      const fk = str(f.evidence.foreignKey);
      const explanation = `${display} has a foreign key${fk ? ` ${fk}` : ""} to a unique constraint in the auth schema. Supabase plans to remove those constraints, and the key would block Auth upgrades and security patches.`;
      if (fk === null) return { title, explanation, sql: null };
      return {
        title,
        explanation,
        sql: [
          `-- Point ${quoteIdent(fk)} at the primary key auth.users (id). Replace user_id with the referencing column.`,
          `ALTER TABLE ${target} DROP CONSTRAINT ${quoteIdent(fk)};`,
          `ALTER TABLE ${target} ADD CONSTRAINT ${quoteIdent(fk)} FOREIGN KEY (user_id) REFERENCES auth.users (id);`,
        ].join("\n"),
      };
    }
    case "sensitive_columns_exposed": {
      const cols = strs(f.evidence.sensitiveColumns);
      const named = cols.length > 0 ? `Columns ${cols.join(", ")} look` : "Some columns look";
      return {
        title,
        explanation: `${display} has row level security off and an API role can read it. ${named} like credentials or personal data.`,
        sql: [
          `-- Turn on row level security for ${display}. Existing policies take effect at once; with none, the Data API returns no rows.`,
          `ALTER TABLE ${target} ENABLE ROW LEVEL SECURITY;`,
          "",
          ...OWNER_EXAMPLE(target),
          "",
          "-- Secrets the client never needs (password hashes, API keys) belong outside the Data API, in a",
          "-- schema it does not serve or in Supabase Vault.",
        ].join("\n"),
      };
    }
    case "rls_policy_always_true":
      return alwaysTruePolicy(f, title, target, display);
    case "public_bucket_allows_listing": {
      const policies = strs(f.evidence.policies);
      return {
        title,
        explanation: `Bucket ${f.object} is public and a broad SELECT policy on storage.objects lets clients list every file in it. Public object URLs work without that policy.`,
        sql: policies.length === 0 ? null : [
          `-- Drop the listing ${policies.length === 1 ? "policy" : "policies"} for bucket ${f.object}. Public URLs keep working.`,
          "-- If clients must list files, make the bucket private instead.",
          ...policies.map((p) => `DROP POLICY IF EXISTS ${quoteIdent(p)} ON storage.objects;`),
        ].join("\n"),
      };
    }
    case "pg_graphql_anon_table_exposed":
    case "pg_graphql_authenticated_table_exposed":
      return graphqlExposed(f, title, target, display);
    case "anon_security_definer_function_executable":
    case "authenticated_security_definer_function_executable":
      return definerFunction(f, title, target, display);
    case "anon_dynamic_sql_function_executable":
    case "authenticated_dynamic_sql_function_executable":
      return dynamicSqlFunction(f, title, target, display);
    default:
      return null;
  }
}

function outdatedExtension(f: PostureFinding, title: string): FixPrompt {
  const ext = str(f.evidence.extension) ?? f.object;
  const installed = str(f.evidence.installedVersion);
  const latest = str(f.evidence.defaultVersion);
  const versions = installed && latest ? ` (installed ${installed}, current ${latest})` : "";
  return {
    title,
    explanation: `Extension ${ext ?? "unknown"} is not on its current version${versions}. Older versions can miss security patches and are outside the Supabase SLA.`,
    sql: ext === null ? null : [
      "-- Read the extension's changelog and try the update on a branch or a copy first.",
      `ALTER EXTENSION ${quoteIdent(ext)} UPDATE;`,
    ].join("\n"),
  };
}

export function fixPrompt(f: PostureFinding): FixPrompt {
  const title = checkTitle(f);
  const named = f.schema !== null && f.object !== null;
  const target = named ? `${quoteIdent(f.schema!)}.${quoteIdent(f.object!)}` : "";
  const display = named ? `${f.schema}.${f.object}` : f.object ?? "this project";
  const exposure = str(f.evidence.exposure);
  const reach = exposure ? ` ${REACH[exposure] ?? ""}` : "";

  if (f.source === "catalog") {
    switch (f.check) {
      case "rls_disabled": {
        const n = num(f.evidence.policyCount);
        const extra = n > 0 ? ` It has ${n} ${n === 1 ? "policy" : "policies"}, but they do nothing while RLS is off.` : "";
        return { title, explanation: `${display} has row level security off.${reach}${extra}`, sql: enableRls(target, display, n) };
      }
      case "rls_no_policies":
        return {
          title,
          explanation: `${display} has RLS on and no policy, so the Data API can neither read nor write it. If that is intended, there is nothing to do.`,
          sql: [`-- ${display} has RLS on and no policy. If your app needs access, add a policy.`, ...OWNER_EXAMPLE(target)].join("\n"),
        };
      case "view_not_invoker":
        return {
          title,
          explanation: `${display} runs as its owner, so it skips the RLS policies of the tables it reads.${reach}`,
          sql: securityInvoker(target, display),
        };
      case "permissive_policy":
        return permissive(f, target, display);
      case "function_definer_exposed":
        return definerExposed(f, title, target, display);
      case "graphql_table_exposed":
        return graphqlTable(f, title, target, display);
    }
  }

  // Advisor lints. SQL only when the lint names its object and the fix is plain SQL.
  const generic: FixPrompt = {
    title,
    explanation: `The Supabase Security Advisor reports ${f.check} on ${display}. Open Advisors → Security Advisor in the Supabase dashboard for the steps.`,
    sql: null,
  };
  // extension_versions_outdated names an extension but no schema.
  if (f.check === "extension_versions_outdated") return outdatedExtension(f, title);
  if (!named) return generic;
  const newer = newerLint(f, title, target, display);
  if (newer !== null) return newer;
  switch (f.check) {
    case "rls_disabled_in_public":
    case "policy_exists_rls_disabled":
      return { title, explanation: `${display} has row level security off.`, sql: enableRls(target, display, f.check === "policy_exists_rls_disabled" ? 1 : 0) };
    case "rls_enabled_no_policy":
      return { title, explanation: `${display} has RLS on and no policy.`, sql: [`-- ${display} has RLS on and no policy. If your app needs access, add a policy.`, ...OWNER_EXAMPLE(target)].join("\n") };
    case "security_definer_view":
      return { title, explanation: `${display} runs as its owner, so it skips the RLS policies of the tables it reads.`, sql: securityInvoker(target, display) };
    case "function_search_path_mutable":
      return {
        title,
        explanation: `${display} resolves names through the caller's search_path, which a caller can change.`,
        sql: [
          `-- Pin the search_path of ${display}. Add the argument types after the name if it is overloaded.`,
          `ALTER FUNCTION ${target} SET search_path = '';`,
        ].join("\n"),
      };
    case "extension_in_public":
      return {
        title,
        explanation: `Extension ${f.object} is in the public schema, so the Data API may expose its objects.`,
        sql: ["CREATE SCHEMA IF NOT EXISTS extensions;", `ALTER EXTENSION ${quoteIdent(f.object!)} SET SCHEMA extensions;`].join("\n"),
      };
    case "auth_users_exposed":
    case "materialized_view_in_api":
    case "foreign_table_in_api":
      return { title, explanation: `${display} is readable through the Data API without RLS.`, sql: revokeApi(target, display) };
    default:
      return generic;
  }
}
