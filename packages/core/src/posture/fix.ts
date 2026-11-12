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
    }
  }

  // Advisor lints. SQL only when the lint names its object and the fix is plain SQL.
  const generic: FixPrompt = {
    title,
    explanation: `The Supabase Security Advisor reports ${f.check} on ${display}. Open Advisors → Security Advisor in the Supabase dashboard for the steps.`,
    sql: null,
  };
  if (!named) return generic;
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
