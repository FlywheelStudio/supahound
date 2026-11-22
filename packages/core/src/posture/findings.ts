import { SEVERITY_RANK, type Finding, type Severity } from "../detectors/finding.js";
import type { PostureFinding } from "./types.js";

// What the stored posture findings mean for the dashboard and the detectors (decision 038).

// Advisor lints that report the same thing as one of Supahound's catalog checks.
export const ADVISOR_EQUIVALENT: Readonly<Record<string, string>> = {
  // splinter 0026 to 0029, which the catalog checks of issue #135 port.
  anon_security_definer_function_executable: "function_definer_exposed",
  authenticated_security_definer_function_executable: "function_definer_exposed",
  pg_graphql_anon_table_exposed: "graphql_table_exposed",
  pg_graphql_authenticated_table_exposed: "graphql_table_exposed",
  rls_disabled_in_public: "rls_disabled",
  policy_exists_rls_disabled: "rls_disabled",
  rls_enabled_no_policy: "rls_no_policies",
  security_definer_view: "view_not_invoker",
  // splinter 0024 (issue #134): a write policy whose USING or WITH CHECK passes every row.
  rls_policy_always_true: "permissive_policy",
};

// The part of an object a finding is about, when one object can have several: a policy on a
// table, or one overload of a function (its identity arguments).
function partOf(f: PostureFinding): string | null {
  const p = f.evidence.policy ?? f.evidence.arguments;
  return typeof p === "string" ? p : null;
}

// Drops an Advisor finding when a catalog finding already reports the same check on the same
// object (and the same policy or overload, when the Advisor names one). The catalog one stays:
// its severity knows the grants. Worst first, then by object.
export function dedupePosture<T extends PostureFinding>(findings: T[]): T[] {
  const catalog = new Set<string>();
  for (const f of findings) {
    if (f.source !== "catalog") continue;
    const key = `${f.check}|${f.schema}|${f.object}`;
    catalog.add(key);
    const part = partOf(f);
    if (part !== null) catalog.add(`${key}|${part}`);
  }
  const repeats = (f: T) => {
    const key = `${ADVISOR_EQUIVALENT[f.check] ?? "-"}|${f.schema}|${f.object}`;
    const part = partOf(f);
    return catalog.has(part === null ? key : `${key}|${part}`);
  };
  return findings
    .filter((f) => f.source !== "advisor" || !repeats(f))
    .sort((a, b) => SEVERITY_RANK[b.severity] - SEVERITY_RANK[a.severity]
      || `${a.schema}.${a.object}.${a.check}`.localeCompare(`${b.schema}.${b.object}.${b.check}`));
}

export type SeverityCounts = Record<Severity, number>;

export function countBySeverity(findings: PostureFinding[]): SeverityCounts {
  const counts: SeverityCounts = { critical: 0, high: 0, medium: 0, low: 0 };
  for (const f of dedupePosture(findings)) counts[f.severity] += 1;
  return counts;
}

// Tables in `public` (the schema the Data API serves and detectors name) with a posture finding
// at high or above: RLS off for an API role, or a policy that opens writes. table → check.
export function exposedTables(findings: PostureFinding[]): Map<string, string> {
  const out = new Map<string, string>();
  for (const f of dedupePosture(findings)) {
    if (f.schema !== "public" || f.object === null || f.objectType !== "table") continue;
    if (SEVERITY_RANK[f.severity] < SEVERITY_RANK.high || out.has(f.object)) continue;
    out.set(f.object, f.check);
  }
  return out;
}

// SECURITY DEFINER functions anon can execute (issue #131). Supahound's catalog check
// (`function_definer_exposed`, #135) and the Advisor's lint report them; either may be absent.
export const DEFINER_EXPOSED_CHECKS: ReadonlySet<string> = new Set([
  "function_definer_exposed",
  "anon_security_definer_function_executable",
]);

export interface DefinerExposure {
  check: string;
  severity: Severity;
}

export interface AnonReadable {
  check: string;
  severity: Severity;
}

// Functions in `public` (the schema PostgREST serves under /rpc) that posture shows as SECURITY
// DEFINER and executable by anon: function → the worst such finding's check and severity. A catalog
// finding whose stored exposure names another role (authenticated only) is left out.
export function anonDefinerFunctions(findings: PostureFinding[]): Map<string, DefinerExposure> {
  const out = new Map<string, DefinerExposure>();
  // dedupePosture sorts worst first, so the first finding kept per function is the worst.
  for (const f of dedupePosture(findings)) {
    if (f.schema !== "public" || f.object === null || !DEFINER_EXPOSED_CHECKS.has(f.check)) continue;
    if (typeof f.evidence.exposure === "string" && f.evidence.exposure !== "anon") continue;
    if (!out.has(f.object)) out.set(f.object, { check: f.check, severity: f.severity });
  }
  return out;
}

const listOf = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : []);

// SECURITY DEFINER functions in `public` that signed-in users can execute (issue #157, decision 6
// of #131): the catalog check when its stored executableBy (or exposure) names authenticated, or
// the Advisor's authenticated lint. function → the worst such finding's check and severity.
export function authenticatedDefinerFunctions(findings: PostureFinding[]): Map<string, DefinerExposure> {
  const out = new Map<string, DefinerExposure>();
  for (const f of dedupePosture(findings)) {
    if (f.schema !== "public" || f.object === null || out.has(f.object)) continue;
    const catalog = f.source === "catalog" && f.check === "function_definer_exposed"
      && (listOf(f.evidence.executableBy).includes("authenticated") || f.evidence.exposure === "authenticated");
    const advisor = f.source === "advisor" && f.check === "authenticated_security_definer_function_executable";
    if (catalog || advisor) out.set(f.object, { check: f.check, severity: f.severity });
  }
  return out;
}

