import { API_ROLES, MAX_CATALOG_ROWS, POSTURE_SCHEMAS, PRIVILEGES, type ApiRole, type Privilege } from "../config/posture.js";
import type { Severity } from "../detectors/finding.js";
import type { Exposure, PostureFinding } from "./types.js";

// The catalog checks (issue #11, decision 038), over the rows of POSTURE_SQL. Pure functions:
// rows in, findings out. Policy expressions are read only to decide "is it `true`"; they are
// never stored, shown or sent anywhere.

export class CatalogError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CatalogError";
  }
}

export interface CatalogRelation {
  kind: "table" | "view";
  schema: string;
  name: string;
  rlsEnabled: boolean;
  rlsForced: boolean;
  policyCount: number;
  securityInvoker: boolean;
  grants: Set<string>; // "anon:SELECT", "authenticated:INSERT", ...
  // API roles that see it in pg_graphql's schema; null when pg_graphql is not installed.
  graphqlRoles: ApiRole[] | null;
}

// A SECURITY DEFINER function in a checked schema (issue #135).
export interface CatalogFunction {
  schema: string;
  name: string;
  // pg_get_function_identity_arguments: tells overloads apart and completes REVOKE ... ON FUNCTION.
  arguments: string;
  securityDefiner: boolean;
  searchPathSet: boolean;
  executableBy: ApiRole[];
}

export interface CatalogPolicy {
  schema: string;
  table: string;
  name: string;
  permissive: boolean;
  roles: string[];
  cmd: "SELECT" | "INSERT" | "UPDATE" | "DELETE" | "ALL";
  qual: string | null;
  withCheck: string | null;
}

export interface Catalog {
  relations: CatalogRelation[];
  policies: CatalogPolicy[];
  functions: CatalogFunction[];
  // Rows dropped for a bad shape or an unsafe name. Counted, never stored.
  skipped: number;
}

// A catalog identifier Supahound may store and quote: 1 to 63 characters (Postgres' limit), no
// control characters. Anything else is dropped, so a name can never break a line of a fix prompt.
export function safeName(v: unknown): string | null {
  // eslint-disable-next-line no-control-regex
  return typeof v === "string" && v.length >= 1 && v.length <= 63 && !/[\u0000-\u001f\u007f]/.test(v) ? v : null;
}

function bool(v: unknown): boolean | null {
  if (typeof v === "boolean") return v;
  if (v === "t" || v === "true") return true;
  if (v === "f" || v === "false") return false;
  return null;
}

function count(v: unknown): number | null {
  const n = typeof v === "number" ? v : typeof v === "string" && /^\d{1,9}$/.test(v) ? Number(v) : NaN;
  return Number.isInteger(n) && n >= 0 ? n : null;
}

// "a,b", "{a,b}" or ["a","b"] → ["a","b"].
function list(v: unknown): string[] {
  if (Array.isArray(v)) return v.filter((x): x is string => typeof x === "string").map((x) => x.trim()).filter(Boolean);
  if (typeof v !== "string") return [];
  return v.replace(/^\{|\}$/g, "").split(",").map((x) => x.trim().replace(/^"|"$/g, "")).filter(Boolean);
}

const text = (v: unknown): string | null => (typeof v === "string" ? v : null);
const apiRoles = (v: unknown): ApiRole[] => API_ROLES.filter((r) => list(v).includes(r));

// A function's identity arguments: at most 512 characters and no control characters, so they can
// sit on one SQL line of a fix prompt.
export function safeArguments(v: unknown): string | null {
  // eslint-disable-next-line no-control-regex
  return typeof v === "string" && v.length <= 512 && !/[\u0000-\u001f\u007f]/.test(v) ? v : null;
}
const CMDS = new Set(["SELECT", "INSERT", "UPDATE", "DELETE", "ALL"]);

export function parseCatalogRows(rows: Record<string, unknown>[]): Catalog {
  if (rows.length > MAX_CATALOG_ROWS) throw new CatalogError(`More than ${MAX_CATALOG_ROWS} catalog rows`);
  const catalog: Catalog = { relations: [], policies: [], functions: [], skipped: 0 };
  for (const r of rows) {
    const schema = safeName(r.schema_name);
    const name = safeName(r.object_name);
    if (!schema || !name || !(POSTURE_SCHEMAS as readonly string[]).includes(schema)) {
      catalog.skipped += 1;
      continue;
    }
    if (r.kind === "table" || r.kind === "view") {
      const rlsEnabled = bool(r.rls_enabled);
      const policyCount = count(r.policy_count);
      if (rlsEnabled === null || policyCount === null) {
        catalog.skipped += 1;
        continue;
      }
      catalog.relations.push({
        kind: r.kind, schema, name, rlsEnabled, policyCount,
        rlsForced: bool(r.rls_forced) ?? false,
        securityInvoker: bool(r.security_invoker) ?? false,
        grants: new Set(list(r.grants).filter((g) => /^(anon|authenticated):(SELECT|INSERT|UPDATE|DELETE)$/.test(g))),
        graphqlRoles: r.graphql_roles === null || r.graphql_roles === undefined ? null : apiRoles(r.graphql_roles),
      });
    } else if (r.kind === "function") {
      const args = safeArguments(r.arguments);
      const definer = bool(r.security_definer);
      if (args === null || definer === null) {
        catalog.skipped += 1;
        continue;
      }
      catalog.functions.push({
        schema, name, arguments: args, securityDefiner: definer,
        searchPathSet: bool(r.search_path_set) ?? false,
        executableBy: API_ROLES.filter((role) => list(r.grants).includes(`${role}:EXECUTE`)),
      });

    } else if (r.kind === "policy") {
      const policy = safeName(r.policy_name);
      const cmd = (text(r.cmd) ?? "ALL").toUpperCase().replace("*", "ALL");
      if (!policy || !CMDS.has(cmd)) {
        catalog.skipped += 1;
        continue;
      }
      catalog.policies.push({
        schema, table: name, name: policy,
        permissive: (text(r.permissive) ?? "PERMISSIVE").toUpperCase() !== "RESTRICTIVE",
        roles: list(r.roles),
        cmd: cmd as CatalogPolicy["cmd"],
        qual: text(r.qual),
        withCheck: text(r.with_check),
      });
    } else {
      catalog.skipped += 1;
    }
  }
  return catalog;
}

// `true`, `(true)`, ` ( TRUE ) `: the expression lets every row through.
export function isTrueExpr(expr: string | null): boolean {
  if (expr === null) return false;
  let s = expr.toLowerCase().replace(/\s+/g, "");
  while (s.startsWith("(") && s.endsWith(")")) s = s.slice(1, -1);
  return s === "true";
}

// The Data API roles a policy applies to. `public` (or no list) means every role.
export function policyRoles(roles: string[]): ApiRole[] {
  if (roles.length === 0 || roles.includes("public")) return [...API_ROLES];
  return API_ROLES.filter((r) => roles.includes(r));
}

const COMMANDS: Privilege[] = [...PRIVILEGES];
const covers = (cmd: CatalogPolicy["cmd"], c: Privilege) => cmd === "ALL" || cmd === c;

// Does the policy pass every row for command c? SELECT and DELETE use USING; INSERT uses WITH
// CHECK; UPDATE uses both (USING picks the rows, WITH CHECK the new values). For ALL and UPDATE,
// a missing WITH CHECK falls back to USING, as in Postgres.
function openFor(p: CatalogPolicy, c: Privilege): "using" | "with_check" | null {
  const check = p.withCheck ?? (p.cmd === "ALL" || p.cmd === "UPDATE" ? p.qual : null);
  if (c === "SELECT" || c === "DELETE") return isTrueExpr(p.qual) ? "using" : null;
  if (c === "INSERT") return isTrueExpr(check) ? "with_check" : null;
  if (isTrueExpr(p.qual)) return "using";
  return isTrueExpr(check) ? "with_check" : null;
}

function exposureOf(grants: Set<string>, privileges: Privilege[], roles: readonly ApiRole[] = API_ROLES): Exposure {
  const has = (role: ApiRole) => roles.includes(role) && privileges.some((p) => grants.has(`${role}:${p}`));
  return has("anon") ? "anon" : has("authenticated") ? "authenticated" : "none";
}

const privilegesOf = (grants: Set<string>, role: ApiRole) => COMMANDS.filter((p) => grants.has(`${role}:${p}`));

const RLS_OFF: Record<Exposure, Severity> = { anon: "critical", authenticated: "high", none: "low" };
// A SECURITY DEFINER function runs as its owner, past every RLS policy (issue #135).
const DEFINER: Record<Exclude<Exposure, "none">, Severity> = { anon: "high", authenticated: "medium" };
// pg_graphql introspection shows the object's name, columns and relationships, not its rows.
const GRAPHQL: Record<Exclude<Exposure, "none">, Severity> = { anon: "medium", authenticated: "low" };
const exposureOfRoles = (roles: readonly ApiRole[]): Exposure =>
  roles.includes("anon") ? "anon" : roles.includes("authenticated") ? "authenticated" : "none";