// The Advisor lint for a public bucket whose policies let anyone list its files (splinter 0025).
export const LISTABLE_BUCKET_CHECK = "public_bucket_allows_listing";

// Buckets the stored posture shows listable by anyone (issue #157). The lint names the bucket as
// the object, in schema `storage`.
export function listableBuckets(findings: PostureFinding[]): Set<string> {
  const out = new Set<string>();
  for (const f of findings) {
    if (f.check === LISTABLE_BUCKET_CHECK && f.schema === "storage" && f.object !== null) out.add(f.object);
  }
  return out;
}

// GraphQL posture gating (issue #157, decision 038 addendum). pg_graphql shows a table's shape to
// every role that can SELECT it, so a default project has one finding per table. They are shown,
// counted and allowed to raise severity only for a role whose GraphQL calls the project's recent
// polls counted; otherwise they are kept but hidden, with a note.
export const GRAPHQL_ACTIVITY_DAYS = 7;

export interface GraphqlActivity {
  anon: boolean;
  authenticated: boolean;
}

export const NO_GRAPHQL_ACTIVITY: GraphqlActivity = { anon: false, authenticated: false };

// The API roles a GraphQL finding is about; null for any other check.
export function graphqlFindingRoles(f: PostureFinding): ("anon" | "authenticated")[] | null {
  if (f.check === "pg_graphql_anon_table_exposed") return ["anon"];
  if (f.check === "pg_graphql_authenticated_table_exposed") return ["authenticated"];
  if (f.check !== "graphql_table_exposed") return null;
  const roles = listOf(f.evidence.roles).filter((r): r is "anon" | "authenticated" => r === "anon" || r === "authenticated");
  if (roles.length > 0) return roles;
  return f.evidence.exposure === "authenticated" ? ["authenticated"] : ["anon"];
}

// Splits findings into those to show and the GraphQL ones hidden for lack of GraphQL traffic.
// Order is kept.
export function gateGraphql<T extends PostureFinding>(findings: T[], activity: GraphqlActivity): { shown: T[]; hidden: T[] } {
  const shown: T[] = [];
  const hidden: T[] = [];
  for (const f of findings) {
    const roles = graphqlFindingRoles(f);
    (roles === null || roles.some((r) => activity[r]) ? shown : hidden).push(f);
  }
  return { shown, hidden };
}

// Does this finding say the anon key can read every row of the table? Only what posture stores:
// rls_disabled with an anon SELECT grant; permissive_policy whose read exposure is anon (rows
// saved before readExposure existed: SELECT open to anon or public and the stored exposure is
// anon); the Advisor's rls_disabled_in_public when the catalog did not report the table (dedupe
// drops it when it did: the catalog knows the grants).
function anonCanRead(f: PostureFinding): boolean {
  const e = f.evidence;
  if (f.source === "catalog" && f.check === "rls_disabled") return listOf(e.anonPrivileges).includes("SELECT");
  if (f.source === "catalog" && f.check === "permissive_policy") {
    if (!listOf(e.openCommands).includes("SELECT")) return false;
    if (typeof e.readExposure === "string") return e.readExposure === "anon";
    const roles = listOf(e.roles);
    return e.exposure === "anon" && (roles.includes("anon") || roles.includes("public"));
  }
  return f.source === "advisor" && f.check === "rls_disabled_in_public";
}

// Tables in `public` whose every row the anon key can read, by the stored posture findings
// (issue #132): table → the worst such finding's check and severity. The poller watches anon
// reads of exactly these tables.
export function anonReadableTables(findings: PostureFinding[]): Map<string, AnonReadable> {
  const out = new Map<string, AnonReadable>();
  // dedupePosture sorts worst first, so the first finding kept per table is the worst.
  for (const f of dedupePosture(findings)) {
    if (f.schema !== "public" || f.object === null || f.objectType !== "table" || !anonCanRead(f)) continue;
    if (!out.has(f.object)) out.set(f.object, { check: f.check, severity: f.severity });
  }
  return out;
}

const RAISED: Record<Severity, Severity> = { low: "medium", medium: "high", high: "critical", critical: "critical" };
export const POSTURE_SIGNAL = "posture_exposed";

// A cross-tenant detection on a table that posture shows exposed is one step worse: the request
// most likely did read or change other users' rows. Service-role findings are not raised: the
// service key bypasses RLS, so the table's posture changes nothing about them.
export function raiseForPosture(findings: Finding[], exposed: Map<string, string>): Finding[] {
  if (exposed.size === 0) return findings;
  return findings.map((f) => {
    const table = typeof f.evidence.table === "string" ? f.evidence.table : null;
    const check = table ? exposed.get(table) : undefined;
    if (f.detector !== "cross_tenant" || !check) return f;
    return {
      ...f,
      severity: RAISED[f.severity],
      signals: f.signals.includes(POSTURE_SIGNAL) ? f.signals : [...f.signals, POSTURE_SIGNAL],
      evidence: { ...f.evidence, postureCheck: check },
    };
  });
}