const VIEW: Record<Exposure, Severity> = { anon: "high", authenticated: "medium", none: "low" };

export function catalogFindings(catalog: Catalog): PostureFinding[] {
  const findings: PostureFinding[] = [];
  const tables = new Map(catalog.relations.filter((r) => r.kind === "table").map((r) => [`${r.schema}.${r.name}`, r]));

  for (const r of catalog.relations) {
    const base = { source: "catalog" as const, schema: r.schema, object: r.name, objectType: r.kind };
    if (r.kind === "view") {
      if (r.securityInvoker) continue;
      const exposure = exposureOf(r.grants, ["SELECT"]);
      findings.push({ ...base, check: "view_not_invoker", severity: VIEW[exposure], evidence: { exposure } });
      continue;
    }
    if (!r.rlsEnabled) {
      const exposure = exposureOf(r.grants, COMMANDS);
      findings.push({
        ...base, check: "rls_disabled", severity: RLS_OFF[exposure],
        evidence: {
          exposure,
          anonPrivileges: privilegesOf(r.grants, "anon"),
          authenticatedPrivileges: privilegesOf(r.grants, "authenticated"),
          policyCount: r.policyCount,
        },
      });
    } else if (r.policyCount === 0) {
      // Deny-all for the Data API roles. Not an exposure; FORCE only matters for the table owner.
      findings.push({ ...base, check: "rls_no_policies", severity: "low", evidence: { rlsForced: r.rlsForced } });
    }
  }

  for (const p of catalog.policies) {
    const table = tables.get(`${p.schema}.${p.table}`);
    // Policies on a table with RLS off do nothing: rls_disabled already reports that table.
    if (!p.permissive || !table || !table.rlsEnabled) continue;
    const roles = policyRoles(p.roles);
    if (roles.length === 0) continue;
    const open = COMMANDS.filter((c) => covers(p.cmd, c) && openFor(p, c) !== null).filter((c) =>
      // A restrictive policy on the same command and roles whose expression is not `true` still
      // filters rows, so the command is not open.
      !catalog.policies.some((q) =>
        !q.permissive && q.schema === p.schema && q.table === p.table && covers(q.cmd, c)
        && policyRoles(q.roles).some((x) => roles.includes(x)) && openFor(q, c) === null),
    );
    if (open.length === 0) continue;
    const writes = open.filter((c) => c !== "SELECT");
    const writeExposure = exposureOf(table.grants, writes, roles);
    const readExposure = exposureOf(table.grants, open.includes("SELECT") ? ["SELECT"] : [], roles);
    const severity: Severity = writeExposure === "anon" ? "critical"
      : writeExposure === "authenticated" ? "high"
        : readExposure === "anon" ? "medium" : "low";
    const clauses = new Set(open.map((c) => openFor(p, c)));
    findings.push({
      source: "catalog", check: "permissive_policy", severity, schema: p.schema, object: p.table, objectType: "table",
      evidence: {
        policy: p.name,
        command: p.cmd,
        openCommands: open,
        roles: p.roles.length === 0 || p.roles.includes("public") ? ["public"] : roles,
        exposure: writeExposure !== "none" ? writeExposure : readExposure,
        // Who the policy lets read every row, apart from writes: the anon-read detector's input (#132).
        readExposure,
        clause: clauses.size > 1 ? "both" : [...clauses][0] ?? "using",
      },
    });
  }
  // function_definer_exposed (splinter 0028/0029): a SECURITY DEFINER function the Data API roles
  // can EXECUTE, so PostgREST serves it at /rest/v1/rpc/<name>.
  for (const fn of catalog.functions) {
    const exposure = exposureOfRoles(fn.executableBy);
    if (!fn.securityDefiner || exposure === "none") continue;
    findings.push({
      source: "catalog", check: "function_definer_exposed", severity: DEFINER[exposure],
      schema: fn.schema, object: fn.name, objectType: "function",
      evidence: { exposure, executableBy: fn.executableBy, arguments: fn.arguments, searchPathSet: fn.searchPathSet },
    });
  }

  // graphql_table_exposed (splinter 0026/0027): pg_graphql is installed and an API role can SELECT
  // a column of the table or view, so the GraphQL schema shows it to that role.
  for (const r of catalog.relations) {
    const exposure = exposureOfRoles(r.graphqlRoles ?? []);
    if (exposure === "none") continue;
    findings.push({
      source: "catalog", check: "graphql_table_exposed", severity: GRAPHQL[exposure],
      schema: r.schema, object: r.name, objectType: r.kind, evidence: { exposure, roles: r.graphqlRoles ?? [] },
    });
  }
  return findings;
}

